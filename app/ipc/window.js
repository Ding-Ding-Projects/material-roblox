'use strict';

/**
 * Frameless-window controls for the custom title bar.
 *
 * Channels:
 *   win:minimize / win:maximize / win:close / win:toggleMaximize  {} -> { ok }
 *
 * The module also pushes a 'win:maximized' boolean to every window whenever
 * the maximized state changes, so title-bar buttons can reflect reality.
 */

const { app, BrowserWindow } = require('electron');

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function attachWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const push = () => {
    if (!win.isDestroyed()) broadcast('win:maximized', win.isMaximized());
  };
  win.on('maximize', push);
  win.on('unmaximize', push);
}

function requireWindow(getWin) {
  const win = getWin();
  if (!win || win.isDestroyed()) {
    throw new Error('No application window is available right now.');
  }
  return win;
}

exports.register = function register({ ipcMain, getWin }) {
  // Attach to every window this app ever creates, including ones created
  // before or after registration.
  app.on('browser-window-created', (_event, win) => attachWindowState(win));

  ipcMain.handle('win:minimize', () => {
    requireWindow(getWin).minimize();
    return { ok: true };
  });

  ipcMain.handle('win:maximize', () => {
    const win = requireWindow(getWin);
    if (!win.isMaximized()) win.maximize();
    return { ok: true };
  });

  ipcMain.handle('win:toggleMaximize', () => {
    const win = requireWindow(getWin);
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return { ok: true };
  });

  ipcMain.handle('win:close', () => {
    // Goes through close(), so any renderer-side confirmation logic and the
    // normal close lifecycle (including state persistence in main.js) runs.
    requireWindow(getWin).close();
    return { ok: true };
  });
};
