import { Router } from 'express';
import { KASPI_QRPAY_URL } from '../config.js';
import { requestKaspi } from '../kaspiApi.js';
import { requireSession } from '../merchantSession.js';

const router = Router();

router.use(requireSession);

// ─── Operations history (QR + remote) ───

router.post('/operations', async (req, res, next) => {
  const { endDate, lastTransactionDate, statementPeriodCode } = req.body;
  if (!endDate) return res.status(400).json({ error: 'endDate required' });
  try {
    const url = `${KASPI_QRPAY_URL}/v02/history/operations`;
    const payload = JSON.stringify({
      EndDate: endDate,
      LastTransactionDate: lastTransactionDate || '',
      StatementPeriodCode: statementPeriodCode ?? 0,
    });
    res.json(await requestKaspi(url, req.session, { method: 'POST', body: payload }));
  } catch (err) {
    next(err);
  }
});

// ─── Operation details ───

router.post('/details', async (req, res, next) => {
  const { id, operationMethod } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const url = `${KASPI_QRPAY_URL}/v01/kaspi-qr/operations/details`;
    const payload = JSON.stringify({
      Id: Number(id),
      OperationMethod: operationMethod ?? 0,
    });
    res.json(await requestKaspi(url, req.session, { method: 'POST', body: payload }));
  } catch (err) {
    next(err);
  }
});

export default router;
