/**
 * Express adapter for the ACP backends and sessions (M1: backends + sessions).
 *
 * Backends:
 * - `GET /api/acp/backends` → entries with live status.
 * - `PUT /api/acp/backends` → replace the registry (validated).
 * - `POST /api/acp/backends/:id/restart` → stop and start fresh.
 * - `POST /api/acp/backends/:id/authenticate` → `{ methodId }`.
 * - `GET /api/acp/backends/:id/config-cache` → `{ configOptions }` (D9 picker).
 *
 * Sessions (the contract in `./routes.d.ts`):
 * - `POST /api/acp/sessions` → `{ session }`.
 * - `GET /api/acp/sessions?directory=` → `{ sessions }`.
 * - `GET /api/acp/sessions/status?directory=` → `{ statuses }` (before `/:key`).
 * - `GET /api/acp/sessions/:key` → `{ session }`.
 * - `PATCH /api/acp/sessions/:key` → `{ session }`.
 * - `DELETE /api/acp/sessions/:key` → `{ deleted: true }`.
 * - `GET /api/acp/sessions/:key/message?limit&before` → `MessagePage`.
 * - `POST /api/acp/sessions/:key/prompt` → 202 empty.
 * - `POST /api/acp/sessions/:key/cancel` → 200 `{ cancelled: true }` / 204.
 * - `POST /api/acp/sessions/:key/config` → 200 empty.
 * - `GET /api/acp/sessions/:key/commands` → `{ commands }`.
 * - `POST /api/acp/sessions/:key/permissions/:requestId/reply` → 200 empty.
 * - `GET /api/acp/sessions/:key/permissions/:requestId` → `{ permission }`.
 * - `POST /api/acp/sessions/:key/forms/:formId/reply` → 200 empty.
 * - `POST /api/acp/sessions/:key/forms/:formId/cancel` → 200 empty.
 * - `GET /api/acp/permissions?directory=` → `{ permissions }`.
 * - `GET /api/acp/forms?directory=` → `{ forms }`.
 *
 * Live projector events fan out as `openchamber:acp-sync` frames through
 * `publishSyncFrame` (the host binds the global message hub, so SSE and WS
 * clients get them and replay works).
 */

import express from 'express';

import { AcpBackendError } from '../core/backend-manager.js';

const jsonBody = express.json({ limit: '256kb' });
const promptBody = express.json({ limit: '4mb' });

const statusForError = (error) => {
  switch (error?.code) {
    case 'ACP_BACKEND_UNKNOWN':
    case 'ACP_AUTH_UNKNOWN_METHOD':
    case 'ACP_SESSION_UNKNOWN':
    case 'ACP_MESSAGE_UNKNOWN':
    case 'ACP_PERMISSION_UNKNOWN':
    case 'ACP_FORM_UNKNOWN':
      return 404;
    case 'ACP_BACKEND_DISABLED':
    case 'ACP_AUTH_TERMINAL':
    case 'ACP_SESSION_BUSY':
      return 409;
    case 'ACP_REGISTRY_INVALID':
    case 'ACP_REGISTRY_CORRUPT':
    case 'ACP_CONFIG_UNKNOWN':
      return 422;
    case 'ACP_INVALID_DIRECTORY':
    case 'ACP_INVALID_PROMPT':
    case 'ACP_INVALID_TITLE':
    case 'ACP_INVALID_CONFIG':
    case 'ACP_INVALID_REQUEST':
      return 400;
    case 'ACP_SESSIONS_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
};

const sendError = (res, error) => {
  if (error instanceof AcpBackendError || typeof error?.code === 'string') {
    const payload = { error: error.message, code: error.code ?? 'ACP_ERROR' };
    if (Array.isArray(error.issues)) payload.issues = error.issues;
    res.status(statusForError(error)).json(payload);
    return;
  }
  res.status(500).json({ error: error?.message ?? 'ACP request failed', code: 'ACP_ERROR' });
};

const directoryOf = (req) =>
  req.query?.directory ?? req.body?.directory ?? req.headers?.['x-opencode-directory'] ?? null;

export const registerAcpRoutes = (app, { registry, manager, sessions = null, publishSyncFrame = null }) => {
  if (!registry || !manager) {
    throw new Error('registerAcpRoutes requires a registry and manager');
  }

  if (sessions && typeof sessions.events?.on === 'function' && typeof publishSyncFrame === 'function') {
    sessions.events.on('sync', ({ directory, events }) => {
      try {
        publishSyncFrame({ type: 'openchamber:acp-sync', properties: { directory, events } });
      } catch {
        // Fan-out must never break the turn that produced the events.
      }
    });
  }

  const requireSessions = (res) => {
    if (sessions) return true;
    res.status(503).json({ error: 'ACP sessions are not available', code: 'ACP_SESSIONS_UNAVAILABLE' });
    return false;
  };

  app.get('/api/acp/backends', async (_req, res) => {
    try {
      const backends = await manager.listStatuses();
      res.json({
        backends: backends.map(({ entry, ...status }) => ({
          ...status,
          label: entry.label,
          enabled: entry.enabled !== false,
          entry,
        })),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/acp/backends', jsonBody, async (req, res) => {
    try {
      const backends = req.body?.backends ?? req.body;
      await registry.save(backends);
      const statuses = await manager.listStatuses();
      res.json({
        backends: statuses.map(({ entry, ...status }) => ({
          ...status,
          label: entry.label,
          enabled: entry.enabled !== false,
          entry,
        })),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/backends/:id/restart', async (req, res) => {
    try {
      res.json({ backend: await manager.restart(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/backends/:id/authenticate', jsonBody, async (req, res) => {
    try {
      const methodId = req.body?.methodId;
      if (typeof methodId !== 'string' || !methodId) {
        res.status(400).json({ error: 'methodId must be a non-empty string', code: 'ACP_INVALID_REQUEST' });
        return;
      }
      res.json({ backend: await manager.authenticate(req.params.id, methodId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/sessions', jsonBody, async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const { backendId, directory, title } = req.body ?? {};
      if (typeof backendId !== 'string' || !backendId) {
        res.status(400).json({ error: 'backendId must be a non-empty string', code: 'ACP_INVALID_REQUEST' });
        return;
      }
      const resolved = directory ?? req.headers?.['x-opencode-directory'];
      const { session } = await sessions.create({ backendId, directory: resolved, title });
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/sessions', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      res.json({ sessions: await sessions.list({ directory: directoryOf(req) }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Before `/:key`: Express matches in registration order.
  app.get('/api/acp/sessions/status', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      res.json({ statuses: await sessions.status({ directory: directoryOf(req) }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/sessions/:key', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const { session } = await sessions.open({ key: req.params.key });
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch('/api/acp/sessions/:key', jsonBody, async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const { title } = req.body ?? {};
      if (typeof title !== 'string' || !title.trim()) {
        res.status(400).json({ error: 'title must be a non-empty string', code: 'ACP_INVALID_REQUEST' });
        return;
      }
      const { session } = await sessions.rename({ key: req.params.key, title });
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/acp/sessions/:key', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      await sessions.delete({ key: req.params.key });
      res.json({ deleted: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/sessions/:key/message', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const limit = req.query?.limit !== undefined ? Number(req.query.limit) : undefined;
      const before = typeof req.query?.before === 'string' ? req.query.before : undefined;
      res.json(await sessions.messages({ key: req.params.key, limit, before }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/sessions/:key/message/:messageId', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      res.json(await sessions.message({ key: req.params.key, messageId: req.params.messageId }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/sessions/:key/prompt', promptBody, async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const { messageId, parts } = req.body ?? {};
      if (typeof messageId !== 'string' || !messageId) {
        res.status(400).json({ error: 'messageId must be a non-empty string', code: 'ACP_INVALID_REQUEST' });
        return;
      }
      if (!Array.isArray(parts) || parts.length === 0) {
        res.status(400).json({ error: 'parts must be a non-empty array', code: 'ACP_INVALID_REQUEST' });
        return;
      }
      await sessions.prompt({ key: req.params.key, messageId, parts });
      res.status(202).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/sessions/:key/cancel', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const cancelled = await sessions.cancel({ key: req.params.key });
      if (!cancelled) {
        res.status(204).end();
        return;
      }
      res.json({ cancelled: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/sessions/:key/config', jsonBody, async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const { configId, value } = req.body ?? {};
      if (typeof configId !== 'string' || !configId) {
        res.status(400).json({ error: 'configId must be a non-empty string', code: 'ACP_INVALID_REQUEST' });
        return;
      }
      await sessions.config({ key: req.params.key, configId, value });
      res.json({});
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/sessions/:key/commands', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      res.json({ commands: await sessions.commands({ key: req.params.key }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/sessions/:key/permissions/:requestId/reply', jsonBody, async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const { reply } = req.body ?? {};
      if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
        res.status(400).json({ error: 'reply must be once, always or reject', code: 'ACP_INVALID_REQUEST' });
        return;
      }
      await sessions.replyPermission({ key: req.params.key, requestId: req.params.requestId, reply });
      res.json({});
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/sessions/:key/permissions/:requestId', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      res.json(await sessions.getPermission({ key: req.params.key, requestId: req.params.requestId }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/sessions/:key/forms/:formId/reply', jsonBody, async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      const { answer } = req.body ?? {};
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
        res.status(400).json({ error: 'answer must be an object', code: 'ACP_INVALID_REQUEST' });
        return;
      }
      await sessions.replyForm({ key: req.params.key, formId: req.params.formId, answer });
      res.json({});
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/acp/sessions/:key/forms/:formId/cancel', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      await sessions.cancelForm({ key: req.params.key, formId: req.params.formId });
      res.json({});
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/permissions', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      res.json({ permissions: await sessions.listPendingPermissions({ directory: directoryOf(req) }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/forms', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      res.json({ forms: await sessions.listPendingForms({ directory: directoryOf(req) }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/acp/backends/:id/config-cache', async (req, res) => {
    try {
      if (!requireSessions(res)) return;
      res.json({ configOptions: await sessions.configCache({ backendId: req.params.id }) });
    } catch (error) {
      sendError(res, error);
    }
  });
};
