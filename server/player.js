'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./http/body');

const TRACK_PATTERN = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;

/**
 * 播放器状态机：音源（本机声音 / 曲库）、暂停、曲目切换。
 * 只依赖 Broadcaster 和 SystemShare，不碰 HTTP/WebSocket。
 */
class Player {
  constructor({ broadcaster, systemShare, uploadDir, log, logError }) {
    this.broadcaster = broadcaster;
    this.systemShare = systemShare;
    this.uploadDir = uploadDir;
    this.log = log || console.log;
    this.logError = logError || console.error;

    this.source = 'system'; // 'system' | 'library'
    this.paused = false;
    this.pausedFile = null;
    this.pausedPositionMs = 0;
    this.advanceTimer = null;
  }

  listTracks() {
    try {
      return fs
        .readdirSync(this.uploadDir)
        .filter((name) => TRACK_PATTERN.test(name))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } catch {
      return [];
    }
  }

  nowPlaying() {
    const tracks = this.listTracks();
    const file = this.paused
      ? this.pausedFile
      : this.broadcaster.sourceKind === 'file'
        ? this.broadcaster.filename
        : null;
    const mode = this.paused
      ? 'paused'
      : this.broadcaster.playing
        ? this.broadcaster.sourceKind === 'file'
          ? 'file'
          : 'system'
        : 'idle';

    return {
      mode,
      source: this.source,
      paused: this.paused,
      filename: file,
      index: file ? tracks.indexOf(file) : -1,
      total: tracks.length,
      playing: this.broadcaster.playing,
    };
  }

  /** 播放指定文件；startAtMs 用于暂停后续播 */
  async playFile(filePath, filename, options = {}) {
    await this.broadcaster.play(filePath, filename, options);
    this.source = 'library';
    this.paused = false;
    this.pausedFile = null;
    return this.nowPlaying();
  }

  /** 上一首 / 下一首；当前不是文件时，next 从第一首、prev 从最后一首开始 */
  async playAdjacent(direction) {
    const tracks = this.listTracks();
    if (tracks.length === 0) {
      throw new HttpError(404, '曲库为空，请先上传音乐');
    }

    const isFile = this.broadcaster.sourceKind === 'file';
    const current = isFile ? tracks.indexOf(this.broadcaster.filename) : -1;

    let next;
    if (current === -1) {
      next = direction > 0 ? 0 : tracks.length - 1;
    } else {
      next = (current + direction + tracks.length) % tracks.length;
    }

    const filename = tracks[next];
    await this.broadcaster.play(path.join(this.uploadDir, filename), filename);
    this.source = 'library';
    this.paused = false;
    this.pausedFile = null;
    this.log('PLAY', `切换曲目 -> ${filename}（${next + 1}/${tracks.length}）`);
    return { filename, index: next, total: tracks.length };
  }

  async startSystem(reason = 'manual') {
    const ok = await this.systemShare.start(reason);
    if (ok) {
      this.source = 'system';
      this.paused = false;
      this.pausedFile = null;
    }
    return ok;
  }

  async pause(wantPaused = !this.paused) {
    if (wantPaused === this.paused) return this.nowPlaying();

    if (wantPaused) {
      if (this.broadcaster.playing) {
        if (this.broadcaster.sourceKind === 'file') {
          this.pausedFile = this.broadcaster.filename;
          this.pausedPositionMs = Math.max(0, (this.broadcaster.seq + 1) * 20);
        } else {
          this.pausedFile = null;
        }
        await this.broadcaster.stop('暂停');
      }
      this.paused = true;
      this.log('PLAY', '已暂停');
    } else {
      this.paused = false;
      if (this.source === 'library' && this.pausedFile) {
        await this.broadcaster.play(path.join(this.uploadDir, this.pausedFile), this.pausedFile, {
          startAtMs: this.pausedPositionMs,
        });
        this.log(
          'PLAY',
          `继续播放 ${this.pausedFile}（从 ${(this.pausedPositionMs / 1000).toFixed(1)}s）`,
        );
      } else {
        await this.startSystem('resume');
      }
    }

    return this.nowPlaying();
  }

  async setSource(source) {
    if (source === 'system') {
      await this.startSystem('manual');
    } else if (source === 'library') {
      if (this.listTracks().length === 0) {
        throw new HttpError(404, '曲库为空，请先上传音乐');
      }
      if (!(this.broadcaster.playing && this.broadcaster.sourceKind === 'file')) {
        await this.playAdjacent(1);
      }
      this.source = 'library';
      this.paused = false;
    } else {
      throw new HttpError(400, 'source 只能是 system 或 library');
    }
    return this.nowPlaying();
  }

  /** 一键停止当前音源（不改变 source 选择） */
  async stop(reason = '手动停止') {
    await this.broadcaster.stop(reason);
    this.paused = false;
  }

  /** 播放器收到 Broadcaster 的 end 事件 */
  handleEnd(info) {
    if (info.kind !== 'file') return;

    if (info.error) {
      this.logError('PLAY', `${info.filename} 播放失败: ${info.error.message}`);
    } else {
      this.log('PLAY', `${info.filename} 播放完成，共 ${info.seq} 块`);
    }

    const hasTracks = !info.error && this.listTracks().length > 0;
    if (hasTracks) {
      if (this.advanceTimer) clearTimeout(this.advanceTimer);
      this.advanceTimer = setTimeout(() => {
        this.advanceTimer = null;
        this.playAdjacent(1).catch((err) => {
          this.logError('PLAY', `自动切换下一首失败: ${err.message}`);
          this.startSystem('after-file').catch(() => {});
        });
      }, 300);
      if (typeof this.advanceTimer.unref === 'function') this.advanceTimer.unref();
      return;
    }

    this.startSystem('after-file').catch(() => {});
  }

  dispose() {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
  }
}

module.exports = { Player, TRACK_PATTERN };
