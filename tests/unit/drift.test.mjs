import test from 'node:test';
import assert from 'node:assert/strict';

import { DriftCompensator } from '../../server/audio/broadcaster.js';

function rampBuffer(count, start = 0) {
  const buffer = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) buffer.writeInt16LE(start + i, i * 2);
  return buffer;
}

test('DriftCompensator: ratio=1 时原样输出', () => {
  const comp = new DriftCompensator();
  comp.ratio = 1;
  comp.pushBytes(rampBuffer(100));

  assert.ok(comp.available() >= 90);
  const out = comp.read(10);
  assert.equal(out.length, 10);
  for (let i = 0; i < 10; i += 1) assert.equal(out[i], i);
});

test('DriftCompensator: ratio<1 时做线性插值', () => {
  const comp = new DriftCompensator();
  comp.ratio = 0.5;
  comp.pushBytes(rampBuffer(32));

  const out = comp.read(4);
  // 采样点：0, 0.5, 1.0, 1.5 → 0, 0.5, 1, 1.5（Int16Array 会截断小数）
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
  assert.equal(out[2], 1);
  assert.equal(out[3], 1);
});

test('DriftCompensator: trim 丢弃旧样本并保持可读', () => {
  const comp = new DriftCompensator();
  comp.ratio = 1;
  comp.pushBytes(rampBuffer(8820)); // 200ms
  const before = comp.backlogMs();
  const dropped = comp.trim(100);
  assert.ok(dropped > 0);
  assert.ok(comp.backlogMs() < before);
  assert.equal(comp.read(10).length, 10);
});

test('DriftCompensator: 空输入不报错', () => {
  const comp = new DriftCompensator();
  comp.pushBytes(Buffer.alloc(0));
  assert.equal(comp.available(), 0);
});
