'use strict';

const path = require('node:path');
const os = require('node:os');

const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENT_DIR = path.join(ROOT_DIR, 'client');
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');

const SETTINGS_DIR = process.env.SYNC_SETTINGS_DIR
  ? path.resolve(process.env.SYNC_SETTINGS_DIR)
  : path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'sync-audio');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');
const SESSIONS_PATH = path.join(SETTINGS_DIR, 'sessions.json');

module.exports = {
  ROOT_DIR,
  CLIENT_DIR,
  UPLOAD_DIR,
  SETTINGS_DIR,
  SETTINGS_PATH,
  SESSIONS_PATH,

  HOST: '0.0.0.0',
  PORT: Number(process.env.PORT) || 3000,

  SESSION_TTL_MS: 12 * 60 * 60 * 1000,
  MAX_UPLOAD_BYTES: 300 * 1024 * 1024,
  MAX_JSON_BODY_BYTES: 64 * 1024,
  MAX_PART_HEADER_BYTES: 16 * 1024,

  TLS_CERT: process.env.TLS_CERT || '',
  TLS_KEY: process.env.TLS_KEY || '',
};
