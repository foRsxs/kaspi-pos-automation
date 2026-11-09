// KZT: two decimal places, ROUND_HALF_UP. Parse decimal digits before converting
// to a Number so values such as 1.005 consistently become 1.01, not 1.00.
export const normalizeAmount = (input) => {
  if (!['string', 'number'].includes(typeof input)) throw new Error('Amount must be a positive decimal');
  const match = /^(\d{1,13})(?:\.(\d{1,12}))?$/.exec(String(input));
  if (!match) throw new Error('Amount must be a positive decimal (no exponent notation)');
  const fraction = (match[2] || '').padEnd(3, '0');
  const minor = BigInt(match[1]) * 100n + BigInt(fraction.slice(0, 2)) + (fraction[2] >= '5' ? 1n : 0n);
  if (minor <= 0n || minor > 99999999999999n) throw new Error('Amount is out of range');
  return Number(minor) / 100;
};

export const requireAmount = (field) => (req, res, next) => {
  try {
    req.body[field] = normalizeAmount(req.body[field]);
    next();
  } catch (err) {
    res.status(400).json({ error: `${field}: ${err.message}` });
  }
};
