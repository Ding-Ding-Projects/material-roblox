/**
 * vscode:* — open a file or folder in Visual Studio Code.
 *
 * Detection order: PATH lookup via `where code.cmd` / `code`, then the
 * standard per-user and machine install locations, then Insiders. Opening a
 * folder passes it as a workspace root so the explorer tree is usable.
 * Never installed -> an honest {ok:false, reason:'not-installed'} instead of
 * a guessed success or a different editor.
 */
const { spawn, spawnSync } = require('child_process');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function candidateExes() {
  const candidates = [];
  const add = (p) => { if (p) candidates.push(p); };

  try {
    const where = spawnSync('where', ['code.cmd'], { shell: false, encoding: 'utf8' });
    if (where.status === 0) String(where.stdout).split(/\r?\n/).forEach((l) => add(l.trim()));
  } catch (_) { /* where unavailable */ }

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  add(path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'));
  add(path.join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'));
  add(path.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'));
  add(path.join(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'));
  return candidates.filter((p) => p && fs.existsSync(p));
}

function firstExisting(candidates) {
  for (const exe of candidates) {
    try { fs.accessSync(exe, fs.constants.X_OK); return exe; } catch (_) { /* next */ }
  }
  return null;
}

module.exports = {
  register({ ipcMain, getApp }) {
    ipcMain.handle('vscode:detect', async () => {
      const exe = firstExisting(candidateExes());
      return { ok: true, available: Boolean(exe), exe: exe || null };
    });

    ipcMain.handle('vscode:open', async (_event, raw) => {
      const payload = raw && typeof raw === 'object' ? raw : {};
      const kind = payload.kind || payload.target || 'file'; // 'file' | 'folder' | 'userData'
      let target = typeof payload.path === 'string' ? payload.path : '';
      if (kind === 'userData' && getApp) {
        target = getApp().getPath('userData');
      }
      if (kind !== 'userData' && (!target || !path.isAbsolute(target))) {
        throw new Error('An absolute file or folder path is required.');
      }
      if (target) {
        try { fs.accessSync(target); } catch (_) {
          return { ok: false, reason: 'missing', message: `Path does not exist: ${target}` };
        }
      }

      const exe = firstExisting(candidateExes());
      if (!exe) return { ok: false, reason: 'not-installed' };

      const args = kind === 'file'
        ? ['--reuse-window', target]
        : ['-n', target]; // folders open as a fresh workspace root

      try {
        const child = spawn(exe, args.filter(Boolean), { detached: true, stdio: 'ignore', shell: false });
        child.unref();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: 'spawn-failed', message: String(err.message || err) };
      }
    });
  },
};
