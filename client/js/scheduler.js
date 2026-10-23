'use strict';

import { estimatedServerTime } from './ws.js';

/**
 * 客户端 PCM 调度器（模块 3 / 4）
 *
 * 数据流：WS 二进制帧(Int16 PCM) + JSON 帧 → {seq, scheduledTime, pcmData}
 *         → 缓冲队列 → 每 10ms 检查队头 → 到点后 createBuffer + copyToChannel
 *         → AudioBufferSourceNode.start(when)
 *
 * 时间基准全项目统一为 Date.now() 毫秒，且只有一个来源（ws.js 里的 NTP offset）：
 *   estimatedServerTime() = Date.now() + offset
 *   when = audioCtx.currentTime + (scheduledTime - estimatedServerTime() + manualOffset) / 1000
 */

const SAMPLE_RATE = 44100;
const CHANNELS = 1;
const BLOCK_MS = 20;
/** 输出延迟补偿最多提前多少秒（iOS 等设备可能报告几十毫秒） */
const MAX_OUTPUT_LATENCY_S = 0.2;

/** 队头距离目标时刻还剩多少毫秒时开始排程（留出余量给音频线程启动） */
const DEFAULT_SCHEDULE_LEAD_MS = 60;

/**
 * 允许用 ?lead=240 调整排程提前量（20~280ms），方便对照缓冲深度：
 * 队列深度 ≈ (300ms 预缓冲 − lead) / 20ms，默认 100 时约 10 块。
 */
function resolveScheduleLeadMs() {
  try {
    const raw = new URLSearchParams(window.location.search).get('lead');
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 20 && value <= 280) return value;
  } catch {
    /* 忽略非法查询串 */
  }
  return DEFAULT_SCHEDULE_LEAD_MS;
}

/** 调度循环的检查间隔 */
const TICK_MS = 10;

/** 统计信息推送给 UI 的节流间隔 */
const STATS_INTERVAL_MS = 100;

/** 队列积压超过这个块数（25 块 = 500ms）就强行排程，防止时钟偏差导致永不消费 */
const MAX_QUEUE_BLOCKS = 25;

/** when 最多提前多少秒（正常约 0.1s，只在强制排程时才会用到） */
const MAX_SCHEDULE_AHEAD_S = 0.5;

/** 最小起播提前量，避免 when 落在过去 */
const MIN_SCHEDULE_AHEAD_S = 0.005;

const OUTPUT_GAIN = 1;

function getAudioContextCtor() {
  return window.AudioContext || window.webkitAudioContext;
}

export class SyncScheduler {
  constructor(options = {}) {
    this.onStats = options.onStats || (() => {});
    this.onLog = options.onLog || (() => {});

    this.audioCtx = null;
    this.gainNode = null;

    this.queue = [];
    this.running = false;
    this.timer = null;

    /** 手动微调（毫秒），正数表示让本机声音更晚；NTP 偏移由 ws.js 统一维护 */
    this.manualOffsetMs = 0;

    this.nextStartAt = 0;
    this.scheduledCount = 0;
    this.scheduleLeadMs = resolveScheduleLeadMs();
    this._recentUnderruns = 0;
    this._lastAdaptAt = 0;
    this.lastScheduledSeq = -1;
    this.lastArrivedSeq = -1;
    this.lateCount = 0;
    this.gapCount = 0;
    this.lastStatsAt = 0;

    /** 已 start() 但还没播完的音源，手动微调时用来停掉旧时间线 */
    this.activeSources = new Set();

    /** 'pcm' = 20ms 块调度；'rtc' = WebRTC/Opus 媒体轨 */
    this.transport = 'pcm';
    this.remoteSource = null;
  }

  get currentTime() {
    return this.audioCtx ? this.audioCtx.currentTime : 0;
  }

  setManualOffset(ms) {
    const next = Number(ms) || 0;
    const delta = next - this.manualOffsetMs;
    this.manualOffsetMs = next;
    // 只调数字不重排时间线的话，负向调整会被 nextStartAt 卡住，回音永远回不来
    if (this.audioCtx && Math.abs(delta) > 0.5) this.realign();
    this.emitStats(true);
  }

  /** 切换本机输出设备（主机监听时用来放回真实声卡），deviceId 为空表示系统默认 */
  async setOutputDevice(deviceId) {
    if (!this.audioCtx) return;
    if (typeof this.audioCtx.setSinkId !== 'function') {
      throw new Error('当前浏览器不支持切换输出设备');
    }
    await this.audioCtx.setSinkId(deviceId || '');
  }

  /** 主机页面在选好真实输出前先静音，避免把声音放回被采集的虚拟声卡形成回环 */
  setOutputGain(value) {
    if (!this.gainNode) return;
    const gain = Math.max(0, Math.min(1, Number(value) || 0));
    this.gainNode.gain.value = gain;
  }

  /**
   * 切到 WebRTC/Opus 媒体轨：停掉 PCM 块调度，把远端 MediaStream 接进同一个 gain 节点。
   * 之后的播放由浏览器 jitter buffer 负责，不再按 scheduledTime 排程。
   */
  attachRemoteStream(stream) {
    if (!this.audioCtx) return;
    this.transport = 'rtc';
    this.queue.length = 0;

    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        /* 已结束 */
      }
    }
    this.activeSources.clear();

    if (this.remoteSource) {
      try {
        this.remoteSource.disconnect();
      } catch {
        /* 忽略 */
      }
    }

    this.remoteSource = this.audioCtx.createMediaStreamSource(stream);
    this.remoteSource.connect(this.gainNode);
    this.onLog('已切换到 WebRTC/Opus 媒体轨');
    this.emitStats(true);
  }

  /** 播放一小段 440Hz，用来确认当前输出设备和音量是否正常 */
  playTestTone(frequency = 440, duration = 0.45) {    if (!this.audioCtx || !this.gainNode) return false;
    const ctx = this.audioCtx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const now = ctx.currentTime;

    osc.type = 'sine';
    osc.frequency.value = frequency;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env).connect(this.gainNode);
    osc.start(now);
    osc.stop(now + duration + 0.05);
    return true;
  }

  /** 当前音频上下文/音量，用于界面自检 */
  getOutputInfo() {
    return {
      state: this.audioCtx ? this.audioCtx.state : 'closed',
      gain: this.gainNode ? this.gainNode.gain.value : 0,
      sinkId: this.audioCtx && this.audioCtx.sinkId ? this.audioCtx.sinkId : '',
    };
  }

  /** 手动微调后重新对齐：停掉已排程的旧音源，下一块按新偏移从当前时刻起算 */
  realign() {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        /* 已经结束 */
      }
    }
    this.activeSources.clear();
    if (this.audioCtx) this.nextStartAt = this.audioCtx.currentTime;
    this.onLog(`手动偏移 ${this.manualOffsetMs} ms，时间线重新对齐`);
  }

  /**
   * 创建并启动 AudioContext。
   * 必须在用户手势（click/touch）的同一个任务里调用，否则会被自动播放策略拦截。
   */
  async init() {
    const Ctor = getAudioContextCtor();
    if (!Ctor) {
      throw new Error('当前浏览器不支持 Web Audio API（AudioContext 不可用）');
    }

    if (!this.audioCtx) {
      let ctx;
      try {
        // 尽量让上下文就落在 44100Hz，省掉 44.1k→48k 的逐块重采样
        ctx = new Ctor({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      } catch {
        ctx = new Ctor();
      }
      this.audioCtx = ctx;
      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = OUTPUT_GAIN;
      this.gainNode.connect(ctx.destination);
    }

    if (this.audioCtx.state !== 'running') {
      await this.audioCtx.resume();
    }
    if (this.audioCtx.state !== 'running') {
      throw new Error(
        `AudioContext 处于 ${this.audioCtx.state} 状态：浏览器拦截了自动播放。` +
          'AudioContext 必须在「加入同步」按钮的点击回调里同步创建，且随后调用 resume()。',
      );
    }

    this.nextStartAt = this.audioCtx.currentTime;
    this.running = true;
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }
    this.emitStats(true);
  }

  /** 把一块 PCM 放入队列 */
  enqueue(block) {
    if (!this.running) return;
    if (this.transport === 'rtc') return;
    const { seq, scheduledTime, pcmData } = block || {};
    if (typeof seq !== 'number' || typeof scheduledTime !== 'number' || !pcmData) return;

    if (this.lastArrivedSeq >= 0 && seq !== 0 && seq !== this.lastArrivedSeq + 1) {
      this.gapCount += 1;
      this.onLog(`收到不连续的 seq：${this.lastArrivedSeq} → ${seq}`);
    }
    this.lastArrivedSeq = seq;

    this.queue.push({ seq, scheduledTime, pcmData });
    this.emitStats();
  }

  /** 连接重建时重置时间线，避免旧数据造成错位 */
  resetTimeline() {
    this.queue.length = 0;
    this.lastArrivedSeq = -1;
    if (this.audioCtx) this.nextStartAt = this.audioCtx.currentTime;
    this.onLog('时间线已重置');
  }

  tick() {
    if (!this.running || !this.audioCtx) return;

    const now = estimatedServerTime();
    let guard = 0;

    while (this.queue.length > 0 && guard < 8) {
      const head = this.queue[0];
      const rawLeadMs = head.scheduledTime - now;
      const leadMs = rawLeadMs + this.manualOffsetMs;
      const underPressure = this.queue.length >= MAX_QUEUE_BLOCKS;

      if (leadMs > this.scheduleLeadMs && !underPressure) break;

      this.queue.shift();
      this.scheduleBlock(head, leadMs, rawLeadMs);
      guard += 1;
    }

    this.adaptBuffer();
    this.emitStats();
  }

  /**
   * 自适应抖动缓冲：出现"数据晚到"就把排程阈值调小（多留缓冲），
   * 稳定一段时间后再慢慢收紧，兼顾公网抖动和延迟。
   */
  adaptBuffer() {
    const now = Date.now();
    if (now - this._lastAdaptAt < 5000) return;
    this._lastAdaptAt = now;

    if (this._recentUnderruns > 0) {
      this.scheduleLeadMs = Math.max(20, this.scheduleLeadMs - 10);
      this._recentUnderruns = 0;
    } else {
      this.scheduleLeadMs = Math.min(100, this.scheduleLeadMs + 5);
    }
  }

  scheduleBlock(block, leadMs, rawLeadMs) {
    const ctx = this.audioCtx;
    const pcm = block.pcmData;

    if (!pcm || pcm.length === 0) return;

    // Int16 → Float32（[-1, 1]），再 copyToChannel
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      floats[i] = pcm[i] / 32768;
    }

    const buffer = ctx.createBuffer(CHANNELS, pcm.length, SAMPLE_RATE);
    buffer.copyToChannel(floats, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);

    let aheadSeconds = leadMs / 1000;
    if (aheadSeconds < MIN_SCHEDULE_AHEAD_S) aheadSeconds = MIN_SCHEDULE_AHEAD_S;
    if (aheadSeconds > MAX_SCHEDULE_AHEAD_S) aheadSeconds = MAX_SCHEDULE_AHEAD_S;

    // 系统/浏览器的输出延迟（iOS 上常见 30–80ms）会让"实际出声"晚于 when，
    // 把起播时刻整体提前，才能让听到的时刻对上 scheduledTime。
    // 只用 outputLatency：baseLatency 只是处理缓冲，拿它补偿会过度提前。
    const outputLatency = Math.min(
      MAX_OUTPUT_LATENCY_S,
      Math.max(0, ctx.outputLatency || 0),
    );
    this.outputLatencySeconds = outputLatency;

    let when = ctx.currentTime + aheadSeconds - outputLatency;
    // 保证与上一块首尾相接，绝不重叠（重叠会让波形叠加失真）
    if (when < this.nextStartAt) when = this.nextStartAt;
    if (when < ctx.currentTime + MIN_SCHEDULE_AHEAD_S) {
      when = ctx.currentTime + MIN_SCHEDULE_AHEAD_S;
    }

    source.start(when);
    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);
    this.nextStartAt = when + buffer.duration;

    if (rawLeadMs < 0) {
      this.lateCount += 1;
      this._recentUnderruns += 1;
    }

    this.scheduledCount += 1;
    this.lastScheduledSeq = block.seq;
  }

  emitStats(force = false) {
    const now = Date.now();
    if (!force && now - this.lastStatsAt < STATS_INTERVAL_MS) return;
    this.lastStatsAt = now;

    this.onStats({
      state: this.audioCtx ? this.audioCtx.state : 'closed',
      queueLength: this.queue.length,
      scheduled: this.scheduledCount,
      lastSeq: this.lastScheduledSeq,
      currentTime: this.currentTime,
      late: this.lateCount,
      gaps: this.gapCount,
      bufferMs: this.queue.length * BLOCK_MS,
      leadMs: this.scheduleLeadMs,
      outputLatencyMs: Math.round((this.outputLatencySeconds || 0) * 1000),
    });
  }

  async dispose() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue.length = 0;

    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        /* 忽略 */
      }
    }
    this.activeSources.clear();

    if (this.remoteSource) {
      try {
        this.remoteSource.disconnect();
      } catch {
        /* 忽略 */
      }
      this.remoteSource = null;
    }

    const ctx = this.audioCtx;
    this.audioCtx = null;
    this.gainNode = null;
    this.scheduledCount = 0;
    this.lastScheduledSeq = -1;
    this.lastArrivedSeq = -1;

    if (ctx) {
      try {
        await ctx.close();
      } catch {
        /* 已关闭则忽略 */
      }
    }
    this.emitStats(true);
  }
}

export const CONSTANTS = {
  SAMPLE_RATE,
  CHANNELS,
  DEFAULT_SCHEDULE_LEAD_MS,
  TICK_MS,
  MAX_QUEUE_BLOCKS,
};
