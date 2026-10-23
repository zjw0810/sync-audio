'use strict';

import { SyncScheduler } from './scheduler.js';
import { createSyncSocket } from './ws.js';

const STRIP_SIZE = 16;

const els = {
  join: document.getElementById('join-button'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  bufferCount: document.getElementById('buffer-count'),
  strip: document.getElementById('buffer-strip'),
  played: document.getElementById('played-count'),
  seq: document.getElementById('seq-text'),
  clock: document.getElementById('clock-text'),
  diagnostics: document.getElementById('diagnostics'),
  residual: document.getElementById('residual-text'),
  clockDetail: document.getElementById('clock-detail'),
  manualRange: document.getElementById('manual-range'),
  manualValue: document.getElementById('manual-value'),
  outputSelect: document.getElementById('output-select'),
  outputRefresh: document.getElementById('output-refresh'),
  outputTest: document.getElementById('output-test'),
  outputName: document.getElementById('output-name'),
  outputState: document.getElementById('output-state'),
  outputHint: document.getElementById('output-hint'),
  error: document.getElementById('error-box'),
};

const cells = [];
for (let i = 0; i < STRIP_SIZE; i += 1) {
  const cell = document.createElement('span');
  cell.className = 'cell';
  els.strip.append(cell);
  cells.push(cell);
}

let scheduler = null;
let socket = null;
let joined = false;
let socketOpen = false;
let clockSynced = false;
let firstOpen = true;
let lastBlockAt = 0;
let lastPeak = 0;
let lastRtt = null;
let rtcMode = false;
let clockFrame = 0;
let manualTimer = null;

const MANUAL_APPLY_DELAY_MS = 200;
const MANUAL_STORAGE_KEY = 'sync-audio:manual-offset';

function loadManualOffset() {
  try {
    const stored = Number(window.localStorage.getItem(MANUAL_STORAGE_KEY));
    if (Number.isFinite(stored)) return Math.max(-200, Math.min(200, Math.round(stored)));
  } catch {
    /* 隐私模式下不可用 */
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

let manualOffset = loadManualOffset();

const OUTPUT_STORAGE_KEY = 'sync-audio:output-device';
let outputDeviceId = (() => {
  try {
    return window.localStorage.getItem(OUTPUT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
})();

/** 设备枚举与 setSinkId 只在安全上下文（localhost / HTTPS）可用 */
const outputSupported =
  window.isSecureContext &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.enumerateDevices === 'function' &&
  typeof AudioContext.prototype.setSinkId === 'function';

const OUTPUT_HINT_DEFAULT =
  '主机把默认输出设成虚拟声卡（如 CABLE Input）时，用这里把收到的延迟声音放回真实声卡。首次刷新会请求一次麦克风权限，仅用于显示设备名称。';

/** 只有本机页面会把声音放回"可能正在被采集"的默认设备，需要额外的防回环保护 */
const isHostPage = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
let hostMuted = false;

function updateOutputName() {
  const option = els.outputSelect.selectedOptions[0];
  els.outputName.textContent = option ? option.textContent : '默认设备';
}

async function unlockDeviceLabels() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

async function refreshOutputDevices(ask = true) {
  if (!outputSupported) {
    els.outputHint.textContent =
      '输出设备选择只能在主机的 http://localhost:3000 页面使用：浏览器在 http://局域网IP 下会禁用设备枚举。手机端直接用系统默认输出即可。';
    return;
  }

  const list = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === 'audiooutput' && device.deviceId,
    );

  let devices = await list();
  let permissionDenied = false;

  if (ask && devices.every((device) => !device.label)) {
    const granted = await unlockDeviceLabels();
    permissionDenied = !granted;
    devices = await list();
  }

  els.outputSelect.replaceChildren(new Option('默认输出', ''));
  devices.forEach((device, index) => {
    els.outputSelect.append(new Option(device.label || `输出设备 ${index + 1}`, device.deviceId));
  });

  if (!devices.length) {
    els.outputHint.textContent =
      '没有列出任何输出设备。浏览器要求先允许本页使用麦克风，才肯返回设备列表（不会录音）；允许后点「刷新设备」。';
  } else if (permissionDenied) {
    els.outputHint.textContent =
      '没能读取设备名称：麦克风权限被拒绝。点地址栏左侧的图标允许麦克风，再点「刷新设备」；也可以直接在 Windows「音量合成器」里把浏览器的输出设成真实声卡。';
  } else if (devices.every((device) => !device.label)) {
    els.outputHint.textContent =
      '已列出设备，但浏览器没有返回名称。直接按顺序选择，或允许麦克风权限后点「刷新设备」。';
  } else {
    els.outputHint.textContent = OUTPUT_HINT_DEFAULT;
  }

  if (outputDeviceId && devices.some((device) => device.deviceId === outputDeviceId)) {
    els.outputSelect.value = outputDeviceId;
  } else {
    outputDeviceId = '';
    els.outputSelect.value = '';
  }
  updateOutputName();
}

async function applyOutputDevice() {
  outputDeviceId = els.outputSelect.value;
  try {
    window.localStorage.setItem(OUTPUT_STORAGE_KEY, outputDeviceId);
  } catch {
    /* 忽略 */
  }
  updateOutputName();

  const label = els.outputSelect.selectedOptions[0]?.textContent || '';
  if (outputDeviceId && /cable|virtual|虚拟/i.test(label)) {
    els.outputHint.textContent =
      '注意：这个设备看起来是虚拟声卡，声音会被重新采集形成回环。主机监听请选真实扬声器或耳机。';
  } else {
    els.outputHint.textContent = OUTPUT_HINT_DEFAULT;
  }

  if (!scheduler) return;
  try {
    await scheduler.setOutputDevice(outputDeviceId);
    if (!outputDeviceId && isHostPage) {
      scheduler.setOutputGain(0);
      hostMuted = true;
      showError(
        '主机页面已静音：当前用的是系统默认输出，如果它正是被采集的虚拟声卡，直接播放会形成回环失真。请在「本机输出」里选择真实扬声器。',
      );
    } else if (hostMuted) {
      scheduler.setOutputGain(0.9);
      hostMuted = false;
      hideError();
    }
  } catch (err) {
    showError(`切换输出设备失败：${err.message}`);
  }
}

function setStatus(state, text) {
  els.statusDot.dataset.state = state;
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

function wsUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}`;
}

function formatSigned(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const sign = rounded < 0 ? '−' : '+';
  return `${sign}${Math.abs(rounded).toFixed(digits)}`;
}

function formatManualOffset(ms) {
  const value = Math.round(ms);
  if (value === 0) return '0 ms';
  return `${value > 0 ? '+' : '−'}${Math.abs(value)} ms`;
}

/** 拖动时只更新数字，停手 200ms 后再应用到时间线，避免拖动过程反复重排 */
function handleManualInput() {
  manualOffset = Number(els.manualRange.value) || 0;
  els.manualValue.textContent = formatManualOffset(manualOffset);
  saveManualOffset();

  clearTimeout(manualTimer);
  manualTimer = setTimeout(() => {
    manualTimer = null;
    if (scheduler) scheduler.setManualOffset(manualOffset);
  }, MANUAL_APPLY_DELAY_MS);
}

function applyManualOffsetNow() {
  clearTimeout(manualTimer);
  manualTimer = null;
  if (scheduler) scheduler.setManualOffset(manualOffset);
}

function renderResidual(value) {
  if (!Number.isFinite(value)) {
    els.residual.textContent = '—';
    delete els.residual.dataset.state;
    return;
  }
  els.residual.textContent = formatSigned(value);
  els.residual.dataset.state = Math.abs(value) > 100 ? 'alert' : '';
}

function renderClockDetail(event) {
  const rtt = Number.isFinite(event.rtt) ? event.rtt.toFixed(1) : '—';
  els.clockDetail.textContent = `offset ${formatSigned(event.offset)} ms\n往返 ${rtt} ms，${event.samples}/${event.rounds}`;
}

function render(stats) {
  els.bufferCount.textContent = `${stats.queueLength} 块 · ${stats.bufferMs ?? stats.queueLength * 20}ms`;
  els.played.textContent = String(stats.scheduled);
  els.seq.textContent = stats.lastSeq >= 0 ? `seq ${stats.lastSeq}` : 'seq —';
  els.diagnostics.textContent = `迟到 ${stats.late}，断点 ${stats.gaps}`;

  if (scheduler) {
    const info = scheduler.getOutputInfo();
    els.outputState.textContent = `音频 ${info.state} · 音量 ${Math.round(info.gain * 100)}% · 信号 ${Math.round(lastPeak / 327.68)}%`;
  } else {
    els.outputState.textContent = '未加入';
  }

  const filled = Math.min(stats.queueLength, STRIP_SIZE);
  for (let i = 0; i < cells.length; i += 1) {
    cells[i].classList.toggle('on', i < filled);
  }

  if (joined && socketOpen) {
    if (!clockSynced) {
      setStatus('connecting', '正在校准时钟');
      return;
    }
    const receiving = rtcMode || Date.now() - lastBlockAt < 600;
    setStatus(
      receiving ? 'live' : 'connecting',
      receiving ? `同步播放中${rtcMode ? ' · WebRTC' : ''}` : '已同步 · 等待主机播放',
    );
  }
}

function handleSocketStatus(event) {
  if (event.state === 'connecting') {
    socketOpen = false;
    setStatus('connecting', '正在连接主机');
    return;
  }

  if (event.state === 'open') {
    const isReconnect = !firstOpen;
    firstOpen = false;
    socketOpen = true;
    clockSynced = false;
    setStatus('connecting', '正在校准时钟');
    if (isReconnect && scheduler) scheduler.resetTimeline();
    return;
  }

  if (event.state === 'closed') {
    socketOpen = false;
    clockSynced = false;
    setStatus('connecting', '连接断开，2 秒后重连');
    return;
  }

  if (event.state === 'error') {
    socketOpen = false;
    setStatus('error', '连接出错');
    return;
  }

  if (event.state === 'clock') {
    if (Number.isFinite(event.rtt)) lastRtt = event.rtt;
    renderClockDetail(event);
    return;
  }

  if (event.state === 'synced') {
    clockSynced = true;
    if (Number.isFinite(event.rtt)) lastRtt = event.rtt;
    renderClockDetail(event);
    // 校准完成前入队的块按旧偏移算过，直接丢掉，让播放从下一块干净开始
    if (scheduler && scheduler.scheduledCount === 0) scheduler.resetTimeline();
    maybeStartRtc();
    return;
  }

  if (event.state === 'heartbeat') {
    renderResidual(event.residual);
  }
}

/**
 * 传输选择：局域网低 RTT 继续 PCM（块级精确同步），
 * 公网或 RTT 偏高时切 WebRTC/Opus（浏览器 jitter buffer，抗抖动）。
 * 可用 ?transport=rtc / ?transport=ws 强制。
 */
function maybeStartRtc() {
  if (!socket || rtcMode) return;

  const forced = new URLSearchParams(window.location.search).get('transport');
  const wantRtc =
    forced === 'rtc' || (forced !== 'ws' && Number.isFinite(lastRtt) && lastRtt > 80);
  if (!wantRtc) return;

  rtcMode = true;
  socket.startRtc((stream) => {
    if (!scheduler) return;
    scheduler.attachRemoteStream(stream);
    lastBlockAt = Date.now();
    setStatus('live', '同步播放中 · WebRTC');
  });
}

function startClockLoop() {  cancelAnimationFrame(clockFrame);
  const loop = () => {
    if (!joined || !scheduler) return;
    els.clock.textContent = scheduler.currentTime.toFixed(3);
    clockFrame = requestAnimationFrame(loop);
  };
  clockFrame = requestAnimationFrame(loop);
}

async function join() {
  if (joined) return;
  els.join.disabled = true;
  hideError();
  setStatus('connecting', '正在启用音频');

  try {
    scheduler = new SyncScheduler({
      onStats: render,
      onLog: (message) => console.info('[scheduler]', message),
    });
    // 关键：AudioContext 的创建与 resume 必须留在本次点击的同步调用栈里
    await scheduler.init();
    if (outputDeviceId) {
      try {
        await scheduler.setOutputDevice(outputDeviceId);
      } catch (err) {
        console.warn('[sync-audio] 恢复输出设备失败：', err);
      }
    } else if (isHostPage) {
      // 默认输出可能正指向被采集的虚拟声卡，先静音，等用户选好真实设备再放开
      scheduler.setOutputGain(0);
      hostMuted = true;
      showError(
        '主机页面已静音：当前用的是系统默认输出，如果它正是被采集的虚拟声卡，直接播放会形成回环失真。请在「本机输出」里选择真实扬声器。',
      );
    }
  } catch (err) {
    scheduler = null;
    els.join.disabled = false;
    setStatus('error', '音频未能启动');
    showError(err.message);
    console.error('[sync-audio] 音频初始化失败：', err);
    return;
  }

  joined = true;
  els.join.textContent = '离开同步';
  els.join.dataset.joined = 'true';
  els.join.disabled = false;
  scheduler.setManualOffset(manualOffset);
  startClockLoop();

  try {
    socket = createSyncSocket({
      url: wsUrl(),
      onBlock: (block) => {
        if (!clockSynced) return; // 校准前的块先不播，避免用错误偏移起播
        const pcm = block.pcmData;
        let peak = 0;
        for (let i = 0; i < pcm.length; i += 1) {
          const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
          if (v > peak) peak = v;
        }
        lastPeak = peak;
        lastBlockAt = Date.now();
        if (!rtcMode) scheduler.enqueue(block);
      },
      onStatus: handleSocketStatus,
    });
    socket.connect();
  } catch (err) {
    socket = null;
    setStatus('error', '无法建立连接');
    showError(`WebSocket 连接失败：${err.message}`);
  }
}

async function leave() {
  if (!joined) return;
  joined = false;
  clockSynced = false;
  rtcMode = false;
  clearTimeout(manualTimer);
  manualTimer = null;
  cancelAnimationFrame(clockFrame);
  socketOpen = false;

  if (socket) {
    socket.close();
    socket = null;
  }

  const active = scheduler;
  scheduler = null;
  if (active) await active.dispose();

  els.join.textContent = '加入同步';
  delete els.join.dataset.joined;
  setStatus('idle', '未加入');
  els.clock.textContent = '0.000';
  els.clockDetail.textContent = '等待 NTP 握手';
  renderResidual(NaN);
  render({ queueLength: 0, scheduled: 0, lastSeq: -1, late: 0, gaps: 0 });
}

els.join.addEventListener('click', () => {
  if (joined) {
    leave().catch((err) => console.error(err));
  } else {
    join().catch((err) => console.error(err));
  }
});

els.manualRange.addEventListener('input', handleManualInput);
els.manualRange.addEventListener('change', applyManualOffsetNow);

els.outputSelect.addEventListener('change', () => {
  applyOutputDevice().catch((err) => console.error(err));
});
els.outputRefresh.addEventListener('click', () => {
  refreshOutputDevices(true).catch((err) => console.error(err));
});
els.outputTest.addEventListener('click', () => {
  if (!scheduler) {
    showError('先点「加入同步」，等音频初始化后再试听');
    return;
  }
  if (!scheduler.playTestTone()) showError('音频上下文还没准备好');
});

window.addEventListener('pagehide', () => {
  if (socket) socket.close();
});

els.manualRange.value = String(manualOffset);
els.manualValue.textContent = formatManualOffset(manualOffset);

if (!outputSupported) {
  els.outputSelect.disabled = true;
  els.outputRefresh.disabled = true;
  els.outputName.textContent = '不可用';
  els.outputHint.textContent =
    '输出设备选择只能在主机的 http://localhost:3000 页面使用：浏览器在 http://局域网IP 下会禁用设备枚举。手机端直接用系统默认输出即可。';
} else {
  refreshOutputDevices(false).catch(() => {});
  updateOutputName();
}

render({ queueLength: 0, scheduled: 0, lastSeq: -1, late: 0, gaps: 0 });
