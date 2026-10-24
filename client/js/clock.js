'use strict';

/**
 * 时钟同步的纯函数：没有 DOM/WebSocket 依赖，方便单测。
 *
 * 约定：服务端时间 = 客户端 Date.now() + offset。
 * 一次往返（t1 发送、t2 服务端回包、t3 收到）的偏移估计：
 *   offset = ((t2 - t1) + (t2 - t3)) / 2
 */

export function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeOffset(t1, t2, t3) {
  return (t2 - t1 + (t2 - t3)) / 2;
}

export function computeRtt(t1, t3) {
  return t3 - t1;
}

/** 取 RTT 最小的样本；样本为空时返回 null */
export function bestByRtt(samples, rtts) {
  if (!samples || samples.length === 0) return null;
  let bestIndex = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (rtts[i] < rtts[bestIndex]) bestIndex = i;
  }
  return { sample: samples[bestIndex], rtt: rtts[bestIndex], index: bestIndex };
}

/** 重同步时的渐进修正：偏差过大直接采用，否则按 30% 靠拢，避免跳变 */
export function smoothOffset(current, sample) {
  const diff = sample - current;
  return Math.abs(diff) > 100 ? sample : current + diff * 0.3;
}
