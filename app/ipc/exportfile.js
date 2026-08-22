/**
 * export:write — bounded atomic file writer for renderer exports.
 *
 * The renderer picks a destination through dialog:save; this handler is the
 * only path that actually touches the disk. Payload is base64 so no raw
 * Buffer crosses the bridge. Bound: 64 MiB decoded. Writes land through
 * temp+rename with a short transient retry (EPERM/EACCES/EBUSY), matching
 * the project's atomic-write convention.
 */
const fsp = require('fs').promises;
const path = require('path');

const MAX_BYTES = 64 * 1024 * 1024;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  register({ ipcMain }) {
    ipcMain.handle('export:write', async (_event, raw) => {
      if (!raw || typeof raw !== 'object') throw new Error('Bad payload.');
      if (typeof raw.path !== 'string' || !path.isAbsolute(raw.path)) {
        throw new Error('Export destination must be an absolute path chosen through the save dialog.');
      }
      if (typeof raw.dataB64 !== 'string') throw new Error('Missing export payload.');
      const buf = Buffer.from(raw.dataB64, 'base64');
      if (buf.length === 0) throw new Error('Refusing to write an empty export.');
      if (buf.length > MAX_BYTES) throw new Error(`Export exceeds the ${MAX_BYTES / 1048576} MiB bound.`);

      await fsp.mkdir(path.dirname(raw.path), { recursive: true });
      const tmp = `${raw.path}.mrb-tmp-${process.pid}-${Date.now()}`;

      let written = false;
      for (let attempt = 0; attempt < 5 && !written; attempt += 1) {
        try {
          await fsp.writeFile(tmp, buf);
          written = true;
        } catch (err) {
          if (!RETRY_CODES.has(err.code) || attempt === 4) throw err;
          await sleep(120);
        }
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await fsp.rename(tmp, raw.path);
          return { ok: true, bytes: buf.length };
        } catch (err) {
          if (!RETRY_CODES.has(err.code) || attempt === 4) {
            await fsp.unlink(tmp).catch(() => {});
            throw err;
          }
          await sleep(150);
        }
      }
      throw new Error('Export could not be finalised.');
    });
  },
};
