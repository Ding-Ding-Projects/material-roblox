'use strict';

/**
 * Native file pickers.
 *
 * Channels:
 *   dialog:open  { filters?: [{name, extensions[]}], multi?, dir? } -> string[] | null
 *   dialog:save  { defaultName, filters? }                          -> string | null
 */

const { dialog } = require('electron');

const MAX_FILTERS = 16;
const MAX_EXTENSION_LENGTH = 16;
const EXTENSION_PATTERN = /^[A-Za-z0-9*?.]{1,16}$/;

/** Validate and normalize an Electron file-filter list; null passes through. */
function normalizeFilters(filters) {
  if (filters === undefined || filters === null) return undefined;
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) {
    throw new TypeError('filters must be an array of at most ' + MAX_FILTERS + ' entries.');
  }
  return filters.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
      throw new TypeError('Each filter needs a name.');
    }
    if (!Array.isArray(entry.extensions)) {
      throw new TypeError('Each filter needs an extensions array.');
    }
    const extensions = entry.extensions.map((ext) => {
      if (typeof ext !== 'string' || !EXTENSION_PATTERN.test(ext)) {
        throw new TypeError('Filter extensions must be short file suffixes like "json".');
      }
      return ext;
    });
    return { name: entry.name.slice(0, 100), extensions };
  });
}

exports.register = function register({ ipcMain, getWin }) {
  ipcMain.handle('dialog:open', async (_event, payload) => {
    if (payload !== undefined && payload !== null && typeof payload !== 'object') {
      throw new TypeError('Expected an object payload.');
    }
    const options = {};
    const filters = normalizeFilters(payload && payload.filters);
    if (filters) options.filters = filters;

    const wantsDirectory = Boolean(payload && payload.dir);
    const properties = wantsDirectory ? ['openDirectory'] : ['openFile'];
    if (payload && payload.multi && !wantsDirectory) {
      properties.push('multiSelections');
    }
    options.properties = properties;

    const parent = getWin();
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !Array.isArray(result.filePaths)) return null;
    return result.filePaths;
  });

  ipcMain.handle('dialog:save', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Expected { defaultName }.');
    if (typeof payload.defaultName !== 'string' || !payload.defaultName.trim()) {
      throw new TypeError('defaultName is required.');
    }
    const options = {
      defaultName: payload.defaultName.slice(0, 255),
    };
    const filters = normalizeFilters(payload.filters);
    if (filters) options.filters = filters;

    const parent = getWin();
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || typeof result.filePath !== 'string') return null;
    return result.filePath;
  });
};
