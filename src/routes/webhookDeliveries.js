import { Router } from 'express';
import { requireAdmin } from '../projects.js';
import { listWebhookDeliveries, getWebhookDelivery, retryWebhookDelivery } from '../webhookDeliveryStore.js';

const router = Router();
router.use(requireAdmin);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/', (req, res) => res.json(listWebhookDeliveries(req.kaspiProject.id, req.query)));
router.get('/:id', (req, res) => res.json(getWebhookDelivery(req.kaspiProject.id, req.params.id)));
router.post('/:id/retry', (req, res) => res.status(202).json(retryWebhookDelivery(req.kaspiProject.id, req.params.id)));

export default router;
