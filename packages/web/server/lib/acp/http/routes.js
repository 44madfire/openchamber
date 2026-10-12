/**
 * Express adapter for the ACP backend registry and manager (M1: backends
 * only; session routes arrive in later phases).
 *
 * - `GET /api/acp/backends` → entries with live status.
 * - `PUT /api/acp/backends` → replace the registry (validated).
 * - `POST /api/acp/backends/:id/restart` → stop and start fresh.
 * - `POST /api/acp/backends/:id/authenticate` → `{ methodId }`.
 */

import express from 'express';

import { AcpBackendError } from '../core/backend-manager.js';

const jsonBody = express.json({ limit: '256kb' });

const statusForError = (error) => {
  switch (error?.code) {
    case 'ACP_BACKEND_UNKNOWN':
    case 'ACP_AUTH_UNKNOWN_METHOD':
      return 404;
    case 'ACP_BACKEND_DISABLED':
    case 'ACP_AUTH_TERMINAL':
      return 409;
    case 'ACP_REGISTRY_INVALID':
    case 'ACP_REGISTRY_CORRUPT':
      return 422;
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

export const registerAcpRoutes = (app, { registry, manager }) => {
  if (!registry || !manager) {
    throw new Error('registerAcpRoutes requires a registry and manager');
  }

  app.get('/api/acp/backends', async (_req, res) => {
    try {
      res.json({ backends: await manager.listStatuses() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/acp/backends', jsonBody, async (req, res) => {
    try {
      const backends = req.body?.backends ?? req.body;
      await registry.save(backends);
      res.json({ backends: await manager.listStatuses() });
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
};
