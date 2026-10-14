import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createAcpBackendManager } from '../../core/backend-manager.js';
import { createAcpBackendRegistry } from '../../core/registry.js';
import { registerAcpRoutes } from '../routes.js';

const FAKE_AGENT = fileURLToPath(new URL('../../core/__tests__/fake-agent.mjs', import.meta.url));

const createApp = () => {
  const routes = new Map();
  return {
    app: {
      get: (routePath, handler) => { routes.set(`GET ${routePath}`, handler); },
      put: (routePath, ...handlers) => { routes.set(`PUT ${routePath}`, handlers.at(-1)); },
      post: (routePath, ...handlers) => { routes.set(`POST ${routePath}`, handlers.at(-1)); },
      patch: (routePath, ...handlers) => { routes.set(`PATCH ${routePath}`, handlers.at(-1)); },
      delete: (routePath, handler) => { routes.set(`DELETE ${routePath}`, handler); },
    },
    call: async (method, routePath, { params = {}, body } = {}) => {
      const handler = routes.get(`${method} ${routePath}`);
      if (!handler) throw new Error(`no route ${method} ${routePath}`);
      let statusCode = 200;
      let payload = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (value) => { payload = value; return res; },
      };
      await handler({ params, body }, res);
      return { statusCode, payload };
    },
  };
};

const setup = async (entries) => {
  const registry = createAcpBackendRegistry({
    dataDir: await mkdtemp(join(tmpdir(), 'acp-routes-')),
    resolveCommand: () => null,
  });
  await registry.save(entries ?? [{
    id: 'fake',
    label: 'fake',
    command: process.execPath,
    args: [FAKE_AGENT],
    enabled: true,
  }]);
  const { spawnAcpAgent } = await import('../../core/spawn.js');
  const manager = createAcpBackendManager({
    registry,
    // Never touch the operator's real managed-process registry.
    spawnAgent: (options) => spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} }),
  });
  const { app, call } = createApp();
  registerAcpRoutes(app, { registry, manager });
  return { registry, manager, call };
};

describe('acp http routes', () => {
  it('lists backends with status', async () => {
    const { manager, call } = await setup();
    try {
      const { statusCode, payload } = await call('GET', '/api/acp/backends');
      expect(statusCode).toBe(200);
      expect(payload.backends).toHaveLength(1);
      expect(payload.backends[0]).toMatchObject({ id: 'fake', state: 'idle' });
      expect(payload.backends[0].entry.command).toBe(process.execPath);
    } finally {
      await manager.shutdown();
    }
  });

  it('replaces the registry on PUT and rejects bad payloads', async () => {
    const { manager, call } = await setup();
    try {
      const ok = await call('PUT', '/api/acp/backends', {
        body: { backends: [{ id: 'x', label: 'x', command: 'x', args: [], enabled: true }] },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.payload.backends.map((entry) => entry.id)).toEqual(['x']);

      const bad = await call('PUT', '/api/acp/backends', { body: { backends: [{ id: 'BAD!' }] } });
      expect(bad.statusCode).toBe(422);
      expect(bad.payload.code).toBe('ACP_REGISTRY_INVALID');
    } finally {
      await manager.shutdown();
    }
  });

  it('restarts a backend through POST', async () => {
    const { manager, call } = await setup();
    try {
      const { statusCode, payload } = await call('POST', '/api/acp/backends/:id/restart', {
        params: { id: 'fake' },
      });
      expect(statusCode).toBe(200);
      expect(payload.backend).toMatchObject({ id: 'fake', state: 'ready', protocolVersion: 1 });

      const missing = await call('POST', '/api/acp/backends/:id/restart', { params: { id: 'ghost' } });
      expect(missing.statusCode).toBe(404);
    } finally {
      await manager.shutdown();
    }
  });

  it('PUT removing a live backend stops its process', async () => {
    const { manager, call } = await setup();
    try {
      await call('POST', '/api/acp/backends/:id/restart', { params: { id: 'fake' } });
      expect((await manager.status('fake')).state).toBe('ready');
      const removed = await call('PUT', '/api/acp/backends', { body: { backends: [] } });
      expect(removed.statusCode).toBe(200);
      expect(removed.payload.backends).toEqual([]);
      // The process is gone and the backend no longer serves.
      expect((await manager.status('fake')).state).toBe('unconfigured');
      const restart = await call('POST', '/api/acp/backends/:id/restart', { params: { id: 'fake' } });
      expect(restart.statusCode).toBe(404);
      expect(restart.payload.code).toBe('ACP_BACKEND_UNKNOWN');
    } finally {
      await manager.shutdown();
    }
  });

  it('PUT disabling a live backend stops it and reports unconfigured', async () => {
    const { manager, call } = await setup();
    try {
      await call('POST', '/api/acp/backends/:id/restart', { params: { id: 'fake' } });
      const disabled = await call('PUT', '/api/acp/backends', {
        body: {
          backends: [{
            id: 'fake', label: 'fake', command: process.execPath,
            args: [FAKE_AGENT], enabled: false,
          }],
        },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.payload.backends[0].state).toBe('unconfigured');
      const restart = await call('POST', '/api/acp/backends/:id/restart', { params: { id: 'fake' } });
      expect(restart.statusCode).toBe(409);
      expect(restart.payload.code).toBe('ACP_BACKEND_DISABLED');
    } finally {
      await manager.shutdown();
    }
  });

  it('authenticates through POST and validates the body', async () => {
    const { manager, call } = await setup([{
      id: 'fake',
      label: 'fake',
      command: process.execPath,
      args: [FAKE_AGENT],
      enabled: true,
      env: {
        FAKE_ACP_AUTHENTICATE: '1',
        FAKE_ACP_AUTH_METHODS: JSON.stringify([{ id: 'm1', name: 'M1' }]),
      },
    }]);
    try {
      const ok = await call('POST', '/api/acp/backends/:id/authenticate', {
        params: { id: 'fake' },
        body: { methodId: 'm1' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.payload.backend.state).toBe('ready');

      const empty = await call('POST', '/api/acp/backends/:id/authenticate', {
        params: { id: 'fake' },
        body: {},
      });
      expect(empty.statusCode).toBe(400);

      const unknown = await call('POST', '/api/acp/backends/:id/authenticate', {
        params: { id: 'fake' },
        body: { methodId: 'ghost' },
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await manager.shutdown();
    }
  });
});
