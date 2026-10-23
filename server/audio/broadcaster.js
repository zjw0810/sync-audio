'use strict';

/**
 * PCM 分块广播器。
 *
 * 职责：
 *   - 消费 decoder 的 stdout，攒够 1764 字节（44100Hz / 单声道 / 16bit / 20ms）切一块；
 *   - 以 20ms 的节拍实速送出（FFmpeg 不加 -re，节拍由这里控制，否则整首歌会在几秒内灌完）；
 *   - 每块先发二进制 PCM 帧，紧接着发 JSON 元数据帧；
 *   - scheduledTime = 广播时刻的 Date.now() + 300（预缓冲 300ms）。
 */

const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { Mp3Decoder, SystemCapture } = require('./decoder');

const SAMPLE_RATE = 44100;
const CHANNELS = 1;
const BLOCK_DURATION_MS = 20;
const PRE_BUFFER_MS = 300;
const BYTES_PER_SAMPLE = 2;

/** 44100 × 0.02 × 1 × 2 = 1764 字节 */
const BLOCK_BYTES = SAMPLE_RATE * (BLOCK_DURATION_MS / 1000) * CHANNELS * BYTES_PER_SAMPLE;

const LOG_EVERY_BLOCKS = 50;
const START_TIMEOUT_MS = 5000;
const MAX_CLIENT_BUFFERED_BYTES = 2 * 1024 * 1024; // 客户端积压超过 2MB 就跳过，避免内存膨胀

/** 本机声音是实时源，预缓冲比文件播放小一些，端到端延迟更低；公网可调大 */
const LIVE_PRE_BUFFER_MS = Math.max(80, Number(process.env.SYNC_LIVE_PREBUFFER_MS) || 150);

/** 采集链路允许囤积的上限，超过就丢弃最旧的数据，避免延迟无限增长 */
const BLOCK_SAMPLES = Math.round(SAMPLE_RATE * (BLOCK_DURATION_MS / 1000));
const MAX_BACKLOG_MS = 300;
const KEEP_BACKLOG_MS = 100;

/**
 * 声卡时钟与系统时钟的偏差补偿。
 *
 * 实测默认播放设备每秒多输出约 0.16% 的样本，直接按 44100 切块会让积压慢慢涨。
 * 这里按「实测输入速率」做连续线性重采样，把输出拉回严格 44100 样本/秒，
 * 代价只是 0.16% 的音高偏移（约 2.7 音分，听不出来），没有丢音、没有跳音。
 */
class DriftCompensator {
  constructor() {
    this.samples = new Int16Array(0);
    this.pos = 0;
    this.inputSamples = 0;
    this.ratio = 1;
    this.startedAt = Date.now();
    this.measureBase = null;
  }

  pushBytes(chunk) {
    const count = chunk.length >> 1;
    if (count <= 0) return;

    const start = this.samples.length;
    const next = new Int16Array(start + count);
    next.set(this.samples, 0);
    // 逐样本读，避免 Buffer 的 byteOffset 不是 2 的倍数时 Int16Array 视图抛错
    for (let i = 0; i < count; i += 1) {
      next[start + i] = chunk.readInt16LE(i * 2);
    }
    this.samples = next;
    this.inputSamples += count;

    this.updateRatio();
  }

  updateRatio() {
    const now = Date.now();
    const elapsed = now - this.startedAt;
    if (elapsed < 4000) return; // 跳过启动阶段的管道突发

    if (!this.measureBase) {
      this.measureBase = { at: now, samples: this.inputSamples };
      this.lastUpdateAt = now;
      return;
    }

    // 累积窗口：窗口越长噪声越小，避免 ratio 抖动造成音高颤动
    if (now - this.measureBase.at < 5000) return;
    if (now - this.lastUpdateAt < 2000) return;
    this.lastUpdateAt = now;

    const measured =
      ((this.inputSamples - this.measureBase.samples) / (now - this.measureBase.at)) * 1000;
    if (!Number.isFinite(measured) || measured < 8000 || measured > 384000) return;

    const target = SAMPLE_RATE / measured;
    this.ratio = this.ratio * 0.7 + target * 0.3;
  }

  available() {
    if (this.samples.length < 2) return 0;
    return Math.floor((this.samples.length - this.pos - 1) / this.ratio);
  }

  read(count) {
    const out = new Int16Array(count);
    const data = this.samples;
    let pos = this.pos;

    for (let i = 0; i < count; i += 1) {
      const index = Math.floor(pos);
      const frac = pos - index;
      const a = data[index];
      const b = data[index + 1];
      out[i] = a + (b - a) * frac;
      pos += this.ratio;
    }

    this.pos = pos;
    const drop = Math.floor(this.pos);
    if (drop > 4096) {
      this.samples = this.samples.slice(drop);
      this.pos -= drop;
    }
    return out;
  }

  backlogMs() {
    return ((this.samples.length - this.pos) / SAMPLE_RATE) * 1000;
  }

  trim(keepMs) {
    const keep = Math.round((keepMs / 1000) * SAMPLE_RATE);
    const drop = this.samples.length - keep;
    if (drop <= 0) return 0;
    this.samples = this.samples.slice(drop);
    this.pos = Math.max(0, this.pos - drop);
    return drop;
  }
}

class Broadcaster extends EventEmitter {
  /**
   * @param {import('ws').WebSocketServer} wss
   * @param {{log?: Function, logError?: Function}} [options]
   */
  constructor(wss, options = {}) {
    super();
    this.wss = wss;
    this.log = options.log || console.log;
    this.logError = options.logError || console.error;

    this.playing = false;
    this.filename = null;
    this.deviceName = null;
    this.seq = 0;
    this.startedAt = 0;

    this._token = null;
    this._decoder = null;
    this._runPromise = null;
    this._startTimer = null;
  }

  get clientCount() {
    return this.wss.clients.size;
  }

  /** 播放一个 MP3 文件；等到第一块送出后返回。options.startAtMs 用于暂停后续播。 */
  async play(filePath, filename, options = {}) {
    const source = new Mp3Decoder(filePath, options);
    return this.startSource(source, { label: filename, kind: 'file' });
  }

  /** 共享本机默认播放设备的声音（WASAPI 环回），不等待首块：系统静音时本来就没有数据。 */
  async playSystem() {
    const source = new SystemCapture();
    return this.startSource(source, { label: '本机声音', kind: 'system', preBufferMs: LIVE_PRE_BUFFER_MS });
  }

  /**
   * 启动任意音源并开始广播。
   * @param {object} source 需具备 start/stdout/stop/waitExit，且是 EventEmitter
   * @param {{label: string, kind: 'file'|'system', preBufferMs?: number}} meta
   */
  async startSource(source, { label, kind, preBufferMs = PRE_BUFFER_MS }) {
    if (this.playing) await this.stop('被新的音源替换');

    const token = { aborted: false, wake: null };

    this._token = token;
    this._decoder = source;
    this.filename = label;
    this.sourceKind = kind;
    this.preBufferMs = preBufferMs;
    this.seq = 0;
    this.playing = true;
    this.startedAt = Date.now();

    let resolveStarted = () => {};
    let rejectStarted = () => {};
    const startedPromise = new Promise((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    startedPromise.catch(() => {}); // 未等待时可能被 reject，先兜住

    // 采集链路可能在 start() 之前就报错（编译失败、找不到设备）
    let rejectBoot;
    const bootError = new Promise((_, reject) => {
      rejectBoot = reject;
    });
    bootError.catch(() => {});
    const onBootError = (err) => rejectBoot(err);
    source.once('error', onBootError);

    try {
      source.start();
      if (kind === 'system') {
        this.deviceName = (source.format && source.format.name) || '';
      }
    } catch (err) {
      source.removeListener('error', onBootError);
      this.playing = false;
      this._token = null;
      this._decoder = null;
      throw err;
    }

    this._runPromise = this._run(token, source, { resolveStarted, rejectStarted });

    if (kind === 'system') {
      await Promise.race([
        bootError,
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 400);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ])
        .then(() => {
          source.removeListener('error', onBootError);
          this.log(
            'BROADCAST',
            `开始共享${label}（${source.describe ? source.describe() : ''}），在线客户端 ${this.clientCount} 个`,
          );
        })
        .catch(async (err) => {
          source.removeListener('error', onBootError);
          await this.stop('启动失败');
          throw err;
        });
      return;
    }

    const timeoutPromise = new Promise((_, reject) => {
      this._startTimer = setTimeout(() => {
        reject(new Error(`等待 FFmpeg 输出 PCM 超时（${START_TIMEOUT_MS}ms），请检查文件是否损坏`));
      }, START_TIMEOUT_MS);
      if (typeof this._startTimer.unref === 'function') this._startTimer.unref();
    });

    this.log(
      'BROADCAST',
      `开始解码 ${label}，在线客户端 ${this.clientCount} 个${this.clientCount === 0 ? '（暂无接收端，仍按实时节拍推进）' : ''}`,
    );

    try {
      await Promise.race([startedPromise, timeoutPromise]);
    } catch (err) {
      await this.stop('启动失败');
      throw err;
    } finally {
      clearTimeout(this._startTimer);
      this._startTimer = null;
      source.removeListener('error', onBootError);
    }
  }

  async stop(reason = '手动停止') {
    const token = this._token;
    const decoder = this._decoder;
    const wasPlaying = this.playing;

    this._token = null;
    this._decoder = null;
    this.playing = false;

    if (token) {
      token.aborted = true;
      if (typeof token.wake === 'function') token.wake();
    }
    if (decoder) decoder.stop();

    if (wasPlaying) {
      this.log('BROADCAST', `停止播放 ${this.filename}（${reason}），已广播 ${this.seq + 1} 块`);
      this.emit('stop', { filename: this.filename, seq: this.seq });
    }
  }

  _sleep(ms, token) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        token.wake = null;
        resolve(true);
      }, ms);
      token.wake = () => {
        clearTimeout(timer);
        token.wake = null;
        resolve(false);
      };
    });
  }

  async _run(token, source, { resolveStarted, rejectStarted }) {
    const isCurrent = () => this._token === token;
    const isSystem = this.sourceKind === 'system';
    const resampler = isSystem ? new DriftCompensator() : null;

    let buffer = Buffer.alloc(0);
    let seq = 0;
    let sent = 0;
    let firstBlockSent = false;
    let baseTime = 0;
    let failure = null;

    const fail = (err) => {
      // 主动 stop() 会中止 stdout 读取，这种错误不是故障
      if (token.aborted || !isCurrent()) return;
      failure = err;
      if (!firstBlockSent) {
        rejectStarted(err);
        this.logError('BROADCAST', `采集流读取失败: ${err.message}`);
      } else {
        this.logError('BROADCAST', `播流出错: ${err.message}`);
      }
    };

    source.on('error', fail);

    const emit = (block) => {
      this._sendBlock(block, seq);
      this.seq = seq;
      sent += 1;
      seq += 1;
      if (!firstBlockSent) {
        firstBlockSent = true;
        resolveStarted();
      }
    };

    // 以首块到达时刻为节拍基准，按 20ms 绝对时间推进，避免累积漂移
    const waitForSlot = async () => {
      if (baseTime === 0) baseTime = Date.now();
      const targetAt = baseTime + seq * BLOCK_DURATION_MS;
      const wait = targetAt - Date.now();
      if (wait <= 0) return true;
      const slept = await this._sleep(wait, token);
      return slept && !token.aborted && isCurrent();
    };

    try {
      for await (const chunk of source.stdout) {
        if (token.aborted || !isCurrent()) break;

        if (resampler) {
          resampler.pushBytes(chunk);

          while (resampler.available() >= BLOCK_SAMPLES) {
            if (token.aborted || !isCurrent()) break;
            if (!(await waitForSlot())) break;

            const pcm = resampler.read(BLOCK_SAMPLES);
            emit(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          }

          // 重采样已经把速率拉回实时，这里只是兜底，正常不会触发
          if (resampler.backlogMs() > MAX_BACKLOG_MS) {
            const dropped = resampler.trim(KEEP_BACKLOG_MS);
            if (dropped > 0 && (!this._lastTrimAt || Date.now() - this._lastTrimAt > 10000)) {
              this._lastTrimAt = Date.now();
              this.log(
                'BROADCAST',
                `时钟补偿 ${resampler.ratio.toFixed(4)}×，仍积压 ${dropped} 样本已丢弃`,
              );
            }
          }

          if (!this._lastRatioLog || Math.abs(this._lastRatioLog - resampler.ratio) > 0.0002) {
            this._lastRatioLog = resampler.ratio;
            this.log(
              'BROADCAST',
              `采样时钟补偿 ${resampler.ratio.toFixed(5)}×（约 ${Math.round(SAMPLE_RATE / resampler.ratio)} 样本/秒），积压 ${resampler.backlogMs().toFixed(0)}ms`,
            );
          }
          continue;
        }

        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

        while (buffer.length >= BLOCK_BYTES) {
          if (token.aborted || !isCurrent()) break;
          if (!(await waitForSlot())) break;

          const block = buffer.subarray(0, BLOCK_BYTES);
          buffer = buffer.subarray(BLOCK_BYTES);
          emit(block);
        }
      }
    } catch (err) {
      if (!token.aborted) fail(err);
    }

    const exit = await source.waitExit();
    const tailBytes = buffer.length;
    const elapsedMs = Date.now() - this.startedAt;

    // 已被新的播放替换：状态归新播放管理，不在这里收尾
    if (!isCurrent()) return;

    this.playing = false;
    this._token = null;
    this._decoder = null;

    // 文件还没吐出任何 PCM 就退出了：把错误交给 play()，不要干等超时
    if (!isSystem && !firstBlockSent && exit.code !== 0 && failure === null) {
      const hint = String(exit.stderr || '')
        .trim()
        .split(/\r?\n/)
        .slice(-2)
        .join(' | ');
      const error = new Error(
        `FFmpeg 未能输出 PCM（退出码 ${exit.code}）${hint ? `: ${hint}` : '，请确认文件是有效的 MP3'}`,
      );
      rejectStarted(error);
      this.logError('BROADCAST', `${this.filename} 启动失败：FFmpeg 退出码 ${exit.code}`);
      return;
    }

    if (failure) {
      this.logError('BROADCAST', `播放失败 ${this.filename}: ${failure.message}`);
      this.emit('end', {
        filename: this.filename,
        seq: sent,
        kind: this.sourceKind,
        error: failure,
      });
      return;
    }

    const tailNote = tailBytes > 0 ? `，尾部 ${tailBytes} 字节不足 20ms 已丢弃` : '';

    if (exit.code === 0) {
      this.log(
        'BROADCAST',
        isSystem
          ? `本机声音采集结束：共 ${sent} 块`
          : `播放结束 ${this.filename}：共 ${sent} 块，用时 ${(elapsedMs / 1000).toFixed(1)}s${tailNote}`,
      );
      this.emit('end', { filename: this.filename, seq: sent, kind: this.sourceKind });
    } else {
      const hint = String(exit.stderr || '')
        .trim()
        .split(/\r?\n/)
        .slice(-3)
        .join(' | ');
      this.logError(
        'BROADCAST',
        isSystem
          ? `本机声音采集中断 code=${exit.code}${hint ? `：${hint}` : ''}`
          : `ffmpeg 异常退出 code=${exit.code} signal=${exit.signal}${hint ? `：${hint}` : ''}`,
      );
      this.emit('end', {
        filename: this.filename,
        seq: sent,
        kind: this.sourceKind,
        error: new Error(`ffmpeg 退出码 ${exit.code}`),
      });
    }
  }

  /** 先二进制帧，再 JSON 帧；两帧在同一个事件循环 tick 内背靠背发出。 */
  _sendBlock(block, seq) {
    const scheduledTime = Date.now() + this.preBufferMs;

    let peak = 0;
    for (let i = 0; i + 1 < block.length; i += 2) {
      const v = block.readInt16LE(i);
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
    this.lastPeak = peak;

    // WebRTC 出口复用同一份 PCM
    this.emit('pcm', block);
    const meta = JSON.stringify({
      seq,
      scheduledTime,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      blockDurationMs: BLOCK_DURATION_MS,
    });

    let delivered = 0;
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) continue; // 慢客户端丢帧，避免内存堆积
      try {
        client.send(block, { binary: true });
        client.send(meta);
        delivered += 1;
      } catch (err) {
        this.logError('BROADCAST', `发送失败: ${err.message}`);
      }
    }

    this.emit('block', { seq, scheduledTime, delivered });

    if ((seq + 1) % LOG_EVERY_BLOCKS === 0 && delivered > 0) {
      this.log('BROADCAST', `广播 seq=${seq}, scheduledTime=${scheduledTime}`);
    }
  }
}

module.exports = {
  Broadcaster,
  DriftCompensator,
  BLOCK_BYTES,
  SAMPLE_RATE,
  CHANNELS,
  BLOCK_DURATION_MS,
  PRE_BUFFER_MS,
};
