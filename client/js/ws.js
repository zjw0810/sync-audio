'use strict';

/**
 * 客户端 WebSocket：连接、自动重连、PCM 帧配对、NTP 时钟同步。
 *
 * 时钟是全项目唯一来源：
 *   estimatedServerTime() = Date.now() + offset
 * offset 由 5 次 sync/sync_reply 往返测量后取中位数得到；
 * scheduler 直接 import 这个函数，不再自己维护第二份时间基准。
 */

const SYNC_ROUNDS = 5;
const SYNC_INTERVAL_MS = 200;
const RESYNC_ROUNDS = 3;
const RESYNC_INTERVAL_MS = 30000;

/** 全模块唯一的时钟偏移（毫秒） */
let serverOffsetMs = 0;

export function estimatedServerTime() {
  return Date.now() + serverOffsetMs;
}

export function getServerOffset() {
  return serverOffsetMs;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function createSyncSocket({ url, onBlock, onStatus = () => {}, reconnectDelayMs = 2000 }) {
  let socket = null;
  let pendingPcm = null;
  let closedByUser = false;
  let reconnectTimer = null;
  let rtcPc = null;
  let rtcOnStream = null;

  /** 本轮握手尚未收到回复的 t1 集合 */
  const syncPending = new Map();
  let syncTimer = null;
  let resyncTimer = null;
  let syncSamples = [];
  let syncRtts = [];
  let syncKind = 'initial';
  let syncTarget = SYNC_ROUNDS;
  let syncFallbackTimer = null;

  function emit(payload) {
    onStatus(payload);
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function stopClockSync() {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  function stopResync() {
    if (resyncTimer) {
      clearInterval(resyncTimer);
      resyncTimer = null;
    }
  }

  /**
   * 一轮校时：立刻发第一次，之后每 200ms 一次，共 rounds 次。
   * 首次 5 轮取中位数；之后每 30 秒补 3 轮，用 RTT 最小的样本做慢速修正，
   * 抵消手机/电脑晶振随温度和时间产生的漂移（公网长时间播放必需）。
   */
  function startClockSync(rounds = SYNC_ROUNDS, kind = 'initial') {
    stopClockSync();
    syncPending.clear();
    syncSamples = [];
    syncRtts = [];
    syncKind = kind;
    syncTarget = rounds;
    let sent = 0;

    const sendOnce = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        stopClockSync();
        return;
      }
      if (sent >= rounds) {
        stopClockSync();
        return;
      }
      const t1 = Date.now();
      syncPending.set(t1, true);
      sent += 1;
      try {
        socket.send(JSON.stringify({ type: 'sync', t1 }));
      } catch {
        /* 连接刚断开，交给 close 处理 */
      }
      if (sent >= rounds) stopClockSync();
    };

    sendOnce();
    syncTimer = setInterval(sendOnce, SYNC_INTERVAL_MS);

    // 首次校时最多等 3 秒：收不齐也不能一直不出声，用已有样本先顶上
    if (kind === 'initial') {
      clearTimeout(syncFallbackTimer);
      syncFallbackTimer = setTimeout(() => {
        syncFallbackTimer = null;
        if (syncSamples.length === 0) return;
        serverOffsetMs = median(syncSamples);
        emit({
          state: 'synced',
          offset: serverOffsetMs,
          samples: syncSamples.length,
          rounds: syncTarget,
          rtt: syncRtts.length ? median(syncRtts) : 0,
          fallback: true,
        });
      }, 3000);
    }
  }

  function handleSyncReply(message) {
    const t1 = message.t1;
    if (typeof t1 !== 'number' || !syncPending.has(t1)) return; // 不是本轮请求的回复
    if (typeof message.t2 !== 'number') return;

    syncPending.delete(t1);
    const t3 = Date.now();
    const t2 = message.t2;

    const offset = (t2 - t1 + (t2 - t3)) / 2;
    const rtt = t3 - t1;

    syncSamples.push(offset);
    syncRtts.push(rtt);

    const payload = {
      state: 'clock',
      offset: serverOffsetMs,
      samples: syncSamples.length,
      rounds: syncTarget,
      rtt: median(syncRtts),
    };

    if (syncKind === 'initial') {
      serverOffsetMs = median(syncSamples);
      payload.offset = serverOffsetMs;
      if (syncSamples.length >= syncTarget) {
        if (syncFallbackTimer) {
          clearTimeout(syncFallbackTimer);
          syncFallbackTimer = null;
        }
        emit({ ...payload, state: 'synced' });
        if (!resyncTimer) {
          resyncTimer = setInterval(() => {
            if (!syncTimer) startClockSync(RESYNC_ROUNDS, 'resync');
          }, RESYNC_INTERVAL_MS);
        }
      } else {
        emit(payload);
      }
      return;
    }

    // 重同步：只在这一轮收齐后，用 RTT 最小的样本做渐进修正
    if (syncSamples.length < syncTarget) return;

    let bestIndex = 0;
    for (let i = 1; i < syncSamples.length; i += 1) {
      if (syncRtts[i] < syncRtts[bestIndex]) bestIndex = i;
    }
    const best = syncSamples[bestIndex];
    const diff = best - serverOffsetMs;
    serverOffsetMs = Math.abs(diff) > 100 ? best : serverOffsetMs + diff * 0.3;

    emit({
      state: 'clock',
      offset: serverOffsetMs,
      samples: syncTarget,
      rounds: syncTarget,
      rtt: syncRtts[bestIndex],
      resync: true,
    });
  }

  function handleHeartbeat(message) {
    if (typeof message.serverTime !== 'number') return;
    const estimated = estimatedServerTime();
    emit({
      state: 'heartbeat',
      serverTime: message.serverTime,
      estimatedServerTime: estimated,
      residual: estimated - message.serverTime,
    });
  }

  function closeRtc() {
    if (rtcPc) {
      try {
        rtcPc.close();
      } catch {
        /* 忽略 */
      }
    }
    rtcPc = null;
    rtcOnStream = null;
  }

  /** 建立接收端 WebRTC 连接（服务端推 Opus，客户端 recvonly） */
  function startRtc(onStream) {
    if (rtcPc) return;
    rtcOnStream = onStream;

    const pc = new RTCPeerConnection({ iceServers: [] });
    rtcPc = pc;

    pc.ontrack = (event) => {
      const stream =
        event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      if (rtcOnStream) rtcOnStream(stream);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      send({
        type: 'rtc_ice',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closeRtc();
    };

    send({ type: 'rtc_start' });
  }

  function handleTextFrame(text) {
    let message = null;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'sync_reply') {
      handleSyncReply(message);
      return;
    }
    if (message.type === 'rtc_offer') {
      if (!rtcPc) return;
      (async () => {
        await rtcPc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        const answer = await rtcPc.createAnswer();
        await rtcPc.setLocalDescription(answer);
        send({ type: 'rtc_answer', sdp: answer.sdp });
      })().catch((err) => emit({ state: 'error', reason: `WebRTC 协商失败: ${err.message}` }));
      return;
    }
    if (message.type === 'rtc_ice') {
      if (!rtcPc || !message.candidate) return;
      rtcPc.addIceCandidate(message.candidate).catch(() => {});
      return;
    }
    if (message.type === 'heartbeat') {
      handleHeartbeat(message);
      return;
    }

    // 音频元数据帧：seq + scheduledTime，必须与前面暂存的二进制帧配对
    const isAudioMeta =
      typeof message.seq === 'number' && typeof message.scheduledTime === 'number';

    if (isAudioMeta && pendingPcm) {
      const pcmData = pendingPcm;
      pendingPcm = null;
      onBlock({
        seq: message.seq,
        scheduledTime: message.scheduledTime,
        pcmData,
      });
      return;
    }

    // 其它控制帧：丢掉可能残留的二进制，避免和下一块错配
    pendingPcm = null;
    emit({ state: 'control', message });
  }

  function connect() {
    closedByUser = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    emit({ state: 'connecting' });

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      emit({ state: 'error', reason: err.message });
      scheduleReconnect();
      return;
    }

    socket = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      if (socket !== ws) return;
      emit({ state: 'open' });
      startClockSync();
    });

    ws.addEventListener('message', (event) => {
      if (socket !== ws) return;
      if (typeof event.data === 'string') {
        handleTextFrame(event.data);
        return;
      }
      pendingPcm = new Int16Array(event.data);
    });

    ws.addEventListener('error', () => {
      if (socket !== ws) return;
      emit({ state: 'error' });
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      socket = null;
      pendingPcm = null;
      closeRtc();
      stopClockSync();
      stopResync();
      clearTimeout(syncFallbackTimer);
      syncFallbackTimer = null;
      syncPending.clear();
      if (event.code === 4001) emit({ state: 'unauthorized' });
      emit({ state: 'closed', code: event.code });
      if (!closedByUser) scheduleReconnect();
    });
  }

  function close() {
    closedByUser = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopClockSync();
    stopResync();
    closeRtc();
    clearTimeout(syncFallbackTimer);
    syncFallbackTimer = null;
    syncPending.clear();
    pendingPcm = null;
    if (socket) {
      const current = socket;
      socket = null;
      try {
        current.close(1000, 'leave');
      } catch {
        /* 忽略 */
      }
    }
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  return { connect, close, send, startRtc };
}
