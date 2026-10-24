'use strict';

/**
 * 44.1kHz -> 48kHz 线性重采样，按 960 样本（20ms@48k）一帧输出。
 * 从 rtc.js 抽出，便于单测。
 */
class LinearResampler {
  constructor({ inputRate, outputRate, frameSize }) {
    this.step = inputRate / outputRate;
    this.frameSize = frameSize;
    this.samples = new Int16Array(0);
    this.pos = 0;
  }

  push(block) {
    const count = block.length >> 1;
    if (count <= 0) return;

    const start = this.samples.length;
    const next = new Int16Array(start + count);
    next.set(this.samples, 0);
    for (let i = 0; i < count; i += 1) next[start + i] = block.readInt16LE(i * 2);
    this.samples = next;
  }

  available() {
    return this.samples.length - this.pos > this.frameSize * this.step + 2;
  }

  readFrame() {
    if (!this.available()) return null;

    const frame = new Int16Array(this.frameSize);
    let pos = this.pos;
    for (let i = 0; i < this.frameSize; i += 1) {
      const index = Math.floor(pos);
      const frac = pos - index;
      const a = this.samples[index];
      const b = this.samples[index + 1] === undefined ? a : this.samples[index + 1];
      frame[i] = a + (b - a) * frac;
      pos += this.step;
    }
    this.pos = pos;

    const drop = Math.floor(this.pos) - 1;
    if (drop > 4096) {
      this.samples = this.samples.slice(drop);
      this.pos -= drop;
    }
    return frame;
  }
}

module.exports = { LinearResampler };
