import test from 'node:test';
import assert from 'node:assert/strict';

import {
  median,
  computeOffset,
  computeRtt,
  bestByRtt,
  smoothOffset,
} from '../../client/js/clock.js';

test('median: 奇数/偶数/空数组', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('computeOffset: 对称往返时偏移为 0', () => {
  // t1=1000, t2=1050, t3=1100：去程 50ms，回程 50ms
  assert.equal(computeOffset(1000, 1050, 1100), 0);
  assert.equal(computeRtt(1000, 1100), 100);
});

test('computeOffset: 服务端慢 10ms 且路径不对称', () => {
  // 去程 40ms 到达 t2=1040，回程 60ms，t3=1100
  // offset = ((40) + (1040-1100)) / 2 = -10
  assert.equal(computeOffset(1000, 1040, 1100), -10);
});

test('computeOffset: 服务端快 25ms', () => {
  // t1=0, t2=50, t3=100 → ((50) + (-50)) / 2 = 0 ... 换一组：
  // 服务端比客户端快 25ms，去回各 40ms：t1=0, t2=65, t3=80
  assert.equal(computeOffset(0, 65, 80), 25);
});

test('bestByRtt: 选中 RTT 最小的样本', () => {
  const samples = [10, 12, 9];
  const rtts = [80, 20, 60];
  const best = bestByRtt(samples, rtts);
  assert.deepEqual(best, { sample: 12, rtt: 20, index: 1 });
  assert.equal(bestByRtt([], []), null);
});

test('smoothOffset: 小偏差按 30% 靠拢，大偏差直接跳变', () => {
  assert.equal(smoothOffset(100, 110), 103);
  assert.equal(smoothOffset(100, 400), 400);
  assert.equal(smoothOffset(100, 99), 99.7);
});
