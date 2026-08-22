'use strict';

/**
 * Shell integrations with honest results.
 *
 * Channels:
 *   shell:openExternal        { url }  -> { ok: true }
 *   shell:openPath            { path } -> { ok: boolean, error?: string }
 *   shell:showItemInFolder    { path } -> { ok: true }
 */

const { shell } = require('electron');

const URL_PATTERN = /^https?:\/\//i;
const MAX_URL_LENGTH = 2048;
const MAX_PATH_LENGTH = 1024;
// Control characters and whitespace make a URL unsafe to hand to the OS.
// Written with escaped code points so no raw byte can hide in this class.
const UNSAFE_URL_PATTERN = new RegExp('[\\s\\u0000-\\u001f\\u007f]');

function cleanString(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(label + ' is required.');
  }
  if (value.length > max) {
    throw new TypeError(label + ' is too long.');
  }
  return value;
}

exports.register = function register({ ipcMain }) {
  ipcMain.handle('shell:openExternal', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Expected { url }.');
    const url = cleanString(payload.url, 'url', MAX_URL_LENGTH);
    if (!URL_PATTERN.test(url)) {
      throw new Error('Only http and https links can be opened.');
    }
    if (UNSAFE_URL_PATTERN.test(url)) {
      throw new Error('That link contains characters that are not allowed.');
    }
    try {
      await shell.openExternal(url);
    } catch (err) {
      throw new Error(
        'The operating system refused to open that link. ' +
          ((err && err.message) || '').slice(0, 200)
      );
    }
    return { ok: true };
  });

  ipcMain.handle('shell:openPath', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Expected { path }.');
    const target = cleanString(payload.path, 'path', MAX_PATH_LENGTH);
    try {
      const result = await shell.openPath(target);
      // Electron returns '' on success or a human-readable failure string.
      if (result) return { ok: false, error: String(result).slice(0, 300) };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: ((err && err.message) || 'Could not open that path.').slice(0, 300) };
    }
  });

  ipcMain.handle('shell:showItemInFolder', (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Expected { path }.');
    const target = cleanString(payload.path, 'path', MAX_PATH_LENGTH);
    shell.showItemInFolder(target);
    return { ok: true };
  });
};
