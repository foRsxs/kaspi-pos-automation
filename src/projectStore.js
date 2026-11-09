import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, transaction } from './database.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { ROOT_DIR } from './paths.js';

const MIGRATION_KEY = 'legacy_projects_v1';
const ENCRYPTION_CHECK_KEY = 'encryption_key_check_v1';
const ENCRYPTION_CHECK = Buffer.from('kaspi-project-store-encryption-check-v1', 'utf8');
const VALID_PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const VALID_API_KEY = /^[\x21-\x7e]{32,256}$/;
const VALID_WEBHOOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_EVENTS = new Set(['payment.success', 'payment.failed', 'payment.expired', 'payment.lost']);

export class ProjectStoreError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'ProjectStoreError';
    this.statusCode = statusCode;
    this.status = statusCode;
    if (code) this.code = code;
  }
}

const storeError = (message, statusCode, code) => new ProjectStoreError(message, statusCode, code);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

const adminApiKey = process.env.ADMIN_API_KEY;
if (!VALID_API_KEY.test(adminApiKey || '')) {
  throw new Error('ADMIN_API_KEY должен содержать 32–256 печатных ASCII-символов без пробелов');
}
export const adminKeyHash = Buffer.from(sha256(adminApiKey), 'hex');
const adminKeyHashHex = adminKeyHash.toString('hex');

db.exec(`
  CREATE TABLE IF NOT EXISTS store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT NOT NULL COLLATE NOCASE PRIMARY KEY
      CHECK (length(id) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
    key_hash TEXT UNIQUE,
    key_encrypted TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL COLLATE NOCASE REFERENCES projects(id) ON DELETE RESTRICT,
    url TEXT NOT NULL,
    events_json TEXT NOT NULL,
    secret_encrypted TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS webhooks_project_id_idx ON webhooks(project_id);
`);

const projectColumns = new Set(
  db
    .prepare('PRAGMA table_info(projects)')
    .all()
    .map((column) => column.name),
);
if (!projectColumns.has('key_encrypted')) {
  db.exec('ALTER TABLE projects ADD COLUMN key_encrypted TEXT');
}

const checkEncryptionKey = () => {
  const verify = (encrypted) => {
    try {
      if (!decryptSecret(encrypted).equals(ENCRYPTION_CHECK)) throw new Error('mismatch');
    } catch {
      throw new Error('TOKEN_SECRET_KEY не совпадает с ключом, которым зашифрованы данные projects.sqlite');
    }
  };

  const storedCheck = db.prepare('SELECT value FROM store_meta WHERE key = ?').get(ENCRYPTION_CHECK_KEY);
  if (storedCheck) {
    verify(storedCheck.value);
    return;
  }

  try {
    for (const row of db.prepare('SELECT secret_encrypted FROM webhooks').all()) {
      decryptSecret(row.secret_encrypted);
    }
    for (const row of db.prepare('SELECT key_encrypted FROM projects WHERE key_encrypted IS NOT NULL').all()) {
      decryptSecret(row.key_encrypted);
    }
  } catch {
    throw new Error('TOKEN_SECRET_KEY не совпадает с ключом, которым зашифрованы данные projects.sqlite');
  }

  transaction(() => {
    const existing = db.prepare('SELECT value FROM store_meta WHERE key = ?').get(ENCRYPTION_CHECK_KEY);
    if (existing) {
      verify(existing.value);
    } else {
      db.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)').run(
        ENCRYPTION_CHECK_KEY,
        encryptSecret(ENCRYPTION_CHECK),
      );
    }
  });
};

checkEncryptionKey();

const legacyFile = process.env.PROJECTS_FILE
  ? path.resolve(process.env.PROJECTS_FILE)
  : path.join(ROOT_DIR, 'projects.json');

const validUrl = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};

const validWebhookSecret = (value) => typeof value === 'string' && VALID_API_KEY.test(value);

const readLegacyProjects = () => {
  if (!fs.existsSync(legacyFile)) {
    if (process.env.PROJECTS_FILE) {
      throw new Error(`Файл PROJECTS_FILE не найден: ${legacyFile}`);
    }
    return [];
  }

  let configuration;
  try {
    configuration = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  } catch (err) {
    throw new Error(`Не удалось прочитать PROJECTS_FILE: ${err.message}`, { cause: err });
  }
  if (!Array.isArray(configuration)) throw new Error('PROJECTS_FILE должен содержать JSON-массив проектов');

  const ids = new Set(['__admin__']);
  const keyHashes = new Set([adminKeyHashHex]);
  const result = [];

  for (const project of configuration) {
    if (
      !project ||
      typeof project.id !== 'string' ||
      !VALID_PROJECT_ID.test(project.id) ||
      ids.has(project.id.toLowerCase())
    ) {
      throw new Error('Каждый проект должен иметь уникальный ID из 1–64 букв, цифр, _ или -');
    }
    ids.add(project.id.toLowerCase());

    const key = process.env[project.apiKeyEnv];
    if (!validWebhookSecret(key)) throw new Error(`Отсутствует или недействителен API-ключ проекта ${project.id}`);
    const keyHash = sha256(key);
    if (keyHashes.has(keyHash)) throw new Error(`API-ключ проекта ${project.id} уже используется`);
    keyHashes.add(keyHash);

    const configuredWebhooks = project.webhooks ?? [];
    if (!Array.isArray(configuredWebhooks))
      throw new Error(`Список webhook проекта ${project.id} должен быть массивом`);
    const webhooks = configuredWebhooks.map((hook) => {
      const secret = process.env[hook?.secretEnv];
      if (
        !hook ||
        !validUrl(hook.url) ||
        !Array.isArray(hook.events) ||
        hook.events.length === 0 ||
        hook.events.some((event) => !VALID_EVENTS.has(event)) ||
        !validWebhookSecret(secret)
      ) {
        throw new Error(`Неверная конфигурация webhook проекта ${project.id}`);
      }
      return {
        id: crypto.randomUUID(),
        url: hook.url,
        events: [...new Set(hook.events)],
        secretEncrypted: encryptSecret(Buffer.from(secret, 'ascii')),
      };
    });

    result.push({
      id: project.id,
      name: project.id,
      keyHash,
      keyEncrypted: encryptSecret(Buffer.from(key, 'ascii')),
      webhooks,
    });
  }
  return result;
};

const migrateLegacyProjects = () => {
  transaction(() => {
    if (db.prepare('SELECT 1 FROM store_meta WHERE key = ?').get(MIGRATION_KEY)) return;

    const projects = readLegacyProjects();
    const timestamp = now();
    const insertProject = db.prepare(
      'INSERT INTO projects (id, name, status, key_hash, key_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertWebhook = db.prepare(
      'INSERT INTO webhooks (id, project_id, url, events_json, secret_encrypted) VALUES (?, ?, ?, ?, ?)',
    );
    for (const project of projects) {
      insertProject.run(
        project.id,
        project.name,
        'active',
        project.keyHash,
        project.keyEncrypted,
        timestamp,
        timestamp,
      );
      for (const hook of project.webhooks) {
        insertWebhook.run(hook.id, project.id, hook.url, JSON.stringify(hook.events), hook.secretEncrypted);
      }
    }
    db.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)').run(MIGRATION_KEY, timestamp);
  });
};

migrateLegacyProjects();

if (db.prepare('SELECT 1 FROM projects WHERE key_hash = ?').get(adminKeyHashHex)) {
  throw new Error('ADMIN_API_KEY совпадает с API-ключом проекта. Задайте отдельный ключ администратора');
}

const validateId = (id) => {
  if (typeof id !== 'string' || !VALID_PROJECT_ID.test(id)) {
    throw storeError('ID проекта должен содержать 1–64 буквы, цифры, _ или -', 400);
  }
};

const validateName = (name) => {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
    throw storeError('Имя проекта обязательно и должно содержать не более 120 символов', 400);
  }
  return name.trim();
};

const validateApiKey = (key) => {
  if (!validWebhookSecret(key)) throw storeError('API-ключ должен содержать 32–256 печатных ASCII-символов', 400);
};

const validateWebhook = (hook) => {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
    throw storeError('Каждый webhook должен быть объектом', 400);
  }
  if (hook.id !== undefined && (typeof hook.id !== 'string' || !VALID_WEBHOOK_ID.test(hook.id))) {
    throw storeError('ID webhook должен быть UUID', 400);
  }
  if (!validUrl(hook.url)) throw storeError('URL webhook должен использовать HTTP или HTTPS без логина и пароля', 400);
  if (
    !Array.isArray(hook.events) ||
    hook.events.length === 0 ||
    hook.events.some((event) => typeof event !== 'string' || !VALID_EVENTS.has(event)) ||
    new Set(hook.events).size !== hook.events.length
  ) {
    throw storeError('Укажите непустой список допустимых событий webhook без повторов', 400);
  }
  if (hook.secret !== undefined) validateApiKey(hook.secret);
};

const loadWebhooks = (projectId) =>
  db
    .prepare('SELECT id, url, events_json FROM webhooks WHERE project_id = ? ORDER BY rowid')
    .all(projectId)
    .map((hook) => ({
      id: hook.id,
      url: hook.url,
      events: JSON.parse(hook.events_json),
      hasSecret: true,
    }));

const toProject = (row) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  canRevealApiKey: row.status !== 'archived' && row.key_encrypted !== null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  webhooks: loadWebhooks(row.id),
});

const projectById = (id, includeArchived = false) => {
  const row = db
    .prepare(
      `SELECT id, name, status, key_encrypted, created_at, updated_at FROM projects WHERE id = ? ${includeArchived ? '' : "AND status <> 'archived'"}`,
    )
    .get(id);
  return row ? toProject(row) : null;
};

export const listProjects = ({ includeArchived = false } = {}) => {
  const rows = db
    .prepare(
      `SELECT id, name, status, key_encrypted, created_at, updated_at FROM projects ${includeArchived ? '' : "WHERE status <> 'archived'"} ORDER BY created_at, id COLLATE NOCASE`,
    )
    .all();
  return rows.map(toProject);
};

export const getProject = (id, { includeArchived = false } = {}) => {
  if (typeof id !== 'string' || !VALID_PROJECT_ID.test(id)) return null;
  return projectById(id, includeArchived === true);
};

export const revealProjectApiKey = (id) => {
  validateId(id);
  const project = db.prepare('SELECT id, status, key_hash, key_encrypted FROM projects WHERE id = ?').get(id);
  if (!project) throw storeError('Проект не найден', 404);
  if (project.status === 'archived') throw storeError('API-ключ архивного проекта нельзя просмотреть', 409);
  if (!project.key_hash || !project.key_encrypted) {
    throw storeError(
      'Сохранённый API-ключ восстановить нельзя; создайте новый ключ ротацией',
      409,
      'API_KEY_NOT_RECOVERABLE',
    );
  }

  try {
    const apiKey = decryptSecret(project.key_encrypted).toString('utf8');
    if (!validWebhookSecret(apiKey) || sha256(apiKey) !== project.key_hash) {
      throw new Error('API-ключ не совпадает с сохранённым хешем');
    }
    return { apiKey };
  } catch {
    throw storeError(
      'Сохранённый API-ключ восстановить нельзя; создайте новый ключ ротацией',
      409,
      'API_KEY_NOT_RECOVERABLE',
    );
  }
};

export const findProjectByApiKey = (key) => {
  if (!validWebhookSecret(key)) return null;
  const row = db.prepare("SELECT id, status FROM projects WHERE key_hash = ? AND status = 'active'").get(sha256(key));
  return row ? { id: row.id, isAdmin: false, status: row.status } : null;
};

const makeSlug = (name) => {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-_]+$/g, '')
    .slice(0, 48);
  return slug || 'project';
};

export const createProject = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw storeError('Тело запроса должно быть объектом', 400);
  const { name, id } = input;
  const cleanName = validateName(name);
  if (id !== undefined) validateId(id);
  const apiKey = crypto.randomBytes(32).toString('base64url');
  const keyHash = sha256(apiKey);
  const keyEncrypted = encryptSecret(Buffer.from(apiKey, 'ascii'));

  const projectId = transaction(() => {
    if (keyHash === adminKeyHashHex || db.prepare('SELECT 1 FROM projects WHERE key_hash = ?').get(keyHash)) {
      throw storeError('Сгенерированный API-ключ уже используется; повторите запрос', 409);
    }
    let selectedId = id;
    if (!selectedId) {
      const slug = makeSlug(cleanName);
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = `${slug}-${crypto.randomBytes(4).toString('hex')}`;
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(candidate)) {
          selectedId = candidate;
          break;
        }
      }
      if (!selectedId) throw storeError('Не удалось сгенерировать свободный ID проекта', 409);
    }
    if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(selectedId)) {
      throw storeError('Проект с таким ID уже существует', 409);
    }

    const timestamp = now();
    try {
      db.prepare(
        'INSERT INTO projects (id, name, status, key_hash, key_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(selectedId, cleanName, 'active', keyHash, keyEncrypted, timestamp, timestamp);
    } catch (err) {
      if (err.code?.startsWith('SQLITE_CONSTRAINT'))
        throw storeError('Проект с таким ID или API-ключом уже существует', 409);
      throw err;
    }
    return selectedId;
  });

  return { project: projectById(projectId), apiKey };
};

export const updateProject = (id, body = {}) => {
  validateId(id);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw storeError('Тело запроса должно быть объектом', 400);
  const allowedKeys = new Set(['name', 'status', 'webhooks']);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw storeError('Тело содержит неизвестные поля', 400);
  const cleanName = body.name === undefined ? undefined : validateName(body.name);
  if (body.status !== undefined && !['active', 'disabled'].includes(body.status)) {
    throw storeError(
      'Статус проекта должен быть active или disabled; для архивации используйте отдельную операцию',
      400,
    );
  }
  if (body.webhooks !== undefined) {
    if (!Array.isArray(body.webhooks)) throw storeError('Список webhook должен быть массивом', 400);
    body.webhooks.forEach(validateWebhook);
  }

  const webhookSecrets = [];
  const canonicalId = transaction(() => {
    const existing = db.prepare('SELECT id, name, status FROM projects WHERE id = ?').get(id);
    if (!existing) throw storeError('Проект не найден', 404);
    if (existing.status === 'archived') throw storeError('Архивный проект нельзя изменить', 409);

    const nextStatus = body.status ?? existing.status;
    const nextName = cleanName ?? existing.name;
    const timestamp = now();
    db.prepare('UPDATE projects SET name = ?, status = ?, updated_at = ? WHERE id = ?').run(
      nextName,
      nextStatus,
      timestamp,
      existing.id,
    );

    if (body.webhooks !== undefined) {
      const existingHooks = new Map(
        db
          .prepare('SELECT id, project_id, secret_encrypted FROM webhooks')
          .all()
          .map((hook) => [hook.id.toLowerCase(), hook]),
      );
      const seenIds = new Set();
      const preparedHooks = body.webhooks.map((hook) => {
        let webhookId = hook.id;
        if (!webhookId) {
          do {
            webhookId = crypto.randomUUID();
          } while (existingHooks.has(webhookId.toLowerCase()));
        }
        const normalizedId = webhookId.toLowerCase();
        if (seenIds.has(normalizedId)) throw storeError('ID webhook не должен повторяться', 400);
        seenIds.add(normalizedId);

        const saved = existingHooks.get(normalizedId);
        if (saved && saved.project_id.toLowerCase() !== existing.id.toLowerCase()) {
          throw storeError('Этот webhook уже принадлежит другому проекту', 409);
        }
        if (!saved && hook.id) {
          const elsewhere = db.prepare('SELECT project_id FROM webhooks WHERE id = ?').get(webhookId);
          if (elsewhere) throw storeError('Этот webhook уже принадлежит другому проекту', 409);
          throw storeError('Webhook не найден', 404);
        }

        let secretEncrypted;
        if (hook.secret !== undefined) {
          secretEncrypted = encryptSecret(Buffer.from(hook.secret, 'ascii'));
        } else if (saved) {
          secretEncrypted = saved.secret_encrypted;
        } else {
          const secret = crypto.randomBytes(32).toString('base64url');
          secretEncrypted = encryptSecret(Buffer.from(secret, 'ascii'));
          webhookSecrets.push({ id: webhookId, secret });
        }
        return { id: saved?.id || webhookId, url: hook.url, events: hook.events, secretEncrypted };
      });

      db.prepare('DELETE FROM webhooks WHERE project_id = ?').run(existing.id);
      const insertWebhook = db.prepare(
        'INSERT INTO webhooks (id, project_id, url, events_json, secret_encrypted) VALUES (?, ?, ?, ?, ?)',
      );
      for (const hook of preparedHooks) {
        insertWebhook.run(hook.id, existing.id, hook.url, JSON.stringify(hook.events), hook.secretEncrypted);
      }
    }
    return existing.id;
  });

  return { project: projectById(canonicalId, true), webhookSecrets };
};

export const rotateProjectKey = (id) => {
  validateId(id);
  const apiKey = crypto.randomBytes(32).toString('base64url');
  const keyHash = sha256(apiKey);
  const keyEncrypted = encryptSecret(Buffer.from(apiKey, 'ascii'));
  const canonicalId = transaction(() => {
    const project = db.prepare('SELECT id, status FROM projects WHERE id = ?').get(id);
    if (!project) throw storeError('Проект не найден', 404);
    if (project.status === 'archived') throw storeError('Архивный проект нельзя изменить', 409);
    if (keyHash === adminKeyHashHex || db.prepare('SELECT 1 FROM projects WHERE key_hash = ?').get(keyHash)) {
      throw storeError('Сгенерированный API-ключ уже используется; повторите запрос', 409);
    }
    db.prepare('UPDATE projects SET key_hash = ?, key_encrypted = ?, updated_at = ? WHERE id = ?').run(
      keyHash,
      keyEncrypted,
      now(),
      project.id,
    );
    return project.id;
  });
  return { project: projectById(canonicalId), apiKey };
};

export const archiveProject = (id) => {
  validateId(id);
  const canonicalId = transaction(() => {
    const project = db.prepare('SELECT id, status FROM projects WHERE id = ?').get(id);
    if (!project) throw storeError('Проект не найден', 404);
    if (project.status !== 'archived') {
      db.prepare(
        "UPDATE projects SET status = 'archived', key_hash = NULL, key_encrypted = NULL, updated_at = ? WHERE id = ?",
      ).run(now(), project.id);
    }
    return project.id;
  });
  return projectById(canonicalId, true);
};

export const projectWebhooks = (projectId, event) => {
  if (typeof projectId !== 'string' || !VALID_PROJECT_ID.test(projectId)) return [];
  if (typeof event !== 'string' || !VALID_EVENTS.has(event)) return [];
  return db
    .prepare('SELECT id, url, events_json, secret_encrypted FROM webhooks WHERE project_id = ? ORDER BY rowid')
    .all(projectId)
    .filter((hook) => JSON.parse(hook.events_json).includes(event))
    .map((hook) => ({
      id: hook.id,
      url: hook.url,
      secret: decryptSecret(hook.secret_encrypted).toString('utf8'),
    }));
};
