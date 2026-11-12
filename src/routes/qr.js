import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { requestKaspi } from '../kaspiApi.js';
import { requireSession } from '../merchantSession.js';
import { trackPayment, requirePayment } from '../polling.js';

import { requireAmount } from '../amount.js';
import { requireActiveProject } from '../projects.js';

const router = Router();

router.use(requireSession);

// ─── Create QR token ───

router.post('/create', requireActiveProject, requireAmount('amount'), async (req, res, next) => {
  const { amount, latitude, longitude } = req.body;

  try {
    const url = `${KASPI_QRPAY_URL}/v01/qr-token/create`;
    const payload = JSON.stringify({
      PaymentAmount: amount,
      DeviceInterface: 'Pos',
      Latitude: latitude || 43.204643483375889,
      Longitude: longitude || 76.891962364115912,
    });
    const kaspiResponse = await requestKaspi(url, req.session, {
      method: 'POST',
      body: payload,
    });
    const d = kaspiResponse.Data;
    if (d && d.QrOperationId) {
      const opts = d.QrPaymentBehaviorOptions || {};
      const persisted = trackPayment(
        d.QrOperationId,
        'qr',
        {
          projectId: req.kaspiProject.id,
          tokenSN: req.session.tokenSN,
          vtokenSecret: req.session.vtokenSecret,
          profileId: req.session.profileId,
        },
        {
          qrToken: d.QrToken,
          expireDate: d.ExpireDate,
          receiptUrl: d.ReceiptUrl,
          amount,
          orderId: req.body.orderId,
          pollingIntervals: {
            scanWaitTimeout: Number(opts.qrCodeScanWaitTimeout) || 180,
            scanPollingInterval: Number(opts.qrCodeScanEventPollingInterval) || 3,
            statusCountdown: Number(opts.paymentStatusCountdown) || 2,
            confirmationTimeout: Number(opts.paymentConfirmationTimeout) || 65,
          },
        },
        req.kaspiProject.id,
      );
      kaspiResponse.tracking = { persisted };
      if (!persisted) res.status(202);
    }
    if (d && d.QrToken) {
      d.QrOriginalToken = d.QrToken;
      d.QrToken = d.QrToken.replace('https://qr.kaspi.kz/', 'https://pay.kaspi.kz/pay/');
    }
    res.json(kaspiResponse);
  } catch (err) {
    next(err);
  }
});

// ─── QR payment status ───

router.get('/status', requirePayment('qr', 'qrOperationId'), async (req, res, next) => {
  const { qrOperationId } = req.query;

  try {
    const url = `${KASPI_QRPAY_URL}/v02/kaspi-qr/status?qrOperationId=${qrOperationId}`;
    res.json(await requestKaspi(url, req.session));
  } catch (err) {
    next(err);
  }
});

export default router;
