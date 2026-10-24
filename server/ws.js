'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { truncate } = require('./logger');

const HEARTBEAT_INTERVAL_MS = 2000;

function sanitizeStats(payload) {
  const num = (value, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
  };
  return {
    bufferMs: num(payload.bufferMs, 60000),
    late: num(payload.late, 1e9),
    underruns: num(payload.underruns, 1e9),
    scheduleErrorMs: num(payload.scheduleErrorMs, 60000),
    rtc: Boolean(payload.rtc),
  };
}

/**
 * WebSocket 连接管理：鉴权、NTP 回包、心跳、客户端统计、RTC 信令路由。
 * 返回的 clients 是 id -> WebSocket，供广播器/HTTP API/关闭流程共用。
 */
function createWebSocket({ server, auth, rtcHub, metrics, log, logError }) {
  const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });
  const clients = new Map();
  let nextClientId = 1;
  let heartbeatTimer = null;

  wss.on('connection', (socket, req) => {
    const session = auth.readSession(req);
    if (!session) {
      socket.close(4001, 'unauthorized');
      return;
    }

    const id = nextClientId++;
    socket.authRole = session.role;
    const remoteAddress = req.socket.remoteAddress || 'unknown';
    const remotePort = req.socket.remotePort || 0;

    clients.set(id, socket);
    metrics.setClients(clients.size);
    log('WS', `#${id} 已连接 ${remoteAddress}:${remotePort}，在线 ${clients.size} 个`);

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        log('WS', `#${id} 收到二进制帧 ${data.length} bytes（服务端不接受上行音频，忽略）`);
        return;
      }

      const text = data.toString('utf8');
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        log('WS', `#${id} 收到非 JSON 文本: ${truncate(text)}`);
        return;
      }

      if (
        payload.type === 'rtc_start' ||
        payload.type === 'rtc_answer' ||
        payload.type === 'rtc_ice'
      ) {
        rtcHub.handleMessage(id, socket, payload).catch((err) => {
          logError('RTC', `#${id} 处理失败: ${err.message}`);
        });
        return;
      }

      if (payload.type === 'stats') {
        metrics.updateClient(id, sanitizeStats(payload));
        return;
      }

      // NTP 简化握手：立刻盖 t2 并原样带回 t1
      if (payload.type === 'sync' && typeof payload.t1 === 'number') {
        if (!socket.syncStarted) {
          socket.syncStarted = true;
          log('WS', `#${id} 开始 NTP 握手`);
        }
        socket.send(JSON.stringify({ type: 'sync_reply', t1: payload.t1, t2: Date.now() }));
        return;
      }

      log('WS', `#${id} 收到 JSON: ${truncate(JSON.stringify(payload))}`);
    });

    socket.on('close', (code, reason) => {
      clients.delete(id);
      rtcHub.closePeer(id);
      metrics.removeClient(id);
      metrics.setClients(clients.size);
      const detail = reason && reason.length ? `, reason=${reason.toString('utf8')}` : '';
      log('WS', `#${id} 已断开 (code=${code}${detail})，在线 ${clients.size} 个`);
    });

    socket.on('error', (err) => {
      logError('WS', `#${id} 连接错误: ${err.message}`);
    });
  });

  wss.on('error', (err) => {
    logError('WS', `WebSocketServer 错误: ${err.message}`);
  });

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      metrics.setRtcPeers(rtcHub.activeCount);
      if (clients.size === 0) return;
      const payload = JSON.stringify({ type: 'heartbeat', serverTime: Date.now() });
      for (const socket of clients.values()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        try {
          socket.send(payload);
        } catch (err) {
          logError('WS', `heartbeat 发送失败: ${err.message}`);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function closeAll(code = 1001, reason = 'server shutting down') {
    for (const socket of clients.values()) {
      try {
        socket.close(code, reason);
      } catch {
        /* 忽略 */
      }
    }
    wss.close();
  }

  return { wss, clients, startHeartbeat, stopHeartbeat, closeAll };
}

module.exports = { createWebSocket, sanitizeStats, HEARTBEAT_INTERVAL_MS };
