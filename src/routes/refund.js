import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { loggedFetch, signedQrPayHeaders } from '../helpers.js';
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
  async (req, res) => {
    const { qrOperationId, returnAmount } = req.body;
    try {
      const url = `${KASPI_QRPAY_URL}/v01/kaspi-qr/history-pos-return`;
      const payload = JSON.stringify({
        ReturnAmount: returnAmount,
        QrOperationId: Number(qrOperationId),
        DeviceInterface: 'Pos',
      });
      const headers = { ...signedQrPayHeaders(url, req.session, payload), 'Content-Type': 'application/json' };
      const resp = await loggedFetch(url, {
        method: 'POST',
        headers,
        body: payload,
      });
      res.json(await resp.json());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

export default router;
