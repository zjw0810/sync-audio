'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sendJson } = require('./http/body');

const SCRYPT_KEYLEN = 64;
const COOKIE_NAME = 'sync_session';

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_FAILURES = 5;
const RATE_BLOCK_MS = 5 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  try {
    const actual = crypto.scryptSync(String(password), record.salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(record.hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function randomRoomPassword() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

class Auth {
  constructor({ settingsPath, sessionsPath, sessionTtlMs = 12 * 60 * 60 * 1000, log, logError }) {
    this.settingsPath = settingsPath;
    this.sessionsPath = sessionsPath;
    this.sessionTtlMs = sessionTtlMs;
    this.log = log || console.log;
    this.logError = logError || console.error;

    this.sessions = new Map(); // token -> {role, expires}
    this.failures = new Map(); // `${scope}:${ip}` -> {times: number[], blockedUntil}
    this.saveTimer = null;

    this.room = null;
    this.admin = null;
    /** 本次进程内已知的房间密码明文（迁移/生成/重置时才有），仅用于启动日志与控制台回显 */
    this.roomPasswordPlain = null;
    /** 同上，仅首次生成/迁移管理密码时用于启动日志 */
    this.adminPasswordPlain = null;

    this.loadSettings();
    this.loadSessions();
  }

  loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) || {};
    } catch {
      saved = {};
    }

    let changed = false;

    if (process.env.ROOM_PASSWORD) {
      this.room = hashPassword(process.env.ROOM_PASSWORD);
      this.roomPasswordPlain = process.env.ROOM_PASSWORD;
      changed = true;
    } else if (saved.room && saved.room.salt && saved.room.hash) {
      this.room = saved.room;
    } else if (typeof saved.roomPassword === 'string' && saved.roomPassword) {
      // 旧版本明文密码：迁移为 scrypt
      this.room = hashPassword(saved.roomPassword);
      this.roomPasswordPlain = saved.roomPassword;
      changed = true;
    } else {
      this.roomPasswordPlain = randomRoomPassword();
      this.room = hashPassword(this.roomPasswordPlain);
      changed = true;
    }

    if (process.env.ADMIN_PASSWORD) {
      this.admin = hashPassword(process.env.ADMIN_PASSWORD);
      this.adminPasswordPlain = process.env.ADMIN_PASSWORD;
      changed = true;
    } else if (saved.admin && saved.admin.salt && saved.admin.hash) {
      this.admin = saved.admin;
    } else if (typeof saved.adminPassword === 'string' && saved.adminPassword) {
      this.admin = hashPassword(saved.adminPassword);
      this.adminPasswordPlain = saved.adminPassword;
      changed = true;
    } else {
      this.adminPasswordPlain = crypto.randomBytes(6).toString('hex');
      this.admin = hashPassword(this.adminPasswordPlain);
      changed = true;
    }

    if (changed) this.saveSettings();
  }

  saveSettings() {
    try {
      fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      fs.writeFileSync(
        this.settingsPath,
        JSON.stringify({ room: this.room, admin: this.admin }, null, 2),
      );
    } catch (err) {
      this.logError('AUTH', `保存密码设置失败: ${err.message}`);
    }
  }

  verify(role, password) {
    const record = role === 'admin' ? this.admin : this.room;
    return verifyPassword(password, record);
  }

  setRoomPassword(password) {
    this.room = hashPassword(password);
    this.roomPasswordPlain = password;
    this.saveSettings();
    this.clearRoomSessions();
  }

  /** 仅在本次进程内迁移/重置过时能拿到明文，否则返回 null */
  getRoomPasswordForDisplay() {
    return this.roomPasswordPlain;
  }

  getAdminPasswordForDisplay() {
    return this.adminPasswordPlain;
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  loadSessions() {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8')) || [];
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) return;

    const now = Date.now();
    for (const entry of list) {
      if (!entry || typeof entry.token !== 'string') continue;
      if (!entry.expires || entry.expires < now) continue;
      if (entry.role !== 'room' && entry.role !== 'admin') continue;
      this.sessions.set(entry.token, { role: entry.role, expires: entry.expires });
    }
  }

  persistSessions() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeSessions();
    }, 200);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  writeSessions() {
    try {
      fs.mkdirSync(path.dirname(this.sessionsPath), { recursive: true });
      const list = [...this.sessions].map(([token, session]) => ({
        token,
        role: session.role,
        expires: session.expires,
      }));
      fs.writeFileSync(this.sessionsPath, JSON.stringify(list, null, 2));
    } catch (err) {
      this.logError('AUTH', `保存会话失败: ${err.message}`);
    }
  }

  createSession(role) {
    const token = crypto.randomBytes(18).toString('base64url');
    this.sessions.set(token, { role, expires: Date.now() + this.sessionTtlMs });
    this.persistSessions();
    return token;
  }

  readSession(req) {
    const cookie = req.headers.cookie || '';
    const match = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`).exec(cookie);
    if (!match) return null;

    const token = decodeURIComponent(match[1]);
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expires < Date.now()) {
      this.sessions.delete(token);
      this.persistSessions();
      return null;
    }
    session.token = token;
    return session;
  }

  destroySession(req) {
    const session = this.readSession(req);
    if (session) {
      this.sessions.delete(session.token);
      this.persistSessions();
    }
    return session;
  }

  clearRoomSessions() {
    for (const [token, session] of this.sessions) {
      if (session.role === 'room') this.sessions.delete(token);
    }
    this.persistSessions();
  }

  setSessionCookie(res, token) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
        this.sessionTtlMs / 1000,
      )}`,
    );
  }

  clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  requireAdmin(req, res) {
    const session = this.readSession(req);
    if (!session || session.role !== 'admin') {
      sendJson(res, 401, { error: '需要管理员密码' });
      return null;
    }
    return session;
  }

  requireSession(req, res) {
    const session = this.readSession(req);
    if (!session) {
      sendJson(res, 401, { error: '请先加入房间' });
      return null;
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // 登录限流（按 IP + 作用域，10 分钟 5 次失败后封 5 分钟）
  // -------------------------------------------------------------------------

  rateKey(req, scope) {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    return `${scope}:${ip}`;
  }

  checkRate(req, scope) {
    const key = this.rateKey(req, scope);
    const entry = this.failures.get(key);
    if (!entry) return { blocked: false, retryAfterMs: 0 };

    const now = Date.now();
    if (entry.blockedUntil && entry.blockedUntil > now) {
      return { blocked: true, retryAfterMs: entry.blockedUntil - now };
    }
    if (entry.blockedUntil && entry.blockedUntil <= now) {
      this.failures.delete(key);
      return { blocked: false, retryAfterMs: 0 };
    }

    entry.times = entry.times.filter((at) => now - at < RATE_WINDOW_MS);
    if (entry.times.length === 0) this.failures.delete(key);
    return { blocked: false, retryAfterMs: 0 };
  }

  recordFailure(req, scope) {
    const key = this.rateKey(req, scope);
    const now = Date.now();
    const entry = this.failures.get(key) || { times: [], blockedUntil: 0 };
    entry.times = entry.times.filter((at) => now - at < RATE_WINDOW_MS);
    entry.times.push(now);

    if (entry.times.length >= RATE_MAX_FAILURES) {
      entry.blockedUntil = now + RATE_BLOCK_MS;
      entry.times = [];
      this.logError('AUTH', `${key} 失败次数过多，已封禁 5 分钟`);
    }
    this.failures.set(key, entry);
  }

  recordSuccess(req, scope) {
    this.failures.delete(this.rateKey(req, scope));
  }
}

module.exports = { Auth, hashPassword, verifyPassword, COOKIE_NAME };
