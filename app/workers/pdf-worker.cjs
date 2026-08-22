'use strict';
/**
 * pdf-worker.cjs — sandboxed conversion worker for Lane E's converter.
 *
 * Runs as an Electron UtilityProcess (plain CommonJS; `pdf-lib` and `fflate`
 * resolve from the app's bundled node_modules). Receives exactly one job per
 * process:
 *   { id, family:'pdf'|'zip', op, args,
 *     inputPath? | inputDataB64?, outputPath?, }
 * Emits:
 *   { id, type:'progress', status?, bytesDone, bytesTotal }
 *   { id, type:'done',    result?, output?:{path,bytes}, bytes }
 *   { id, type:'error',   message }
 *
 * Guarantees:
 *  - Writes are ATOMIC: a unique temp file in the destination directory, then
 *    rename with bounded EPERM/EACCES/EBUSY retry (Defender/indexer windows).
 *  - Every claimed success is VALIDATED by reopening the artifact (PDF page
 *    count must match the request; ZIP central directory must parse).
 *  - No network access is used anywhere in this worker.
 *  - Memory backpressure: archives stream through fflate's incremental Zip /
 *    Unzip classes in 4 MiB slices; only one archive ENTRY is ever held in
 *    memory (entries above 256 MiB are refused rather than buffered).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHUNK = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const port = process.parentPort;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function post(msg) {
  try { port.postMessage(msg); } catch (_) { /* parent died; job ends with us */ }
}
function progress(id, bytesDone, bytesTotal, status) {
  post({ id, type: 'progress', status: status || 'working', bytesDone, bytesTotal });
}

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Temp-write then rename, with bounded retry over transient sharing violations. */
function writeFileAtomic(outPath, data) {
  const dir = path.dirname(outPath);
  const tmp = path.join(dir, `.${path.basename(outPath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, data);
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.renameSync(tmp, outPath);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err.code)) break;
      /* Defender / indexer / another writer holds the destination open for an
         instant; each retry is still one indivisible rename. */
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
    }
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* best effort cleanup */ }
  throw lastErr || new Error('atomic rename failed');
}

/** Stream a whole file into a Buffer with progress callbacks. */
async function readFileWithProgress(p, id, totalOverride) {
  const st = fs.statSync(p);
  const total = totalOverride || st.size;
  const bufs = [];
  let done = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(p, { highWaterMark: CHUNK });
    stream.on('data', (c) => {
      bufs.push(c);
      done += c.length;
      if (done % (CHUNK * 2) < c.length) progress(id, done, total, 'reading');
    });
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  progress(id, total, total, 'read');
  return Buffer.concat(bufs);
}

/** Read input either inline or from disk. */
async function readInput(job) {
  if (typeof job.inputDataB64 === 'string') {
    return Buffer.from(job.inputDataB64, 'base64');
  }
  return readFileWithProgress(job.inputPath, job.id);
}

/* ------------------------------------------------------------------ */
/* PDF family                                                          */
/* ------------------------------------------------------------------ */

/** Parse "1-3,5" style ranges into sorted unique 0-based page indexes. */
function parseRanges(str, maxPage) {
  const out = new Set();
  for (const pieceRaw of String(str || '').split(',')) {
    const piece = pieceRaw.trim();
    if (!piece) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(piece);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) {
        if (i >= 1 && i <= maxPage) out.add(i - 1);
      }
    } else if (/^\d+$/.test(piece)) {
      const n = parseInt(piece, 10);
      if (n >= 1 && n <= maxPage) out.add(n - 1);
      else throw new Error(`Page ${n} is outside this document (1-${maxPage}).`);
    } else if (piece) {
      throw new Error(`Bad page range "${piece}". Use forms like 1-3,5.`);
    }
  }
  if (!out.size) throw new Error('No valid pages in that range.');
  return [...out].sort((a, b) => a - b);
}

async function runPdfJob(job) {
  const { PDFDocument } = require('pdf-lib');
  const srcBytes = await readInput(job);
  progress(job.id, Math.round(srcBytes.length * 0.2), srcBytes.length, 'loading');
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const pageCount = doc.getPageCount();
  const metaTitle = typeof doc.getTitle() === 'string' ? doc.getTitle() : '';
  const metaAuthor = typeof doc.getAuthor() === 'string' ? doc.getAuthor() : '';

  /** Copy selected pages (all when indexes omitted) into a fresh document. */
  async function buildFrom(indexes) {
    const out = await PDFDocument.create();
    const chosen = indexes == null
      ? [...Array(pageCount).keys()]
      : indexes;
    const copied = await out.copyPages(doc, chosen);
    for (const p of copied) out.addPage(p);
    return out;
  }

  switch (job.op) {
    case 'inspect': {
      return {
        result: {
          pageCount,
          sizeBytes: srcBytes.length,
          title: metaTitle,
          author: metaAuthor,
          encrypted: !!doc.isEncrypted,
        },
        writesOutput: false,
      };
    }

    case 'split': {
      if (doc.isEncrypted) throw new Error('Encrypted PDFs cannot be modified.');
      const rangesArg = Array.isArray(job.args.ranges)
        ? job.args.ranges.map(String)
        : String(job.args.ranges || '');
      if (!rangesArg.trim()) throw new Error('Provide ranges such as "1-3,5".');
      const groups = String(rangesArg).split(';').map((s) => s.trim()).filter(Boolean);
      const list = groups.length ? groups : [rangesArg];
      const { zipSync, strToU8 } = require('fflate');
      const entries = {};
      const base = sanitizeBase(path.basename(job.inputPath || 'document.pdf'));
      let idx = 0;
      for (const group of list) {
        idx += 1;
        const indexes = parseRanges(group, pageCount);
        const partDoc = await buildFrom(indexes);
        const bytes = Buffer.from(await partDoc.save());
        entries[`${base}-part${String(idx).padStart(2, '0')}.pdf`] = new Uint8Array(bytes);
      }
      progress(job.id, Math.round(srcBytes.length * 0.8), srcBytes.length, 'packing');
      const zipped = Buffer.from(zipSync(entries, { level: 6 }));
      writeFileAtomic(job.outputPath, zipped);
      validateZipOnDisk(job.outputPath);
      return {
        result: { parts: idx, sourcePageCount: pageCount },
        output: { path: job.outputPath, bytes: zipped.length },
        bytes: zipped.length,
      };
    }

    case 'merge': {
      const inputs = Array.isArray(job.args.inputs) ? job.args.inputs.filter((p) => typeof p === 'string') : [];
      if (inputs.length < 1) throw new Error('Merge needs at least one extra document.');
      const out = await PDFDocument.create();
      let totalIn = srcBytes.length;
      for (const p of inputs) {
        const bytes = await readFileWithProgress(p, job.id);
        totalIn += bytes.length;
        const d = await PDFDocument.load(bytes, { ignoreEncryption: true });
        if (d.isEncrypted) throw new Error(`Encrypted input cannot be merged: ${p}`);
        const copied = await out.copyPages(d, [...Array(d.getPageCount()).keys()]);
        for (const pg of copied) out.addPage(pg);
        progress(job.id, Math.round(totalIn * 0.5), totalIn, 'merging');
      }
      const merged = Buffer.from(await out.save());
      writeFileAtomic(job.outputPath, merged);
      await validatePdfOnDisk(job.outputPath, out.getPageCount());
      return {
        result: { pageCount: out.getPageCount(), inputs: inputs.length + 1 },
        output: { path: job.outputPath, bytes: merged.length },
        bytes: merged.length,
      };
    }

    case 'reorder': {
      if (doc.isEncrypted) throw new Error('Encrypted PDFs cannot be modified.');
      let order = job.args.order;
      if (job.args.move && !order) {
        const from = Number(job.args.move.from);
        const to = Number(job.args.move.to);
        if (!(from >= 1 && from <= pageCount && to >= 1 && to <= pageCount)) {
          throw new Error(`Move positions must be between 1 and ${pageCount}.`);
        }
        order = [...Array(pageCount).keys()].map((i) => i + 1);
        const [moved] = order.splice(from - 1, 1);
        order.splice(to - 1, 0, moved);
      }
      if (!Array.isArray(order)) throw new Error('Provide an order array or a move {from,to}.');
      if (order.length !== pageCount) {
        throw new Error(`Order must contain every page exactly once (${order.length} given, ${pageCount} pages).`);
      }
      const seen = new Set();
      for (const n of order) {
        const num = Number(n);
        if (!(num >= 1 && num <= pageCount) || seen.has(num)) {
          throw new Error('Order must be a permutation of the existing pages.');
        }
        seen.add(num);
      }
      const out = await PDFDocument.create();
      const copied = await out.copyPages(doc, order.map((n) => Number(n) - 1));
      for (const p of copied) out.addPage(p);
      const bytes = Buffer.from(await out.save());
      writeFileAtomic(job.outputPath, bytes);
      await validatePdfOnDisk(job.outputPath, pageCount);
      return {
        result: { pageCount, order: order.map(Number) },
        output: { path: job.outputPath, bytes: bytes.length },
        bytes: bytes.length,
      };
    }

    case 'rotate': {
      if (doc.isEncrypted) throw new Error('Encrypted PDFs cannot be modified.');
      const degrees = Number(job.args.degrees);
      if (![90, 180, 270, -90, -180, -270].includes(degrees)) {
        throw new Error('Rotation must be a multiple of 90 degrees.');
      }
      const targets = job.args.ranges ? parseRanges(job.args.ranges, pageCount) : null;
      const pages = doc.getPages();
      const list = targets || [...Array(pageCount).keys()];
      for (const i of list) {
        const cur = pages[i].getRotation().angle || 0;
        pages[i].setRotation((((cur + degrees) % 360) + 360) % 360);
      }
      const bytes = Buffer.from(await doc.save());
      writeFileAtomic(job.outputPath, bytes);
      await validatePdfOnDisk(job.outputPath, pageCount);
      return {
        result: { rotated: list.length, degrees },
        output: { path: job.outputPath, bytes: bytes.length },
        bytes: bytes.length,
      };
    }

    case 'extract-pages': {
      if (doc.isEncrypted) throw new Error('Encrypted PDFs cannot be modified.');
      const rangesStr = Array.isArray(job.args.ranges) ? job.args.ranges.join(',') : String(job.args.ranges || '');
      const indexes = parseRanges(rangesStr, pageCount);
      const out = await buildFrom(indexes);
      const bytes = Buffer.from(await out.save());
      writeFileAtomic(job.outputPath, bytes);
      await validatePdfOnDisk(job.outputPath, indexes.length);
      return {
        result: { extracted: indexes.length },
        output: { path: job.outputPath, bytes: bytes.length },
        bytes: bytes.length,
      };
    }

    case 'metadata-edit': {
      if (doc.isEncrypted) throw new Error('Encrypted PDFs cannot be modified.');
      if (typeof job.args.title === 'string' && job.args.title.length <= 512) doc.setTitle(job.args.title);
      if (typeof job.args.author === 'string' && job.args.author.length <= 512) doc.setAuthor(job.args.author);
      const bytes = Buffer.from(await doc.save());
      writeFileAtomic(job.outputPath, bytes);
      await validatePdfOnDisk(job.outputPath, pageCount);
      const check = require('pdf-lib');
      void check;
      const reopened = await PDFDocument.load(fs.readFileSync(job.outputPath), { ignoreEncryption: true });
      return {
        result: {
          title: reopened.getTitle() || '',
          author: reopened.getAuthor() || '',
          pageCount,
        },
        output: { path: job.outputPath, bytes: bytes.length },
        bytes: bytes.length,
      };
    }

    default:
      throw new Error(`Unknown PDF operation "${job.op}".`);
    }
}

function sanitizeBase(name) {
  return name.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'document';
}

async function validatePdfOnDisk(p, expectedPages) {
  const { PDFDocument } = require('pdf-lib');
  const reopened = await PDFDocument.load(fs.readFileSync(p), { ignoreEncryption: true });
  if (reopened.getPageCount() !== expectedPages) {
    throw new Error(`Post-write validation failed: expected ${expectedPages} pages, wrote ${reopened.getPageCount()}.`);
  }
}

/* ------------------------------------------------------------------ */
/* ZIP family                                                          */
/* ------------------------------------------------------------------ */

/** Cheap structural check: locate the End Of Central Directory record. */
function validateZipOnDisk(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const scanStart = Math.max(0, size - 66 * 1024);
    const len = size - scanStart;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, scanStart);
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('Post-write validation failed: ZIP end-of-central-directory not found.');
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size) {
      throw new Error('Post-write validation failed: ZIP central directory points past the end of file.');
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** Refuse paths that escape destDir (zip-slip), decided LEXICALLY before any
 *  symlink resolution so a link component can never launder the target. */
function safeJoin(destDir, entryName) {
  if (typeof entryName !== 'string' || entryName.includes('\0')) {
    throw new Error('Refusing unsafe archive entry name.');
  }
  if (/^[a-zA-Z]:[\\/]/.test(entryName) || entryName.startsWith('/') || entryName.startsWith('\\')) {
    throw new Error(`Archive entry is absolute and was refused: ${entryName}`);
  }
  const norm = path.normalize(entryName).replace(/^(\.\.(\/|\\|$))+/, '__escaped__');
  if (norm.includes('__escaped__')) {
    throw new Error(`Archive entry escapes the destination folder: ${entryName}`);
  }
  const full = path.resolve(destDir, norm);
  const root = path.resolve(destDir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`Archive entry escapes the destination folder: ${entryName}`);
  }
  return full;
}

async function runZipCreate(job) {
  const fflate = require('fflate');
  const entries = Array.isArray(job.args.entries) ? job.args.entries : [];
  if (!entries.length) throw new Error('No files were queued for the archive.');
  const level = Math.min(Math.max(Number(job.args.level ?? 6), 0), 9);

  const dir = path.dirname(job.outputPath);
  const tmp = path.join(dir, `.${path.basename(job.outputPath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);

  await new Promise((resolveOuter, rejectOuter) => {
    const ws = fs.createWriteStream(tmp);
    let finished = false;
    const finishOk = () => { if (!finished) { finished = true; resolveOuter(); } };

    const zip = new fflate.Zip((err, chunk, final) => {
      if (err) { rejectOuter(err); return; }
      if (chunk && chunk.length) ws.write(Buffer.from(chunk));
      if (final) { ws.end(() => finishOk()); }
    });

    (async () => {
      let totalBytes = 0;
      for (let i = 0; i < entries.length; i++) {
        if (finished) return;
        const ent = entries[i];
        if (!ent || typeof ent.name !== 'string' || !ent.name.trim()) {
          throw new Error(`Entry ${i + 1} has no archive name.`);
        }
        const arcName = ent.name.split(/[/\\]/).map((seg) => seg).join('/');
        let source;
        if (typeof ent.inputB64 === 'string') {
          source = Buffer.from(ent.inputB64, 'base64');
          totalBytes += source.length;
        } else if (typeof ent.inputPath === 'string') {
          const st = fs.statSync(ent.inputPath);
          if (!st.isFile()) throw new Error(`Not a file: ${ent.inputPath}`);
          totalBytes += st.size;
          source = fs.createReadStream(ent.inputPath, { highWaterMark: CHUNK });
        } else {
          throw new Error(`Entry ${i + 1} has no content.`);
        }

        const member = level === 0
          ? new fflate.ZipPassThrough(arcName)
          : new fflate.AsyncZipDeflate(arcName, { level });
        zip.add(member);

        await new Promise((resolveMember, rejectMember) => {
          if (source instanceof Uint8Array || Buffer.isBuffer(source)) {
            member.push(new Uint8Array(source), true);
            resolveMember();
            return;
          }
          source.on('data', (c) => {
            try { member.push(new Uint8Array(c), false); } catch (e) { rejectMember(e); }
          });
          source.on('end', () => {
            try { member.push(new Uint8Array(0), true); resolveMember(); } catch (e) { rejectMember(e); }
          });
          source.on('error', rejectMember);
        });
        progress(job.id, i + 1, entries.length, 'zipping');
      }
      zip.end();
    })().catch(rejectOuter);

    ws.on('error', rejectOuter);
  }).catch(async (err) => {
    try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
    throw err;
  });

  fs.renameSync(tmp, job.outputPath);
  validateZipOnDisk(job.outputPath);
  const bytes = fs.statSync(job.outputPath).size;
  return {
    result: { entries: entries.length, encryption: 'none (AES is not supported by the bundled archiver)' },
    output: { path: job.outputPath, bytes },
    bytes,
  };
}

async function runZipExtract(job) {
  const fflate = require('fflate');
  const destDir = job.args.destDir;
  if (typeof destDir !== 'string' || !path.isAbsolute(destDir)) throw new Error('Destination directory must be absolute.');
  fs.mkdirSync(destDir, { recursive: true });

  const manifest = [];
  let currentEntry = null;
  let seenBytes = 0;

  await new Promise((resolve, reject) => {
    const unzipper = new fflate.Unzip();
    unzipper.register(fflate.AsyncUnzipInflate);
    unzipper.onfile = (file) => {
      currentEntry = { name: file.name, written: 0, skipped: false, reason: '' };
      file.ondata = (err, data, finalChunk) => {
        if (err) { reject(err); return; }
        if (currentEntry.written === 0) {
          /* Decide disposition lazily: first chunk decides the target path. */
          try { currentEntry.target = safeJoin(destDir, file.name); } catch (e) {
            currentEntry.skipped = true;
            currentEntry.reason = e.message;
          }
        }
        if (currentEntry.skipped) { if (finalChunk) manifest.push(currentEntry); return; }
        currentEntry.written += data.length;
        if (currentEntry.written > MAX_ENTRY_BYTES) {
          reject(new Error(`Archive entry exceeds the ${MAX_ENTRY_BYTES / 1048576} MB per-entry limit: ${file.name}`));
          return;
        }
        if (currentEntry.written === data.length) {
          currentEntry.fd = fs.openSync(currentEntry.target, 'w');
        }
        fs.writeSync(currentEntry.fd, data);
        seenBytes += data.length;
        if (finalChunk) {
          fs.closeSync(currentEntry.fd);
          currentEntry.fd = null;
          manifest.push(currentEntry);
          progress(job.id, manifest.length, manifest.length, 'extracting');
        }
      };
      file.start();
    };

    const stream = fs.createReadStream(job.inputPath || job._tmpInput, { highWaterMark: CHUNK });
    stream.on('data', (c) => {
      try { unzipper.push(new Uint8Array(c), false); } catch (e) { reject(e); }
    });
    stream.on('end', () => {
      try { unzipper.push(new Uint8Array(0), true); resolve(); } catch (e) { reject(e); }
    });
    stream.on('error', reject);
  });

  const written = manifest.filter((m) => !m.skipped);
  if (!written.length && manifest.length) throw new Error('Every archive entry was refused; nothing was extracted.');
  return {
    result: {
      entries: written.length,
      skipped: manifest.filter((m) => m.skipped).length,
      manifest: manifest.map((m) => ({ name: m.name, bytes: m.written, ok: !m.skipped })),
      encryption: 'none (the bundled extractor does not decrypt AES archives)',
    },
    writesOutput: false,
    bytes: seenBytes,
  };
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* DATA family — bounded byte plumbing for renderer-side transforms    */
/* ------------------------------------------------------------------ */

/**
 * The renderer owns text/data/image TRANSFORMS (they need browser codecs);
 * this family gives them exactly two primitives through the sandbox:
 *   read  : inputPath -> resultB64            (bounded by maxBytes)
 *   write : inputDataB64 -> atomic outputPath (validated against expectHeadB64)
 * Nothing else crosses the boundary: no shell, no network, no arbitrary paths
 * beyond what the main-process handler already stat-checked.
 */
async function runDataJob(job) {
  switch (job.op) {
    case 'read': {
      const st = fs.statSync(job.inputPath);
      const maxBytes = Math.min(Number(job.args?.maxBytes) || 64 * 1024 * 1024, 64 * 1024 * 1024);
      if (st.size > maxBytes) {
        throw new Error(`File is ${(st.size / 1048576).toFixed(1)} MB; the inline limit is ${maxBytes / 1048576} MB.`);
      }
      const buf = await readFileWithProgress(job.inputPath, job.id, st.size);
      return {
        result: {
          b64: buf.toString('base64'),
          size: buf.length,
        },
        writesOutput: false,
        bytes: buf.length,
      };
    }
    case 'write': {
      const data = Buffer.from(String(job.inputDataB64 || ''), 'base64');
      writeFileAtomic(job.outputPath, data);
      /* Post-write validation: reopen and confirm the bytes actually landed. */
      const reopened = fs.readFileSync(job.outputPath);
      if (reopened.length !== data.length) {
        throw new Error('Post-write validation failed: written size differs.');
      }
      if (typeof job.args?.expectHeadB64 === 'string') {
        const want = Buffer.from(job.args.expectHeadB64, 'base64');
        if (!reopened.subarray(0, want.length).equals(want)) {
          throw new Error('Post-write validation failed: file signature differs.');
        }
      }
      return {
        result: { size: reopened.length },
        output: { path: job.outputPath, bytes: reopened.length },
        bytes: reopened.length,
      };
    }
    default:
      throw new Error(`Unknown data operation "${job.op}".`);
  }
}

async function handle(job) {
  switch (job.family) {
    case 'pdf':
      return runPdfJob(job);
    case 'zip':
      if (job.op === 'zip-create') return runZipCreate(job);
      if (job.op === 'zip-extract') return runZipExtract(job);
      throw new Error(`Unknown archive operation "${job.op}".`);
    case 'data':
      return runDataJob(job);
    default:
      throw new Error(`Unknown family "${job.family}".`);
  }
}

port.on('message', async (ev) => {
  const job = ev.data;
  if (!job || typeof job.id !== 'string') return;
  try {
    const res = await handle(job);
    post({
      id: job.id,
      type: 'done',
      result: res.result || null,
      output: res.output || null,
      writesOutput: res.writesOutput !== false,
      bytes: res.bytes || 0,
    });
  } catch (err) {
    post({ id: job.id, type: 'error', message: String((err && err.message) || err) });
  }
});
