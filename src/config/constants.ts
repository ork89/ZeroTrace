import path from 'path';

export const DIST_DIR = path.resolve('./dist');
export const RULES_DIR = path.join(DIST_DIR, 'rules');
export const MAX_RULES_PER_FILE = 30000;

export const DEFAULT_RESOURCE_TYPES = [
  'script',
  'image',
  'xmlhttprequest',
  'sub_frame'
] as const;

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
  'other'
] as const;
