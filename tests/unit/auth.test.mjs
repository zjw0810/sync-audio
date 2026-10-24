import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Auth, hashPassword, verifyPassword } from '../../server/auth.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-audio-auth-'));
}

function makeAuth(dir) {
  return new Auth({
    settingsPath: path.join(dir, 'settings.json'),
    sessionsPath: path.join(dir, 'sessions.json'),
    sessionTtlMs: 60_000,
    log: () => {},
    logError: () => {},
  });
}

function requestWithCookie(cookie) {
  return { headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } };
}

test('scrypt: 哈希可验证，错误密码不通过', () => {
  const record = hashPassword('Sync');
  assert.equal(verifyPassword('Sync', record), true);
  assert.equal(verifyPassword('sync', record), false);
  assert.equal(verifyPassword('', record), false);
  assert.equal(record.hash.includes('Sync'), false);
});

test('Auth: 旧版明文密码自动迁移为哈希', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ roomPassword: '1111', adminPassword: 'Sync' }),
  );

  const auth = makeAuth(dir);
  assert.equal(auth.verify('room', '1111'), true);
  assert.equal(auth.verify('admin', 'Sync'), true);
  assert.equal(auth.verify('admin', '1111'), false);

  const saved = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.equal(saved.includes('1111'), false);
  assert.equal(saved.includes('"Sync"'), false);
  assert.ok(JSON.parse(saved).room.salt);
  assert.ok(JSON.parse(saved).admin.hash);
});

test('Auth: 新装时生成随机密码并可验证', () => {
  const dir = tmpDir();
  const auth = makeAuth(dir);
  const room = auth.getRoomPasswordForDisplay();
  assert.match(room, /^\d{6}$/);
  assert.equal(auth.verify('room', room), true);
  assert.equal(auth.getAdminPasswordForDisplay().length, 12);
});

test('Auth: 会话创建、读取、销毁与持久化', () => {
  const dir = tmpDir();
  const auth = makeAuth(dir);
  const token = auth.createSession('room');
  auth.writeSessions();

  const session = auth.readSession(requestWithCookie(`sync_session=${token}`));
  assert.equal(session.role, 'room');

  const reloaded = makeAuth(dir);
  const restored = reloaded.readSession(requestWithCookie(`sync_session=${token}`));
  assert.equal(restored.role, 'room');

  reloaded.destroySession(requestWithCookie(`sync_session=${token}`));
  assert.equal(reloaded.readSession(requestWithCookie(`sync_session=${token}`)), null);
});

test('Auth: 改房间密码会清掉 room 会话但保留 admin', () => {
  const dir = tmpDir();
  const auth = makeAuth(dir);
  const roomToken = auth.createSession('room');
  const adminToken = auth.createSession('admin');

  auth.setRoomPassword('8888');

  assert.equal(auth.readSession(requestWithCookie(`sync_session=${roomToken}`)), null);
  assert.equal(auth.readSession(requestWithCookie(`sync_session=${adminToken}`)).role, 'admin');
  assert.equal(auth.verify('room', '8888'), true);
});

test('Auth: 登录限流 5 次失败后封禁，成功会重置', () => {
  const dir = tmpDir();
  const auth = makeAuth(dir);
  const req = requestWithCookie('');

  for (let i = 0; i < 5; i += 1) auth.recordFailure(req, 'join');
  const blocked = auth.checkRate(req, 'join');
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterMs > 0);

  // 不同 IP 不受影响
  const other = { headers: {}, socket: { remoteAddress: '10.0.0.2' } };
  assert.equal(auth.checkRate(other, 'join').blocked, false);
});

test('Auth: 成功登录会清空该 IP 的失败计数', () => {
  const dir = tmpDir();
  const auth = makeAuth(dir);
  const req = requestWithCookie('');

  auth.recordFailure(req, 'admin');
  auth.recordFailure(req, 'admin');
  auth.recordSuccess(req, 'admin');

  assert.equal(auth.checkRate(req, 'admin').blocked, false);
});
