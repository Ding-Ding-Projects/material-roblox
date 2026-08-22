/**
 * Roblox lane — bootstrap aggregator.
 *
 * Lane A may either import each surface's init() individually (per the
 * contract's module layout) or use this single entry point. Do NOT do both:
 * every surface guards against duplicate registration, but one import route
 * keeps boot order explicit.
 *
 * Order matters: api.init() injects this lane's stylesheet and registers the
 * Roblox settings group before any surface renders, so surfaces read real
 * setting values on first paint.
 */

import * as api from './api.js';

import * as home from './surfaces/home.js';
import * as users from './surfaces/users.js';
import * as friends from './surfaces/friends.js';
import * as groups from './surfaces/groups.js';
import * as games from './surfaces/games.js';
import * as marketplace from './surfaces/marketplace.js';
import * as inventory from './surfaces/inventory.js';
import * as economy from './surfaces/economy.js';
import * as presence from './surfaces/presence.js';
import * as session from './surfaces/session.js';
import * as compare from './surfaces/compare.js';

/**
 * Initialize the whole Roblox lane. Each step is isolated so one failing
 * surface degrades alone instead of taking down its siblings.
 */
export async function init() {
  await api.init();
  const steps = [
    ['home', home], ['users', users], ['friends', friends], ['groups', groups],
    ['games', games], ['marketplace', marketplace], ['inventory', inventory],
    ['economy', economy], ['presence', presence], ['session', session],
    ['compare', compare],
  ];
  for (const [name, mod] of steps) {
    try {
      if (typeof mod.init === 'function') await mod.init();
    } catch (err) {
      console.error(`[roblox] surface "${name}" failed to register:`, err);
    }
  }
}
