import crypto from 'node:crypto';
import { findProjectByApiKey, getProject, adminKeyHash } from './projectStore.js';

export { listProjects, projectWebhooks } from './projectStore.js';

export const selectKaspiProject = (req, res, next) => {
  const selected = req.get('X-Project-ID');
  if (req.project.isAdmin) {
    if (!selected) return res.status(400).json({ error: 'Для запроса администратора укажите X-Project-ID' });
    const project = getProject(selected, { includeArchived: true });
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    req.kaspiProject = { id: project.id, status: project.status };
  } else {
    if (selected && selected !== req.project.id) {
      return res.status(403).json({ error: 'Проект не соответствует API-ключу' });
    }
    req.kaspiProject = { id: req.project.id, status: req.project.status };
  }
  next();
};

export const authenticateProject = (req, res, next) => {
  const match = /^Bearer ([\x21-\x7e]{32,256})$/.exec(req.get('Authorization') || '');
  if (!match) return res.status(401).json({ error: 'Укажите действительный Bearer API-ключ' });
  const digest = crypto.createHash('sha256').update(match[1]).digest();
  const principal = crypto.timingSafeEqual(digest, adminKeyHash)
    ? { id: '__admin__', isAdmin: true }
    : findProjectByApiKey(match[1]);
  if (!principal) return res.status(401).json({ error: 'API-ключ недействителен или проект отключён' });
  req.project = principal;
  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.project.isAdmin) return res.status(403).json({ error: 'Требуется ключ администратора' });
  next();
};

export const requireActiveProject = (req, res, next) => {
  if (req.kaspiProject.status !== 'active') {
    return res.status(403).json({ error: 'Создание платежей для отключённого или удалённого проекта запрещено' });
  }
  next();
};
