import { it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAmount, resolvePaymentAmount } from '../src/amount.js';

it('rounds all monetary inputs with decimal ROUND_HALF_UP to two places', () => {
  assert.equal(normalizeAmount('1.005'), 1.01);
  assert.equal(normalizeAmount('10.999'), 11);
  assert.equal(normalizeAmount('0.005'), 0.01);
  assert.equal(normalizeAmount(999.994), 999.99);
  assert.equal(normalizeAmount('1200'), 1200);
});

it('resolves a recorded charge and bank amount without allowing zero placeholders to erase the charge', () => {
  assert.equal(resolvePaymentAmount(290, 0), 290);
  assert.equal(resolvePaymentAmount(0, 290), 290);
  assert.equal(resolvePaymentAmount(undefined, '290.005'), 290.01);
  assert.equal(resolvePaymentAmount(290, '291.005'), 291.01);
  assert.equal(resolvePaymentAmount('290.005', null), 290.01);
  assert.equal(resolvePaymentAmount(0, 0), null);
  assert.equal(resolvePaymentAmount(null, undefined), null);
  assert.equal(resolvePaymentAmount(-1, 'invalid'), null);
});

it('rejects zero, negative, malformed, nonfinite and excessive amounts', () => {
  for (const value of [0, -1, '0.004', NaN, Infinity, '1e3', '', null, true, {}, '10000000000000', '1,25']) {
    assert.throws(() => normalizeAmount(value), `Expected rejection for ${String(value)}`);
  }
});
