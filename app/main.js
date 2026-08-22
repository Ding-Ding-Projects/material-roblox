'use strict';

/**
 * Material Roblox - Electron main process entry.
 *
 * Responsibilities kept deliberately thin:
 *   - single-instance lock (a second launch focuses the existing window),
 *   - frameless BrowserWindow creation with the security posture from the
 *     development contract (contextIsolation on, nodeIntegration off),
 *   - auto-registration of every app/ipc/*.js handler module,
 *   - window bounds persistence to userData/window-state.json,
 *   - DevTools gated behind the --dev flag only.
 *
 * Handler modules are discovered from disk; adding a file in app/ipc/ is the
 * whole integration. Files starting with "_" are helpers and are skipped.
 */

const { app, BrowserWindow, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { atomicWriteFileSync, readJsonFileSync } = require('./ipc/_fsutil.js');

const APP_USER_MODEL_ID = 'projects.dingding.materialroblox';
const BACKGROUND_COLOR = '#141218';
const MIN_WIDTH = 940;
const MIN_HEIGHT = 600;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const WINDOW_STATE_FILE = 'window-state.json';
const SAVE_DEBOUNCE_MS = 250;
const DEV_FLAG = '--dev';

/** @type {BrowserWindow | null} */
let mainWindow = null;
let stateSaveTimer = null;

function isDevMode() {
  return process.argv.includes(DEV_FLAG);
}

/** Handlers receive this so a module never needs a main-process import cycle. */
function getWin() {
  return mainWindow;
}

function windowStatePath() {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

function readWindowState() {
  const raw = readJsonFileSync(windowStatePath(), null);
  if (!raw || typeof raw !== 'object') return null;
  const bounds = raw.bounds && typeof raw.bounds === 'object' ? raw.bounds : {};
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const state = {
    bounds: {
      width: Number.isFinite(width) ? Math.max(MIN_WIDTH, Math.round(width)) : DEFAULT_WIDTH,
      height: Number.isFinite(height) ? Math.max(MIN_HEIGHT, Math.round(height)) : DEFAULT_HEIGHT,
    },
    maximized: raw.maximized === true,
  };
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    state.bounds.x = Math.round(x);
    state.bounds.y = Math.round(y);
  }
  return state;
}

/** Drop a saved position that no longer sits on any attached display. */
function clampBoundsToDisplays(state) {
  const displays = screen.getAllDisplays();
  const isVisible = displays.some((display) => {
    const area = display.workArea;
    const bx = state.bounds.x;
    const by = state.bounds.y;
    if (bx === undefined || by === undefined) return false;
    return (
      bx + state.bounds.width > area.x + 40 &&
      bx < area.x + area.width - 40 &&
      by + state.bounds.height > area.y + 40 &&
      by < area.y + area.height - 40
    );
  });
  if (!isVisible) {
    delete state.bounds.x;
    delete state.bounds.y;
  }
  return state;
}

function captureWindowState() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return null;
  const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
  return { bounds, maximized: win.isMaximized() };
}

function saveWindowStateNow() {
  const state = captureWindowState();
  if (!state) return;
  try {
    atomicWriteFileSync(windowStatePath(), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[main] Failed to persist window state:', err && err.message);
  }
}

function scheduleWindowStateSave() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    saveWindowStateNow();
  }, SAVE_DEBOUNCE_MS);
}

function createMainWindow() {
  const saved = readWindowState();
  const bounds = saved ? clampBoundsToDisplays(saved) : null;

  const win = new BrowserWindow({
    width: bounds ? bounds.bounds.width : DEFAULT_WIDTH,
    height: bounds ? bounds.bounds.height : DEFAULT_HEIGHT,
    x: bounds && bounds.bounds.x !== undefined ? bounds.bounds.x : undefined,
    y: bounds && bounds.bounds.y !== undefined ? bounds.bounds.y : undefined,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: 'hidden',
    backgroundColor: BACKGROUND_COLOR,
    show: false,
    title: 'Material Roblox',
    menu: null,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow = win;

  win.once('ready-to-show', () => {
    if (saved && saved.maximized) {
      win.maximize();
    }
    win.show();
  });

  win.on('resize', scheduleWindowStateSave);
  win.on('move', scheduleWindowStateSave);
  win.on('close', () => {
    if (stateSaveTimer) {
      clearTimeout(stateSaveTimer);
      stateSaveTimer = null;
    }
    saveWindowStateNow();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.on('will-navigate', (event, url) => {
    // The renderer is a closed single-page app; block surprise navigations.
    if (!url.startsWith('file://')) event.preventDefault();
  });

  void win.loadFile(path.join(__dirname, '../src/index.html'));

  if (isDevMode()) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

/** Require every handler module in app/ipc/ and call its register(). */
function registerIpcHandlers() {
  const ipcDir = path.join(__dirname, 'ipc');
  const files = fs
    .readdirSync(ipcDir)
    .filter((name) => name.endsWith('.js') && !name.startsWith('_'))
    .sort();

  for (const fileName of files) {
    try {
      const mod = require(path.join(ipcDir, fileName));
      if (mod && typeof mod.register === 'function') {
        mod.register({ ipcMain, getWin });
        console.log('[main] Registered IPC module:', fileName);
      } else {
        console.warn('[main] Skipped IPC module without register():', fileName);
      }
    } catch (err) {
      // A failing handler module must not take the whole app down; the
      // renderer surfaces honest errors when its channels are missing.
      console.error('[main] Failed to register IPC module:', fileName, err);
    }
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Windows delivery target: quitting on all-windows-closed is expected.
    app.quit();
  });

  app.on('before-quit', () => {
    if (stateSaveTimer) {
      clearTimeout(stateSaveTimer);
      stateSaveTimer = null;
    }
    saveWindowStateNow();
  });
}
