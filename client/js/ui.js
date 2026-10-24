'use strict';

import { SyncScheduler } from './scheduler.js';
import { createSyncSocket, estimatedServerTime, getServerOffset } from './ws.js';

const els = {
  pill: document.getElementById('status-pill'),
  statusText: document.getElementById('status-text'),
  gate: document.getElementById('gate'),
  room: document.getElementById('room'),
  form: document.getElementById('join-form'),
  password: document.getElementById('room-password'),
  error: document.getElementById('error'),
  joinButton: document.getElementById('join-button'),
  gateHint: document.getElementById('gate-hint'),
  leaveButton: document.getElementById('leave-button'),
  offsetValue: document.getElementById('offset-value'),
  offsetDetail: document.getElementById('offset-detail'),
  delayValue: document.getElementById('delay-value'),
  range: document.getElementById('manual-range'),
};

const MANUAL_STORAGE_KEY = 'sync-audio:manual-offset';
const MANUAL_APPLY_DELAY_MS = 200;

let scheduler = null;
let socket = null;
let joined = false;
let authed = false;
let clockSynced = false;
let manualTimer = null;
let manualOffset = loadManualOffset();
let lastStatsSentAt = 0;

/** 端到端脚本和排障用的调试快照 */
function updateDebug(partial) {
  window.__syncDebug = { ...(window.__syncDebug || {}), ...partial, at: Date.now() };
}

function loadManualOffset() {
  try {
    const value = Number(window.localStorage.getItem(MANUAL_STORAGE_KEY));
    if (Number.isFinite(value)) return Math.max(-200, Math.min(200, Math.round(value)));
  } catch {
    /* 隐私模式 */
  }
  return 0;
}

function saveManualOffset() {
  try {
    window.localStorage.setItem(MANUAL_STORAGE_KEY, String(manualOffset));
  } catch {
    /* 忽略 */
  }
}

function setStatus(kind, text) {
  els.pill.dataset.state = kind;
  els.statusText.textContent = text;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

function signed(value) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded).toFixed(1)}`;
}

function renderResidual(residual) {
  els.offsetValue.textContent = signed(residual);
}

function renderOffsetDetail(event) {
  const rtt = Number.isFinite(event.rtt) ? event.rtt.toFixed(1) : '—';
  els.offsetDetail.textContent = `offset ${signed(event.offset)} ms · 往返 ${rtt} ms`;
}

function renderDelay() {
  els.delayValue.textContent = String(Math.round(manualOffset));
}

function wsUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}`;
}

function handleManualInput() {
  manualOffset = Number(els.range.value) || 0;
  renderDelay();
  saveManualOffset();

  clearTimeout(manualTimer);
  manualTimer = setTimeout(() => {
    manualTimer = null;
    if (scheduler) scheduler.setManualOffset(manualOffset);
  }, MANUAL_APPLY_DELAY_MS);
}

function handleSocketStatus(event) {
  if (!joined) return;

  if (event.state === 'connecting') {
    setStatus('connecting', '正在连接主机');
    return;
  }

  if (event.state === 'open') {
    setStatus('connecting', '正在校准时钟');
    return;
  }

  if (event.state === 'synced') {
    clockSynced = true;
    updateDebug({ synced: true, offset: event.offset, rtt: event.rtt });
    renderOffsetDetail(event);
    if (scheduler && scheduler.scheduledCount === 0) scheduler.resetTimeline();
    setStatus('live', '同步播放中');
    return;
  }

  if (event.state === 'clock') {
    updateDebug({ offset: event.offset, rtt: event.rtt, samples: event.samples });
    renderOffsetDetail(event);
    return;
  }

  if (event.state === 'heartbeat') {
    updateDebug({
      residual: event.residual,
      offset: getServerOffset(),
      estimatedServerTime: estimatedServerTime(),
    });
    renderResidual(event.residual);
    return;
  }

  if (event.state === 'unauthorized') {
    authed = false;
    leavesToGate('房间密码已变更，请重新加入');
    return;
  }

  if (event.state === 'closed') {
    clockSynced = false;
    setStatus('error', '连接已断开，正在重连');
  }
}

async function join() {
  if (joined) return;

  els.joinButton.disabled = true;
  hideError();

  try {
    scheduler = new SyncScheduler({
      onStats: (stats) => {
        updateDebug({
          bufferMs: stats.bufferMs,
          late: stats.late,
          gaps: stats.gaps,
          leadMs: stats.leadMs,
          outputLatencyMs: stats.outputLatencyMs,
        });
        const now = Date.now();
        if (socket && joined && now - lastStatsSentAt > 5000) {
          lastStatsSentAt = now;
          socket.send({
            type: 'stats',
            bufferMs: stats.bufferMs,
            late: stats.late,
            underruns: stats.gaps,
            scheduleErrorMs: 0,
          });
        }
      },
      onLog: (message) => console.info('[sync]', message),
    });
    // AudioContext 必须在点击手势里创建
    await scheduler.init();
    scheduler.setManualOffset(manualOffset);

    if (!authed) {
      const response = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: els.password.value.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '房间密码错误');
      authed = true;
    }

    socket = createSyncSocket({
      url: wsUrl(),
      onBlock: (block) => {
        if (!clockSynced || !scheduler) return;
        scheduler.enqueue(block);
      },
      onStatus: handleSocketStatus,
    });
    socket.connect();

    joined = true;
    els.gate.hidden = true;
    els.room.hidden = false;
    setStatus('connecting', '正在连接主机');
  } catch (err) {
    if (scheduler) {
      await scheduler.dispose();
      scheduler = null;
    }
    showError(err.message);
    setStatus('idle', '未加入');
  } finally {
    els.joinButton.disabled = false;
  }
}

function leavesToGate(message) {
  const active = scheduler;
  scheduler = null;
  joined = false;
  clockSynced = false;

  if (socket) {
    socket.close();
    socket = null;
  }
  if (active) active.dispose().catch(() => {});

  els.room.hidden = true;
  els.gate.hidden = false;
  els.password.value = '';
  els.password.parentElement.hidden = !authed;
  els.joinButton.textContent = authed ? '进入房间' : '加入房间';
  setStatus('idle', '未加入');
  if (message) showError(message);
}

async function leave() {
  if (!joined) return;
  const active = scheduler;
  joined = false;
  clockSynced = false;
  scheduler = null;

  if (socket) {
    socket.close();
    socket = null;
  }
  if (active) await active.dispose();

  els.room.hidden = true;
  els.gate.hidden = false;
  els.password.parentElement.hidden = authed;
  els.joinButton.textContent = authed ? '进入房间' : '加入房间';
  setStatus('idle', '未加入');
  hideError();
}

async function bootstrap() {
  try {
    const response = await fetch('/api/session', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    if (data && data.role) {
      authed = true;
      els.password.parentElement.hidden = true;
      els.joinButton.textContent = '进入房间';
      els.gateHint.textContent = '已验证身份，点击进入即可。';
    }
  } catch {
    /* 离线时保持默认 */
  }
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  join().catch((err) => console.error(err));
});

els.leaveButton.addEventListener('click', () => {
  leave().catch((err) => console.error(err));
});

els.range.addEventListener('input', handleManualInput);

els.range.value = String(manualOffset);
renderDelay();
renderResidual(NaN);

bootstrap();
