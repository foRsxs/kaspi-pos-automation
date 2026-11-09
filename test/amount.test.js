import { it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAmount } from '../src/amount.js';

it('rounds all monetary inputs with decimal ROUND_HALF_UP to two places', () => {
  assert.equal(normalizeAmount('1.005'), 1.01);
  assert.equal(normalizeAmount('10.999'), 11);
  assert.equal(normalizeAmount('0.005'), 0.01);
  assert.equal(normalizeAmount(999.994), 999.99);
  assert.equal(normalizeAmount('1200'), 1200);
});

it('rejects zero, negative, malformed, nonfinite and excessive amounts', () => {
  for (const value of [0, -1, '0.004', NaN, Infinity, '1e3', '', null, true, {}, '10000000000000', '1,25']) {
    assert.throws(() => normalizeAmount(value), `Expected rejection for ${String(value)}`);
  }
});
