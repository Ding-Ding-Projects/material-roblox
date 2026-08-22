'use strict';

/**
 * All outbound HTTP for the app happens here, in the main process.
 *
 * Channels:
 *   net:get       { url, headers?, timeoutMs?, maxBytes? }
 *                 -> { status, headers, bytes, json? | text? }
 *   net:post      { url, headers?, body?, json?, timeoutMs?, maxBytes? }
 *                 -> { status, headers, bytes, json? | text? }
 *   roblox:fetch  { url|path, method?, body?, json?, auth? }
 *                 -> { status, headers, bytes, json? | text? }
 *
 * Security posture:
 *   - Every hop of every request is re-validated against a strict host
 *     allowlist; redirects cannot walk off it.
 *   - Responses are streamed with a hard byte cap; exceeding it aborts.
 *   - The Roblox session cookie is injected from the encrypted vault only
 *     when auth:true is requested, and its value is NEVER returned to the
 *     renderer, included in an error, or logged.
 */

const { ipcMain, net } = require('electron');
const { readSecret } = require('./vault.js');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_MAX_BYTES = 5242880;
const HARD_MAX_BYTES = 33554432;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const MAX_HEADER_ENTRIES = 32;
const MAX_HEADER_LENGTH = 4096;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWLIST_MESSAGE = 'Destination not on the allowlist.';
const OLLAMA_PORT = '11434';

function assertPlainObject(value, label) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected an object payload for ' + label + '.');
  }
}

function boundedTimeoutMs(payload) {
  const raw = Number(payload && payload.timeoutMs);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(raw), MAX_TIMEOUT_MS);
}

function boundedMaxBytes(payload) {
  const raw = Number(payload && payload.maxBytes);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(Math.round(raw), HARD_MAX_BYTES);
}

/** Validate caller-supplied headers into a plain lowercase-keyed map. */
function normalizeHeaders(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('headers must be an object.');
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_HEADER_ENTRIES) {
    throw new TypeError('Too many request headers.');
  }
  const out = {};
  for (const [nameRaw, valueRaw] of entries) {
    const name = String(nameRaw).trim().toLowerCase();
    const value = String(valueRaw);
    if (!name || name.length > MAX_HEADER_LENGTH || value.length > MAX_HEADER_LENGTH) {
      throw new TypeError('Request header name or value is too long.');
    }
    out[name] = value;
  }
  return out;
}

/**
 * The single place a destination is judged. Returns the parsed URL or throws
 * ALLOWLIST_MESSAGE. Loopback is allowed ONLY on the local model runtime
 * port; everything else must be https on an explicitly trusted host.
 */
function allowHost(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(ALLOWLIST_MESSAGE);
  }

  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const pathname = url.pathname;

  // URL.hostname strips brackets from IPv6 literals, so compare "::1" bare.
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (isLoopback) {
    if (port !== OLLAMA_PORT) throw new Error(ALLOWLIST_MESSAGE);
    return url;
  }

  if (url.protocol !== 'https:') throw new Error(ALLOWLIST_MESSAGE);

  if (host === 'roblox.com' || host.endsWith('.roblox.com')) return url;
  if (host === 'rbxcdn.com' || host.endsWith('.rbxcdn.com')) return url;

  if (host === 'raw.githubusercontent.com' && pathname.startsWith('/Ding-Ding-Projects/')) {
    return url;
  }
  if (
    host === 'api.github.com' &&
    pathname.startsWith('/repos/Ding-Ding-Projects/material-roblox')
  ) {
    return url;
  }
  if (host === 'objects.githubusercontent.com') return url;
  if (
    host === 'github.com' &&
    pathname.startsWith('/Ding-Ding-Projects/material-roblox/releases/download/')
  ) {
    return url;
  }

  throw new Error(ALLOWLIST_MESSAGE);
}

function headerValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

/** One HTTP round trip against Electron's net stack, byte-capped. */
function performRequest(urlString, options) {
  const { method, headers, body, timeoutMs, maxBytes, signal } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const request = net.request({ method, url: urlString });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      try {
        request.abort();
      } catch {
        /* already finished */
      }
      finish(reject, new Error('The request was cancelled.'));
    };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }

    timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        /* nothing to abort */
      }
      finish(reject, new Error('The request timed out.'));
    }, timeoutMs);

    for (const [name, value] of Object.entries(headers)) {
      try {
        request.setHeader(name, value);
      } catch {
        /* skip headers the network stack refuses; never fatal */
      }
    }

    request.on('response', (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          try {
            request.abort();
          } catch {
            /* already aborted */
          }
          finish(
            reject,
            new Error('The response exceeded the size limit of ' + maxBytes + ' bytes.')
          );
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        const normalizedHeaders = {};
        for (const [name, value] of Object.entries(response.headers || {})) {
          normalizedHeaders[String(name).toLowerCase()] = Array.isArray(value)
            ? value.join(', ')
            : String(value === undefined ? '' : value);
        }
        finish(resolve, {
          status: response.statusCode || 0,
          headers: normalizedHeaders,
          body: Buffer.concat(chunks),
        });
      });
      response.on('error', (err) => finish(reject, err instanceof Error ? err : new Error(String(err))));
    });

    request.on('error', (err) =>
      finish(reject, err instanceof Error ? err : new Error(String(err)))
    );

    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      request.write(body);
    }
    request.end();
  });
}

/** Shape a completed response into the renderer-facing result object. */
function finalizeResponse(response, expectJson) {
  const result = {
    status: response.status,
    headers: response.headers,
    bytes: response.body ? response.body.length : 0,
  };
  const contentType = headerValue(response.headers, 'content-type').toLowerCase();
  const text = response.body ? response.body.toString('utf8') : '';
  const wantsJson =
    expectJson === true || (expectJson !== false && contentType.includes('json'));
  if (wantsJson && text) {
    try {
      result.json = JSON.parse(text);
    } catch {
      // Honest partial: hand back the text plus a flag instead of throwing,
      // so callers can decide what a malformed body means for them.
      result.text = text.slice(0, HARD_MAX_BYTES / 4);
      result.jsonParseError = true;
    }
  } else {
    result.text = text.slice(0, HARD_MAX_BYTES / 4);
  }
  return result;
}

/**
 * Run a request following at most MAX_REDIRECTS hops, re-validating every
 * hop through allowHost before it is contacted.
 */
async function runRequest(startUrl, requestOptions) {
  let currentUrl = allowHost(startUrl).href;
  let method = requestOptions.method;
  let headers = requestOptions.headers;
  let body = requestOptions.body;
  let lastExpectJson = requestOptions.expectJson;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const response = await performRequest(currentUrl, {
      method,
      headers,
      body,
      timeoutMs: requestOptions.timeoutMs,
      maxBytes: requestOptions.maxBytes,
      signal: controller.signal,
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = headerValue(response.headers, 'location');
      if (!location) return finalizeResponse(response, lastExpectJson);
      const next = new URL(location, currentUrl);
      allowHost(next.href); // throws when a redirect tries to leave the list
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(
          Object.entries(headers).filter(([name]) => !name.startsWith('content-'))
        );
      }
      currentUrl = next.href;
      continue;
    }

    return finalizeResponse(response, lastExpectJson);
  }
  throw new Error('Too many redirects.');
}

function prepareBody(payload) {
  let body;
  let headers = normalizeHeaders(payload.headers);
  if (payload.body !== undefined && payload.body !== null) {
    if (payload.json === true && typeof payload.body === 'object' && !Buffer.isBuffer(payload.body)) {
      body = JSON.stringify(payload.body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    } else if (typeof payload.body === 'string') {
      body = payload.body;
    } else {
      throw new TypeError('body must be a string, or an object together with json:true.');
    }
    if (body.length > MAX_BODY_BYTES) {
      throw new Error('The request body exceeds the size limit of ' + MAX_BODY_BYTES + ' bytes.');
    }
  }
  return { body, headers };
}

exports.register = function register({ ipcMain }) {
  ipcMain.handle('net:get', (_event, payload) => {
    assertPlainObject(payload, 'net:get');
    if (typeof payload.url !== 'string' || !payload.url) {
      throw new TypeError('url is required.');
    }
    return runRequest(payload.url, {
      method: 'GET',
      headers: normalizeHeaders(payload.headers),
      body: undefined,
      timeoutMs: boundedTimeoutMs(payload),
      maxBytes: boundedMaxBytes(payload),
      expectJson: undefined,
    });
  });

  ipcMain.handle('net:post', (_event, payload) => {
    assertPlainObject(payload, 'net:post');
    if (typeof payload.url !== 'string' || !payload.url) {
      throw new TypeError('url is required.');
    }
    const prepared = prepareBody(payload);
    return runRequest(payload.url, {
      method: 'POST',
      headers: prepared.headers,
      body: prepared.body,
      timeoutMs: boundedTimeoutMs(payload),
      maxBytes: boundedMaxBytes(payload),
      expectJson: undefined,
    });
  });

  ipcMain.handle('roblox:fetch', async (_event, payload) => {
    assertPlainObject(payload, 'roblox:fetch');
    const raw = typeof payload.url === 'string' && payload.url ? payload.url : payload.path;
    if (typeof raw !== 'string' || !/^https:\/\//i.test(raw)) {
      throw new Error('roblox:fetch needs an absolute https URL.');
    }

    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('Invalid URL.');
    }
    const host = parsed.hostname.toLowerCase();
    const isRobloxHost =
      host === 'roblox.com' ||
      host.endsWith('.roblox.com') ||
      host === 'rbxcdn.com' ||
      host.endsWith('.rbxcdn.com');
    if (!isRobloxHost) {
      throw new Error('Only roblox.com and rbxcdn.com hosts are allowed here.');
    }

    const headers = normalizeHeaders(payload.headers);
    let body;
    if (payload.body !== undefined && payload.body !== null) {
      if (typeof payload.body === 'string') {
        body = payload.body;
      } else {
        body = JSON.stringify(payload.body);
        if (!headers['content-type']) headers['content-type'] = 'application/json';
      }
      if (body.length > MAX_BODY_BYTES) {
        throw new Error('The request body exceeds the size limit.');
      }
    }

    if (payload.auth === true) {
      const cookieValue = await readSecret('roblox', 'sessionCookie');
      if (!cookieValue) {
        throw new Error('No saved Roblox session. Open the Session tab to connect one.');
      }
      // The cookie value stays inside this process boundary. It is never put
      // into an error message, a returned object, or a log line.
      headers['cookie'] = '.ROBLOSECURITY=' + cookieValue;
    }

    const result = await runRequest(parsed.href, {
      method: typeof payload.method === 'string' ? payload.method.toUpperCase() : 'GET',
      headers,
      body,
      timeoutMs: boundedTimeoutMs(payload),
      maxBytes: boundedMaxBytes(payload),
      expectJson: payload.json === false ? false : true,
    });

    if (payload.json === false) {
      return { status: result.status, headers: result.headers, bytes: result.bytes, text: result.text };
    }
    return result;
  });
};
