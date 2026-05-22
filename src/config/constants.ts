import path from 'path';

export const DIST_DIR = path.resolve('./dist');
export const RULES_DIR = path.join(DIST_DIR, 'rules');
export const MAX_RULES_PER_FILE = 30000;

export const DEFAULT_RESOURCE_TYPES = ['script', 'image', 'xmlhttprequest', 'sub_frame'] as const;

/**
 * Default resource types for tracking/privacy lists (EasyPrivacy, Fanboy Social).
 * These lists target data collection (beacons, pixels, analytics XHR) — not scripts.
 * Excluding 'script' prevents the common pattern where a site gates its app
 * initialisation behind a third-party SDK (e.g. btloader.com) that happens to
 * appear in EasyPrivacy, causing the page to render blank.
 */
export const TRACKING_DEFAULT_RESOURCE_TYPES = ['image', 'xmlhttprequest', 'sub_frame'] as const;

export const ALL_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
] as const;
