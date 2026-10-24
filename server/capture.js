'use strict';

const { ensureLoopbackHelper, readDefaultRenderFormat } = require('./audio/decoder');

const WATCH_INTERVAL_MS = 5000;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60000;

/**
 * 本机声音共享的生命周期：启动、失败退避重试、默认设备切换后重新采集。
 * 是否应该保持共享由外部注入的 shouldRun() 决定（暂停/切到曲库时不重启）。
 */
class SystemShare {
  constructor({ broadcaster, shouldRun, log, logError }) {
    this.broadcaster = broadcaster;
    this.shouldRun = shouldRun || (() => true);
    this.log = log || console.log;
    this.logError = logError || console.error;

    this.retryTimer = null;
    this.watchTimer = null;
    this.attempts = 0;
    this.shuttingDown = false;

    this.broadcaster.on('end', (info) => this.handleEnd(info));
  }

  async start(reason = 'startup') {
    if (this.shuttingDown) return false;
    this.clearRetry();

    try {
      await this.broadcaster.playSystem();
      this.attempts = 0;
      this.log('SHARE', `已开始共享本机声音（${reason}）`);
      return true;
    } catch (err) {
      this.attempts += 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this.attempts - 1, 4));
      this.logError(
        'SHARE',
        `本机声音共享启动失败: ${err.message}（${Math.round(delay / 1000)} 秒后重试）`,
      );
      this.scheduleRetry(delay);
      return false;
    }
  }

  scheduleRetry(delay) {
    if (this.shuttingDown) return;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start('retry');
    }, delay);
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
  }

  clearRetry() {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  handleEnd(info) {
    if (info.kind !== 'system') return;
    if (info.error) this.logError('SHARE', `本机声音采集中断: ${info.error.message}`);
    if (this.shuttingDown) return;
    if (!this.shouldRun()) return;
    this.scheduleRetry(2000);
  }

  /** 每 5 秒检查默认播放设备是否被换掉 */
  startWatch() {
    if (this.watchTimer || this.shuttingDown) return;
    const tick = async () => {
      if (this.shuttingDown) return;
      this.watchTimer = setTimeout(tick, WATCH_INTERVAL_MS);
      if (typeof this.watchTimer.unref === 'function') this.watchTimer.unref();

      if (!this.shouldRun()) return;
      if (!this.broadcaster.playing || this.broadcaster.sourceKind !== 'system') return;

      try {
        const info = readDefaultRenderFormat(ensureLoopbackHelper());
        if (info.name && this.broadcaster.deviceName && info.name !== this.broadcaster.deviceName) {
          this.log(
            'SHARE',
            `默认播放设备已切换：「${this.broadcaster.deviceName}」→「${info.name}」，重新采集`,
          );
          await this.broadcaster.playSystem();
        }
      } catch {
        /* 设备枚举偶尔失败，下一轮再试 */
      }
    };
    tick();
  }

  shutdown() {
    this.shuttingDown = true;
    this.clearRetry();
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
  }
}

module.exports = { SystemShare };
