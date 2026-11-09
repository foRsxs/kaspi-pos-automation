import { Router } from 'express';
import { requireAdmin } from '../projects.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  rotateProjectKey,
  revealProjectApiKey,
} from '../projectStore.js';
import { getConnectionSummary } from '../merchantSession.js';

const router = Router();
router.use(requireAdmin);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const withConnection = (project) => ({ ...project, connection: getConnectionSummary(project.id) });

router.get('/', (req, res) => {
  const projects = listProjects({ includeArchived: req.query.includeArchived === 'true' });
  res.json({ projects: projects.map(withConnection) });
});

router.post('/', (req, res) => {
  const result = createProject(req.body);
  res.status(201).json({ ...result, project: withConnection(result.project) });
});

router.get('/:id/api-key', (req, res) => {
  res.json(revealProjectApiKey(req.params.id));
});

router.get('/:id', (req, res) => {
  const project = getProject(req.params.id, { includeArchived: true });
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  res.json({ project: withConnection(project) });
});

router.patch('/:id', (req, res) => {
  const result = updateProject(req.params.id, req.body);
  res.json({ ...result, project: withConnection(result.project) });
});

router.post('/:id/rotate-key', (req, res) => {
  const result = rotateProjectKey(req.params.id);
  res.json({ ...result, project: withConnection(result.project) });
});

router.delete('/:id', (req, res) => {
  res.json({ project: withConnection(archiveProject(req.params.id)) });
});

export default router;
