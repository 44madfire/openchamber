import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createAcpBackendManager } from '../../core/backend-manager.js';
import { createAcpBackendRegistry } from '../../core/registry.js';
import { createAcpSessionIndex } from '../../core/session-index.js';
import { createAcpSessionService } from '../../core/sessions.js';
import { registerAcpRoutes } from '../routes.js';

const FAKE_AGENT = fileURLToPath(new URL('../../core/__tests__/fake-agent.mjs', import.meta.url));

const createApp = () => {
  const routes = new Map();
  const order = [];
  return {
    app: {
      get: (routePath, handler) => { routes.set(`GET ${routePath}`, handler); order.push(`GET ${routePath}`); },
      put: (routePath, ...handlers) => { routes.set(`PUT ${routePath}`, handlers.at(-1)); order.push(`PUT ${routePath}`); },
      post: (routePath, ...handlers) => { routes.set(`POST ${routePath}`, handlers.at(-1)); order.push(`POST ${routePath}`); },
      patch: (routePath, ...handlers) => { routes.set(`PATCH ${routePath}`, handlers.at(-1)); order.push(`PATCH ${routePath}`); },
      delete: (routePath, handler) => { routes.set(`DELETE ${routePath}`, handler); order.push(`DELETE ${routePath}`); },
    },
    order,
    call: async (method, routePath, { params = {}, body, query = {}, headers = {} } = {}) => {
      const handler = routes.get(`${method} ${routePath}`);
      if (!handler) throw new Error(`no route ${method} ${routePath}`);
      let statusCode = 200;
      let payload;
      let ended = false;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (value) => { payload = value; return res; },
        end: () => { ended = true; return res; },
      };
      await handler({ params, body, query, headers }, res);
      return { statusCode, payload, ended };
    },
  };
};

const setup = async ({ entry = {}, publishSyncFrame = null } = {}) => {
  const registry = createAcpBackendRegistry({
    dataDir: await mkdtemp(join(tmpdir(), 'acp-session-routes-reg-')),
    resolveCommand: () => null,
  });
  await registry.save([{
    id: 'fake', label: 'fake', command: process.execPath, args: [FAKE_AGENT], enabled: true, ...entry,
  }]);
  const { spawnAcpAgent } = await import('../../core/spawn.js');
  const spawnAgent = (options) =>
    spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} });
  const holder = { current: null };
  const manager = createAcpBackendManager({
    registry,
    spawnAgent,
    stderrFlushMs: 10,
    connectionHooks: (backendId, generation) => holder.current?.hooksForBackend(backendId, generation) ?? {},
  });
  const index = createAcpSessionIndex({ dataDir: await mkdtemp(join(tmpdir(), 'acp-session-routes-idx-')) });
  const service = createAcpSessionService({ manager, index, registry, settleMs: 5, watchdogMs: 500 });
  holder.current = service;
  const { app, call, order } = createApp();
  registerAcpRoutes(app, { registry, manager, sessions: service, publishSyncFrame });
  return {
    manager, service, call, order,
    shutdown: async () => { service.dispose(); await manager.shutdown(); },
  };
};

const until = async (predicate, { timeout = 5000 } = {}) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('acp session http routes', () => {
  it('registers /status before /:key', async () => {
    const { shutdown, order } = await setup();
    try {
      const statusAt = order.indexOf('GET /api/acp/sessions/status');
      const keyAt = order.indexOf('GET /api/acp/sessions/:key');
      expect(statusAt).toBeGreaterThan(-1);
      expect(keyAt).toBeGreaterThan(-1);
      expect(statusAt).toBeLessThan(keyAt);
    } finally {
      await shutdown();
    }
  });

  it('creates, opens, lists, renames and deletes a session', async () => {
    const { shutdown, call } = await setup();
    try {
      const created = await call('POST', '/api/acp/sessions', {
        body: { backendId: 'fake', directory: 'C:\\work' },
      });
      expect(created.statusCode).toBe(200);
      const key = created.payload.session.id;
      expect(key).toMatch(/^ses_acp-fake_r/);

      const opened = await call('GET', '/api/acp/sessions/:key', { params: { key } });
      expect(opened.statusCode).toBe(200);
      expect(opened.payload.session.id).toBe(key);

      const listed = await call('GET', '/api/acp/sessions', { query: { directory: 'C:\\work' } });
      expect(listed.payload.sessions.map((row) => row.id)).toEqual([key]);

      const renamed = await call('PATCH', '/api/acp/sessions/:key', { params: { key }, body: { title: 'renamed' } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.payload.session.title).toBe('renamed');

      const deleted = await call('DELETE', '/api/acp/sessions/:key', { params: { key } });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.payload).toEqual({ deleted: true });

      const gone = await call('GET', '/api/acp/sessions/:key', { params: { key } });
      expect(gone.statusCode).toBe(404);
      expect(gone.payload.code).toBe('ACP_SESSION_UNKNOWN');
    } finally {
      await shutdown();
    }
  });

  it('prompts with 202, pages messages, cancels with 200/204', async () => {
    const { shutdown, call } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there' } } },
          ]),
        },
      },
    });
    try {
      const created = await call('POST', '/api/acp/sessions', { body: { backendId: 'fake', directory: 'C:\\work' } });
      const key = created.payload.session.id;

      const prompted = await call('POST', '/api/acp/sessions/:key/prompt', {
        params: { key },
        body: { messageId: 'msg_1', parts: [{ type: 'text', text: 'hello' }] },
      });
      expect(prompted.statusCode).toBe(202);
      expect(prompted.payload).toBeUndefined();
      expect(prompted.ended).toBe(true);

      await until(async () => {
        const page = await call('GET', '/api/acp/sessions/:key/message', { params: { key }, query: { limit: '10' } });
        return page.payload.items.length === 2 && page.payload.items[0].info.finish === 'stop' && page;
      });
      const page = await call('GET', '/api/acp/sessions/:key/message', { params: { key }, query: { limit: '10' } });
      expect(page.payload.items.map((item) => item.info.role)).toEqual(['assistant', 'user']);
      expect(page.payload.cursor).toEqual({});

      // Idle cancel → 204.
      const idle = await call('POST', '/api/acp/sessions/:key/cancel', { params: { key } });
      expect(idle.statusCode).toBe(204);
    } finally {
      await shutdown();
    }
  });

  it('409s a prompt while busy', async () => {
    const { shutdown, call } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 400 }]) } },
    });
    try {
      const created = await call('POST', '/api/acp/sessions', { body: { backendId: 'fake', directory: 'C:\\work' } });
      const key = created.payload.session.id;
      await call('POST', '/api/acp/sessions/:key/prompt', {
        params: { key }, body: { messageId: 'msg_1', parts: [{ type: 'text', text: 'one' }] },
      });
      const busy = await call('POST', '/api/acp/sessions/:key/prompt', {
        params: { key }, body: { messageId: 'msg_2', parts: [{ type: 'text', text: 'two' }] },
      });
      expect(busy.statusCode).toBe(409);
      expect(busy.payload.code).toBe('ACP_SESSION_BUSY');

      const cancelled = await call('POST', '/api/acp/sessions/:key/cancel', { params: { key } });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.payload).toEqual({ cancelled: true });
    } finally {
      await shutdown();
    }
  });

  it('serves the status map and validates inputs', async () => {
    const { shutdown, call } = await setup();
    try {
      const created = await call('POST', '/api/acp/sessions', { body: { backendId: 'fake', directory: 'C:\\work' } });
      const key = created.payload.session.id;
      const statuses = await call('GET', '/api/acp/sessions/status', { query: { directory: 'C:\\work' } });
      expect(statuses.statusCode).toBe(200);
      expect(statuses.payload).toEqual({ statuses: { [key]: { type: 'idle' } } });

      const noDir = await call('GET', '/api/acp/sessions', { query: {} });
      expect(noDir.statusCode).toBe(400);

      const noParts = await call('POST', '/api/acp/sessions/:key/prompt', {
        params: { key }, body: { messageId: 'm', parts: [] },
      });
      expect(noParts.statusCode).toBe(400);
    } finally {
      await shutdown();
    }
  });

  it('publishes sync frames through publishSyncFrame', async () => {
    const frames = [];
    const { shutdown, call } = await setup({
      publishSyncFrame: (frame) => { frames.push(frame); },
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yo' } } },
          ]),
        },
      },
    });
    try {
      const created = await call('POST', '/api/acp/sessions', { body: { backendId: 'fake', directory: 'C:\\work' } });
      const key = created.payload.session.id;
      await call('POST', '/api/acp/sessions/:key/prompt', {
        params: { key }, body: { messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] },
      });
      await until(() => frames.some((frame) =>
        frame.properties.events.some((event) => event.type === 'session.idle')));
      expect(frames[0]).toMatchObject({
        type: 'openchamber:acp-sync',
        properties: { directory: 'C:\\work' },
      });
      expect(frames.every((frame) => frame.type === 'openchamber:acp-sync')).toBe(true);
    } finally {
      await shutdown();
    }
  });

  it('serves one message with its parts, 404 when absent', async () => {
    const { shutdown, call } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yo' } } },
          ]),
        },
      },
    });
    try {
      const created = await call('POST', '/api/acp/sessions', { body: { backendId: 'fake', directory: 'C:\\work' } });
      const key = created.payload.session.id;
      await call('POST', '/api/acp/sessions/:key/prompt', {
        params: { key }, body: { messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] },
      });
      const record = await until(async () => {
        const res = await call('GET', '/api/acp/sessions/:key/message/:messageId', {
          params: { key, messageId: 'msg_1' },
        });
        return res.statusCode === 200 && res;
      });
      expect(record.payload.info).toMatchObject({ id: 'msg_1', role: 'user' });
      expect(record.payload.parts).toHaveLength(1);
      const missing = await call('GET', '/api/acp/sessions/:key/message/:messageId', {
        params: { key, messageId: 'msg_nope' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.payload.code).toBe('ACP_MESSAGE_UNKNOWN');
    } finally {
      await shutdown();
    }
  });

  it('answers 503 without a session service', async () => {
    const registry = createAcpBackendRegistry({
      dataDir: await mkdtemp(join(tmpdir(), 'acp-nosvc-')),
      resolveCommand: () => null,
    });
    const { spawnAcpAgent } = await import('../../core/spawn.js');
    const manager = createAcpBackendManager({
      registry,
      spawnAgent: (options) => spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} }),
    });
    const { app, call } = createApp();
    registerAcpRoutes(app, { registry, manager });
    try {
      const res = await call('GET', '/api/acp/sessions', { query: { directory: 'C:\\work' } });
      expect(res.statusCode).toBe(503);
      expect(res.payload.code).toBe('ACP_SESSIONS_UNAVAILABLE');
    } finally {
      await manager.shutdown();
    }
  });
});
