import { describe, expect, it } from 'vitest';

import { registerAcpRoutes } from '../routes.js';

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

const coded = (code, message = code) => Object.assign(new Error(message), { code });

const setup = ({ sessions = null, oneOff = null, manager = null, registry = null } = {}) => {
  const { app, call } = createApp();
  registerAcpRoutes(app, {
    registry: registry ?? {},
    manager: manager ?? {},
    ...(sessions === undefined ? {} : { sessions }),
    ...(oneOff === undefined ? {} : { oneOff }),
  });
  return { call };
};

describe('wave-d checkpoints routes', () => {
  it('lists checkpoints as a bare array', async () => {
    const checkpoints = [{ turn: 1, complete: true }, { turn: 2, complete: false }];
    const calls = [];
    const { call } = setup({
      sessions: { checkpoints: async (args) => { calls.push(args); return checkpoints; } },
    });
    const { statusCode, payload } = await call('GET', '/api/acp/sessions/:key/checkpoints', {
      params: { key: 'sess-1' },
    });
    expect(statusCode).toBe(200);
    expect(payload).toEqual(checkpoints);
    expect(Array.isArray(payload)).toBe(true);
    expect(calls).toEqual([{ key: 'sess-1' }]);
  });

  it('answers 503 without sessions', async () => {
    const { call } = setup({ sessions: null });
    const { statusCode, payload } = await call('GET', '/api/acp/sessions/:key/checkpoints', {
      params: { key: 'sess-1' },
    });
    expect(statusCode).toBe(503);
    expect(payload.code).toBe('ACP_SESSIONS_UNAVAILABLE');
  });

  it('maps unknown session to 404', async () => {
    const { call } = setup({
      sessions: { checkpoints: async () => { throw coded('ACP_SESSION_UNKNOWN'); } },
    });
    const { statusCode, payload } = await call('GET', '/api/acp/sessions/:key/checkpoints', {
      params: { key: 'missing' },
    });
    expect(statusCode).toBe(404);
    expect(payload.code).toBe('ACP_SESSION_UNKNOWN');
  });
});

describe('wave-d diff route', () => {
  const diffs = [
    { file: 'a.txt', patch: '@@ -1 +1 @@', additions: 1, deletions: 1, status: 'modified' },
  ];

  it('returns diffs as a bare array', async () => {
    const calls = [];
    const { call } = setup({
      sessions: { diff: async (args) => { calls.push(args); return diffs; } },
    });
    const { statusCode, payload } = await call('GET', '/api/acp/sessions/:key/diff', {
      params: { key: 'sess-1' },
      query: { turn: '2' },
    });
    expect(statusCode).toBe(200);
    expect(payload).toEqual(diffs);
    expect(Array.isArray(payload)).toBe(true);
    expect(calls).toEqual([{ key: 'sess-1', turn: 2 }]);
  });

  it.each([
    ['missing', {}],
    ['zero', { turn: '0' }],
    ['negative', { turn: '-1' }],
    ['non-numeric', { turn: 'nope' }],
    ['fractional', { turn: '1.5' }],
  ])('rejects invalid turn (%s) with 400', async (_label, query) => {
    let called = false;
    const { call } = setup({
      sessions: { diff: async () => { called = true; return diffs; } },
    });
    const { statusCode, payload } = await call('GET', '/api/acp/sessions/:key/diff', {
      params: { key: 'sess-1' },
      query,
    });
    expect(statusCode).toBe(400);
    expect(payload.code).toBe('ACP_INVALID_REQUEST');
    expect(called).toBe(false);
  });

  it('answers 503 without sessions', async () => {
    const { call } = setup({ sessions: null });
    const { statusCode, payload } = await call('GET', '/api/acp/sessions/:key/diff', {
      params: { key: 'sess-1' },
      query: { turn: '1' },
    });
    expect(statusCode).toBe(503);
    expect(payload.code).toBe('ACP_SESSIONS_UNAVAILABLE');
  });

  it('maps unknown checkpoint to 404', async () => {
    const { call } = setup({
      sessions: { diff: async () => { throw coded('ACP_CHECKPOINT_UNKNOWN'); } },
    });
    const { statusCode, payload } = await call('GET', '/api/acp/sessions/:key/diff', {
      params: { key: 'sess-1' },
      query: { turn: '9' },
    });
    expect(statusCode).toBe(404);
    expect(payload.code).toBe('ACP_CHECKPOINT_UNKNOWN');
  });

  it('maps incomplete checkpoint to 422', async () => {
    const { call } = setup({
      sessions: { diff: async () => { throw coded('ACP_CHECKPOINT_INCOMPLETE'); } },
    });
    const { statusCode, payload } = await call('GET', '/api/acp/sessions/:key/diff', {
      params: { key: 'sess-1' },
      query: { turn: '3' },
    });
    expect(statusCode).toBe(422);
    expect(payload.code).toBe('ACP_CHECKPOINT_INCOMPLETE');
  });
});

describe('wave-d revert route', () => {
  const session = { id: 'sess-1' };
  const revertResult = { restored: ['a.txt'], removed: ['b.txt'], skipped: [{ file: 'c.txt', reason: 'busy' }], session };

  it('reverts and returns the envelope', async () => {
    const calls = [];
    const { call } = setup({
      sessions: { revert: async (args) => { calls.push(args); return revertResult; } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/revert', {
      params: { key: 'sess-1' },
      body: { turn: 2 },
    });
    expect(statusCode).toBe(200);
    expect(payload).toEqual(revertResult);
    expect(calls).toEqual([{ key: 'sess-1', turn: 2 }]);
  });

  it.each([
    ['missing', undefined],
    ['null body', null],
    ['missing turn', {}],
    ['zero', { turn: 0 }],
    ['negative', { turn: -2 }],
    ['fractional', { turn: 1.5 }],
    ['string', { turn: '2' }],
  ])('rejects invalid turn (%s) with 400', async (_label, body) => {
    let called = false;
    const { call } = setup({
      sessions: { revert: async () => { called = true; return revertResult; } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/revert', {
      params: { key: 'sess-1' },
      body,
    });
    expect(statusCode).toBe(400);
    expect(payload.code).toBe('ACP_INVALID_REQUEST');
    expect(called).toBe(false);
  });

  it('answers 503 without sessions', async () => {
    const { call } = setup({ sessions: null });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/revert', {
      params: { key: 'sess-1' },
      body: { turn: 1 },
    });
    expect(statusCode).toBe(503);
    expect(payload.code).toBe('ACP_SESSIONS_UNAVAILABLE');
  });

  it('maps busy session to 409', async () => {
    const { call } = setup({
      sessions: { revert: async () => { throw coded('ACP_SESSION_BUSY'); } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/revert', {
      params: { key: 'sess-1' },
      body: { turn: 1 },
    });
    expect(statusCode).toBe(409);
    expect(payload.code).toBe('ACP_SESSION_BUSY');
  });

  it('maps incomplete checkpoint to 422', async () => {
    const { call } = setup({
      sessions: { revert: async () => { throw coded('ACP_CHECKPOINT_INCOMPLETE'); } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/revert', {
      params: { key: 'sess-1' },
      body: { turn: 1 },
    });
    expect(statusCode).toBe(422);
    expect(payload.code).toBe('ACP_CHECKPOINT_INCOMPLETE');
  });
});

describe('wave-d oneoff route', () => {
  const baseBody = { instruction: 'summarize', input: 'diff text' };
  const generateResult = { text: 'summary', usage: { totalTokens: 3 }, sessionCleanup: 'deleted' };

  it('resolves then generates and merges the backend id', async () => {
    const resolveCalls = [];
    const generateCalls = [];
    const oneOff = {
      resolveBackend: async (args) => { resolveCalls.push(args); return 'backend-a'; },
      generate: async (args) => { generateCalls.push(args); return generateResult; },
    };
    const { call } = setup({ oneOff });
    const { statusCode, payload } = await call('POST', '/api/acp/oneoff', {
      body: { ...baseBody, backendId: 'backend-a', sessionKey: 'sess-1', maxChars: 100 },
    });
    expect(statusCode).toBe(200);
    expect(payload).toEqual({ ...generateResult, backendId: 'backend-a' });
    expect(resolveCalls).toEqual([{ backendId: 'backend-a', sessionKey: 'sess-1' }]);
    expect(generateCalls).toEqual([{
      backendId: 'backend-a',
      instruction: 'summarize',
      input: 'diff text',
      maxChars: 100,
      sessionKey: 'sess-1',
    }]);
  });

  it('omits maxChars from generate when absent', async () => {
    const generateCalls = [];
    const oneOff = {
      resolveBackend: async () => 'backend-a',
      generate: async (args) => { generateCalls.push(args); return generateResult; },
    };
    const { call } = setup({ oneOff });
    const { statusCode } = await call('POST', '/api/acp/oneoff', { body: baseBody });
    expect(statusCode).toBe(200);
    expect(generateCalls).toEqual([{ backendId: 'backend-a', instruction: 'summarize', input: 'diff text' }]);
    expect('maxChars' in generateCalls[0]).toBe(false);
  });

  it.each([
    ['missing body', undefined],
    ['missing instruction', { input: 'x' }],
    ['empty instruction', { instruction: '', input: 'x' }],
    ['non-string instruction', { instruction: 42, input: 'x' }],
    ['missing input', { instruction: 'do' }],
    ['non-string input', { instruction: 'do', input: 42 }],
    ['NaN maxChars', { ...baseBody, maxChars: Number.NaN }],
    ['infinite maxChars', { ...baseBody, maxChars: Number.POSITIVE_INFINITY }],
    ['negative maxChars', { ...baseBody, maxChars: -1 }],
    ['non-number maxChars', { ...baseBody, maxChars: '100' }],
    ['empty backendId', { ...baseBody, backendId: '' }],
    ['non-string backendId', { ...baseBody, backendId: 42 }],
    ['empty sessionKey', { ...baseBody, sessionKey: '' }],
    ['non-string sessionKey', { ...baseBody, sessionKey: 42 }],
  ])('rejects invalid payload (%s) with 400', async (_label, body) => {
    let resolved = false;
    let generated = false;
    const oneOff = {
      resolveBackend: async () => { resolved = true; return 'backend-a'; },
      generate: async () => { generated = true; return generateResult; },
    };
    const { call } = setup({ oneOff });
    const { statusCode, payload } = await call('POST', '/api/acp/oneoff', { body });
    expect(statusCode).toBe(400);
    expect(payload.code).toBe('ACP_INVALID_REQUEST');
    expect(resolved).toBe(false);
    expect(generated).toBe(false);
  });

  it('answers 503 without oneOff', async () => {
    const { call } = setup({ oneOff: null });
    const { statusCode, payload } = await call('POST', '/api/acp/oneoff', { body: baseBody });
    expect(statusCode).toBe(503);
    expect(payload.code).toBe('ACP_ONEOFF_UNAVAILABLE');
  });

  it('maps unavailable backend to 503', async () => {
    const oneOff = {
      resolveBackend: async () => { throw coded('ACP_BACKEND_UNAVAILABLE'); },
      generate: async () => generateResult,
    };
    const { call } = setup({ oneOff });
    const { statusCode, payload } = await call('POST', '/api/acp/oneoff', { body: baseBody });
    expect(statusCode).toBe(503);
    expect(payload.code).toBe('ACP_BACKEND_UNAVAILABLE');
  });

  it('maps unknown backend to 404', async () => {
    const oneOff = {
      resolveBackend: async () => { throw coded('ACP_BACKEND_UNKNOWN'); },
      generate: async () => generateResult,
    };
    const { call } = setup({ oneOff });
    const { statusCode, payload } = await call('POST', '/api/acp/oneoff', { body: baseBody });
    expect(statusCode).toBe(404);
    expect(payload.code).toBe('ACP_BACKEND_UNKNOWN');
  });

  it('maps invalid generation to 400', async () => {
    const oneOff = {
      resolveBackend: async () => 'backend-a',
      generate: async () => { throw coded('ACP_ONEOFF_INVALID'); },
    };
    const { call } = setup({ oneOff });
    const { statusCode, payload } = await call('POST', '/api/acp/oneoff', { body: baseBody });
    expect(statusCode).toBe(400);
    expect(payload.code).toBe('ACP_ONEOFF_INVALID');
  });

  it('maps generation timeout to 504', async () => {
    const oneOff = {
      resolveBackend: async () => 'backend-a',
      generate: async () => { throw coded('ACP_ONEOFF_TIMEOUT'); },
    };
    const { call } = setup({ oneOff });
    const { statusCode, payload } = await call('POST', '/api/acp/oneoff', { body: baseBody });
    expect(statusCode).toBe(504);
    expect(payload.code).toBe('ACP_ONEOFF_TIMEOUT');
  });

  it('maps agent failure to 502 with backend context', async () => {
    const failure = Object.assign(new Error('one-off generation on backend-a failed: boom'), {
      code: 'ACP_ONEOFF_FAILED', backendId: 'backend-a', agentCode: -32603,
    });
    const oneOff = {
      resolveBackend: async () => 'backend-a',
      generate: async () => { throw failure; },
    };
    const { call } = setup({ oneOff });
    const { statusCode, payload } = await call('POST', '/api/acp/oneoff', { body: baseBody });
    expect(statusCode).toBe(502);
    expect(payload).toEqual({
      error: 'one-off generation on backend-a failed: boom',
      code: 'ACP_ONEOFF_FAILED',
      backendId: 'backend-a',
      agentCode: -32603,
    });
  });
});

describe('wave-d auth-terminal route', () => {
  const terminal = { command: 'login', args: ['--auth'], env: { TERM: 'xterm' }, methodId: 'oauth' };

  it('returns spawn details and never calls authenticate', async () => {
    const calls = [];
    let authenticated = false;
    const { call } = setup({
      manager: {
        authTerminal: async (id, methodId) => { calls.push([id, methodId]); return terminal; },
        authenticate: async () => { authenticated = true; return {}; },
      },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/backends/:id/auth/terminal', {
      params: { id: 'backend-a' },
      body: { methodId: 'oauth' },
    });
    expect(statusCode).toBe(200);
    expect(payload).toEqual(terminal);
    expect(calls).toEqual([['backend-a', 'oauth']]);
    expect(authenticated).toBe(false);
  });

  it('passes undefined methodId through', async () => {
    const calls = [];
    const { call } = setup({
      manager: { authTerminal: async (id, methodId) => { calls.push([id, methodId]); return terminal; } },
    });
    const { statusCode } = await call('POST', '/api/acp/backends/:id/auth/terminal', {
      params: { id: 'backend-a' },
      body: {},
    });
    expect(statusCode).toBe(200);
    expect(calls).toEqual([['backend-a', undefined]]);
  });

  it.each([
    ['empty', { methodId: '' }],
    ['non-string', { methodId: 42 }],
  ])('rejects invalid methodId (%s) with 400', async (_label, body) => {
    let called = false;
    const { call } = setup({
      manager: { authTerminal: async () => { called = true; return terminal; } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/backends/:id/auth/terminal', {
      params: { id: 'backend-a' },
      body,
    });
    expect(statusCode).toBe(400);
    expect(payload.code).toBe('ACP_INVALID_REQUEST');
    expect(called).toBe(false);
  });

  it('maps unknown backend to 404', async () => {
    const { call } = setup({
      manager: { authTerminal: async () => { throw coded('ACP_BACKEND_UNKNOWN'); } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/backends/:id/auth/terminal', {
      params: { id: 'missing' },
      body: {},
    });
    expect(statusCode).toBe(404);
    expect(payload.code).toBe('ACP_BACKEND_UNKNOWN');
  });

  it('maps non-terminal method to 400', async () => {
    const { call } = setup({
      manager: { authTerminal: async () => { throw coded('ACP_AUTH_NOT_TERMINAL'); } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/backends/:id/auth/terminal', {
      params: { id: 'backend-a' },
      body: { methodId: 'api-key' },
    });
    expect(statusCode).toBe(400);
    expect(payload.code).toBe('ACP_AUTH_NOT_TERMINAL');
  });
});

describe('explicit fork route', () => {
  it('returns the forked session', async () => {
    const session = { id: 'fork-1' };
    const calls = [];
    const { call } = setup({
      sessions: { fork: async (args) => { calls.push(args); return { session }; } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/fork', {
      params: { key: 'sess-1' },
    });
    expect(statusCode).toBe(200);
    expect(payload).toEqual({ session });
    expect(calls).toEqual([{ key: 'sess-1' }]);
  });

  it('answers 503 without sessions', async () => {
    const { call } = setup({ sessions: null });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/fork', {
      params: { key: 'sess-1' },
    });
    expect(statusCode).toBe(503);
    expect(payload.code).toBe('ACP_SESSIONS_UNAVAILABLE');
  });

  it('maps unsupported fork to 409', async () => {
    const { call } = setup({
      sessions: { fork: async () => { throw coded('ACP_FORK_UNSUPPORTED'); } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/fork', {
      params: { key: 'sess-1' },
    });
    expect(statusCode).toBe(409);
    expect(payload.code).toBe('ACP_FORK_UNSUPPORTED');
  });

  it('maps busy session to 409', async () => {
    const { call } = setup({
      sessions: { fork: async () => { throw coded('ACP_SESSION_BUSY'); } },
    });
    const { statusCode, payload } = await call('POST', '/api/acp/sessions/:key/fork', {
      params: { key: 'sess-1' },
    });
    expect(statusCode).toBe(409);
    expect(payload.code).toBe('ACP_SESSION_BUSY');
  });
});
