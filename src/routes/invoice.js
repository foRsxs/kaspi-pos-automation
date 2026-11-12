import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { requestKaspi } from '../kaspiApi.js';
import { requireSession } from '../merchantSession.js';
import { trackPayment, requirePayment } from '../polling.js';

import { requireAmount } from '../amount.js';
import { requireAdmin, requireActiveProject } from '../projects.js';

const router = Router();

router.use('/history', requireAdmin);
router.use(requireSession);

// ─── Client info ───

router.get('/client-info', async (req, res, next) => {
  const { phoneNumber } = req.query;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/client-info?phoneNumber=${encodeURIComponent(phoneNumber)}`;
    res.json(await requestKaspi(url, req.session));
  } catch (err) {
    next(err);
  }
});

// ─── Create invoice ───

router.post('/create', requireActiveProject, requireAmount('amount'), async (req, res, next) => {
  const { phoneNumber, amount, comment } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });

  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/create`;
    const payload = JSON.stringify({ PhoneNumber: phoneNumber, Amount: amount, Comment: comment || '' });
    const kaspiResponse = await requestKaspi(url, req.session, {
      method: 'POST',
      body: payload,
    });
    const d = kaspiResponse.Data;
    if (d && d.QrOperationId) {
      const persisted = trackPayment(
        d.QrOperationId,
        'invoice',
        {
          projectId: req.kaspiProject.id,
          tokenSN: req.session.tokenSN,
          vtokenSecret: req.session.vtokenSecret,
          profileId: req.session.profileId,
        },
        {
          amount,
          orderId: req.body.orderId,
          clientMobile: d.ClientMobile,
          receiptUrl: d.ReceiptUrl,
          orderNumber: d.OrderNumber,
        },
        req.kaspiProject.id,
      );
      kaspiResponse.tracking = { persisted };
      if (!persisted) res.status(202);
    }
    res.json(kaspiResponse);
  } catch (err) {
    next(err);
  }
});

// ─── Invoice details ───

router.get('/details', requirePayment('invoice', 'operationId'), async (req, res, next) => {
  const { operationId } = req.query;

  try {
    const url = `${KASPI_QRPAY_URL}/v02/remote/details?operationId=${operationId}`;
    res.json(await requestKaspi(url, req.session));
  } catch (err) {
    next(err);
  }
});

// ─── Cancel invoice ───

router.post('/cancel', requirePayment('invoice', 'operationId', 'body'), async (req, res, next) => {
  const { operationId } = req.body;

  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/cancel`;
    const payload = JSON.stringify({ qrOperationId: Number(operationId) });
    res.json(await requestKaspi(url, req.session, { method: 'POST', body: payload }));
  } catch (err) {
    next(err);
  }
});

// ─── Invoice history ───

router.post('/history', async (req, res, next) => {
  try {
    const url = `${KASPI_QRPAY_URL}/v01/remote/history`;
    const payload = JSON.stringify({ MaxResult: 20 });
    res.json(await requestKaspi(url, req.session, { method: 'POST', body: payload }));
  } catch (err) {
    next(err);
  }
});

export default router;
