'use strict';

const { HttpError, sendJson, sendText, readJsonBody } = require('./body');

const TRACK_FILENAME_PATTERN = /^[^\\/]+$/;

function resolveUploadedFile(filename, uploadDir) {
  if (typeof filename !== 'string' || filename.trim() === '') {
    throw new HttpError(400, '缺少 filename');
  }
  const base = filename.replace(/\\/g, '/');
  if (!TRACK_FILENAME_PATTERN.test(base) || base.startsWith('.')) {
    throw new HttpError(400, '非法文件名：只允许 uploads 目录下的文件名');
  }
  return { name: base, filePath: require('node:path').join(uploadDir, base) };
}

function createApi({
  auth,
  player,
  systemShare,
  broadcaster,
  metrics,
  clients,
  uploadDir,
  getFfmpegStatus,
  maxJsonBodyBytes,
  log,
  logError,
}) {
  function clientCount() {
    return clients.size;
  }

  async function login(req, res, { scope, role, message }) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
      return;
    }

    const rate = auth.checkRate(req, scope);
    if (rate.blocked) {
      const seconds = Math.ceil(rate.retryAfterMs / 1000);
      sendJson(
        res,
        429,
        { error: `尝试次数过多，请 ${seconds} 秒后再试` },
        { 'Retry-After': String(seconds) },
      );
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, maxJsonBodyBytes);
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message });
      return;
    }

    if (!auth.verify(role, body.password || '')) {
      auth.recordFailure(req, scope);
      sendJson(res, 401, { error: message });
      return;
    }

    auth.recordSuccess(req, scope);
    auth.setSessionCookie(res, auth.createSession(role));
    log('AUTH', role === 'admin' ? '管理员已登录' : '有客户端加入房间');
    sendJson(res, 200, { role });
  }

  async function handle(req, res, pathname) {
    if (pathname === '/api/session') {
      const session = auth.readSession(req);
      sendJson(res, 200, { role: session ? session.role : null });
      return;
    }

    if (pathname === '/api/join') {
      await login(req, res, { scope: 'join', role: 'room', message: '房间密码错误' });
      return;
    }

    if (pathname === '/api/admin/login') {
      await login(req, res, { scope: 'admin', role: 'admin', message: '管理密码错误' });
      return;
    }

    if (pathname === '/api/admin/logout') {
      auth.destroySession(req);
      auth.clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/admin/settings') {
      if (!auth.requireAdmin(req, res)) return;

      if (req.method === 'GET') {
        sendJson(res, 200, {
          device: broadcaster.deviceName || null,
          sharing: broadcaster.playing,
          clients: clientCount(),
          roomPassword: auth.getRoomPasswordForDisplay(),
          roomPasswordSet: true,
        });
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req, maxJsonBodyBytes);
        const next = String(body.roomPassword || '').trim();
        if (next.length < 4 || next.length > 32) {
          sendJson(res, 400, { error: '房间密码需为 4–32 个字符' });
          return;
        }

        auth.setRoomPassword(next);

        for (const socket of clients.values()) {
          if (socket.authRole === 'room') {
            try {
              socket.close(4001, 'password changed');
            } catch {
              /* 忽略 */
            }
          }
        }

        log('AUTH', '房间密码已更新，原有客户端需要重新加入');
        sendJson(res, 200, { ok: true, roomPassword: next });
        return;
      }

      sendJson(res, 405, { error: '不支持的方法' });
      return;
    }

    if (pathname === '/api/admin/now-playing') {
      if (!auth.requireAdmin(req, res)) return;
      sendJson(res, 200, player.nowPlaying());
      return;
    }

    if (pathname === '/api/admin/player/next' || pathname === '/api/admin/player/prev') {
      if (!auth.requireAdmin(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
        return;
      }
      try {
        const result = await player.playAdjacent(pathname.endsWith('next') ? 1 : -1);
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, err instanceof HttpError ? err.statusCode : 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/admin/player/pause') {
      if (!auth.requireAdmin(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
        return;
      }

      const body = await readJsonBody(req, maxJsonBodyBytes).catch(() => ({}));
      try {
        const state = await player.pause(
          typeof body.paused === 'boolean' ? body.paused : undefined,
        );
        sendJson(res, 200, state);
      } catch (err) {
        sendJson(res, err instanceof HttpError ? err.statusCode : 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/admin/player/source') {
      if (!auth.requireAdmin(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
        return;
      }

      const body = await readJsonBody(req, maxJsonBodyBytes);
      try {
        const state = await player.setSource(body.source);
        sendJson(res, 200, state);
      } catch (err) {
        sendJson(res, err instanceof HttpError ? err.statusCode : 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/admin/share') {
      if (!auth.requireAdmin(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '仅支持 POST' }, { Allow: 'POST' });
        return;
      }

      const body = await readJsonBody(req, maxJsonBodyBytes);
      if (body.enabled === false) {
        await player.stop('管理员停止共享');
        sendJson(res, 200, { sharing: false });
      } else {
        const ok = await player.startSystem('admin');
        sendJson(res, 200, { sharing: ok });
      }
      return;
    }

    if (pathname === '/status') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '仅支持 GET' }, { Allow: 'GET' });
        return;
      }
      if (!auth.requireAdmin(req, res)) return;
      sendJson(res, 200, {
        sharing: broadcaster.playing,
        kind: broadcaster.sourceKind || null,
        device: broadcaster.deviceName || null,
        clients: clientCount(),
        level: broadcaster.lastPeak || 0,
        ffmpeg: getFfmpegStatus().ok,
        metrics: metrics.snapshot(),
      });
      return;
    }

    if (pathname === '/metrics') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '仅支持 GET' }, { Allow: 'GET' });
        return;
      }
      if (!auth.requireAdmin(req, res)) return;
      sendText(res, 200, metrics.render(), {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      return;
    }

    sendJson(res, 404, { error: '接口不存在' });
  }

  async function handlePlay(req, res) {
    let body;
    try {
      body = await readJsonBody(req, maxJsonBodyBytes);
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message });
      return;
    }

    let target;
    try {
      target = resolveUploadedFile(body.filename, uploadDir);
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message });
      return;
    }

    let stat;
    try {
      stat = await require('node:fs/promises').stat(target.filePath);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) {
      sendJson(res, 404, { error: `文件不存在: ${target.name}` });
      return;
    }

    const ffmpeg = getFfmpegStatus();
    if (!ffmpeg.ok) {
      sendJson(res, 500, { error: ffmpeg.error });
      return;
    }

    const requestedAt = Date.now();
    try {
      await player.playFile(target.filePath, target.name);
      const kb = (stat.size / 1024).toFixed(0);
      log(
        'PLAY',
        `开始播放 ${target.name}（${kb} KB），首块 ${Date.now() - requestedAt}ms 内送出，在线客户端 ${clientCount()} 个`,
      );
      sendJson(res, 200, { playing: true, filename: target.name });
    } catch (err) {
      logError('PLAY', `启动广播失败: ${err.message}`);
      sendJson(res, 500, { error: err.message });
    }
  }

  return { handle, handlePlay };
}

module.exports = { createApi, resolveUploadedFile };
