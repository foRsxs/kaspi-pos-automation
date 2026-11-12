import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { requestKaspi } from '../kaspiApi.js';
import { requireSession } from '../merchantSession.js';

import { requirePayment } from '../polling.js';
import { requireAmount } from '../amount.js';

const router = Router();

router.use(requireSession);

// ─── Return (refund) ───

router.post(
  '/create',
  requirePayment(null, 'qrOperationId', 'body'),
  requireAmount('returnAmount'),
  async (req, res, next) => {
    const { qrOperationId, returnAmount } = req.body;
    try {
      const url = `${KASPI_QRPAY_URL}/v01/kaspi-qr/history-pos-return`;
      const payload = JSON.stringify({
        ReturnAmount: returnAmount,
        QrOperationId: Number(qrOperationId),
        DeviceInterface: 'Pos',
      });
      res.json(await requestKaspi(url, req.session, { method: 'POST', body: payload }));
    } catch (err) {
      next(err);
    }
  },
);

export default router;
