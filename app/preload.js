'use strict';

/**
 * Preload bridge. This is the ONLY surface the renderer can reach.
 *
 * Exposed shape (nothing else crosses the bridge):
 *   window.mrb.invoke(channel, payload) -> Promise<any>
 *   window.mrb.on(channel, cb)          -> unsubscribe function
 *   window.mrb.platform                 -> process.platform
 *   window.mrb.versions                 -> { app, electron, chrome, node }
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL_PATTERN = /^[a-z]+:[a-z]+$/;

function assertChannel(channel) {
  if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) {
    throw new TypeError('Rejected IPC channel name.');
  }
}

contextBridge.exposeInMainWorld('mrb', {
  invoke(channel, payload) {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, payload);
  },

  on(channel, callback) {
    assertChannel(channel);
    if (typeof callback !== 'function') {
      throw new TypeError('A listener callback is required.');
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return function unsubscribe() {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  platform: process.platform,

  /**
   * The npm-provided package version is present when launched through an npm
   * script and absent in packaged builds; packaged builds read their real
   * version through the update feed metadata instead. Kept honest either way.
   */
  versions: {
    app: process.env.npm_package_version || '0.0.0-dev',
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
  },
});
