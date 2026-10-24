'use strict';

/**
 * 轻量度量：供 /metrics（Prometheus 文本格式）和 /status 使用。
 * 只保留排查同步问题真正需要的指标，不做通用 metrics 框架。
 */
class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.blocksTotal = 0;
    this.clients = 0;
    this.rtcPeers = 0;
    this.driftRatio = 1;
    this.clientStats = new Map(); // id -> {bufferMs, late, underruns, scheduleErrorMs, rtc, at}
  }

  incBlocks(count = 1) {
    this.blocksTotal += count;
  }

  setClients(count) {
    this.clients = count;
  }

  setRtcPeers(count) {
    this.rtcPeers = count;
  }

  setDriftRatio(ratio) {
    if (Number.isFinite(ratio) && ratio > 0) this.driftRatio = ratio;
  }

  updateClient(id, stats) {
    this.clientStats.set(id, { ...stats, at: Date.now() });
  }

  removeClient(id) {
    this.clientStats.delete(id);
  }

  snapshot() {
    const clientStats = [];
    for (const [id, stats] of this.clientStats) {
      clientStats.push({ id, ...stats });
    }
    return {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      clients: this.clients,
      rtcPeers: this.rtcPeers,
      blocksTotal: this.blocksTotal,
      driftRatio: Number(this.driftRatio.toFixed(5)),
      clientStats,
    };
  }

  render() {
    const lines = [];
    const metric = (name, help, type, value) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${value}`);
    };

    metric('sync_audio_clients', '当前在线客户端数', 'gauge', this.clients);
    metric('sync_audio_rtc_peers', '当前 WebRTC 接收端数量', 'gauge', this.rtcPeers);
    metric('sync_audio_blocks_total', '累计广播的 20ms PCM 块数', 'counter', this.blocksTotal);
    metric(
      'sync_audio_uptime_seconds',
      '服务运行时长',
      'gauge',
      Math.round((Date.now() - this.startedAt) / 1000),
    );
    metric('sync_audio_drift_ratio', '采样时钟补偿比率（1 表示无漂移）', 'gauge', this.driftRatio.toFixed(5));

    for (const [id, stats] of this.clientStats) {
      const label = `{client="${id}"}`;
      lines.push(`sync_audio_client_buffer_ms${label} ${stats.bufferMs ?? 0}`);
      lines.push(`sync_audio_client_late_blocks_total${label} ${stats.late ?? 0}`);
      lines.push(`sync_audio_client_underruns_total${label} ${stats.underruns ?? 0}`);
      lines.push(`sync_audio_client_schedule_error_ms${label} ${stats.scheduleErrorMs ?? 0}`);
      lines.push(`sync_audio_client_rtc${label} ${stats.rtc ? 1 : 0}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

module.exports = { Metrics };
