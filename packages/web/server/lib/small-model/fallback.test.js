import fs from 'fs';
import { registerSmallModelRoutes } from './routes.js';
import http from 'node:http';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

// The settings override is read straight from disk, so without this the suite
// would resolve whatever small model the developer running it has configured.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'small-model-fallback-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const {
  generateSmallModelText,
  describeSmallModel,
  setAcpOneOffFallback,
  getAcpOneOffFallback,
} = await import('./index.js');
const { configureOpenCodeRuntimeProviders, resetOpenCodeRuntimeProviders } = await import('./client.js');

// The same real-OpenCode-stub shape as `index.test.js`: the module talks to
// OpenCode through `@opencode/client`, so a socket exercises the request
// shapes the server sees — no module substitution, and no acp imports.
const state = {
  models: [],
  providers: [],
  defaultModel: null,
  titleModel: null,
  titleMissing: false,
  generate: () => ({ text: 'generated' }),
  requests: [],
  generateErrors: [],
};

const MODEL = (overrides = {}) => ({
  id: 'claude-haiku-4-5',
  modelID: 'claude-haiku-4-5',
  providerID: 'anthropic',
  name: 'Claude Haiku',
  enabled: true,
  limit: { context: 8_000, output: 4_000 },
  ...overrides,
});

const LOCATION = { directory: '/proj', project: { id: 'p', directory: '/proj', canonical: '/proj' } };

let server;
let baseUrl;

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    try {
      resolve(raw ? JSON.parse(raw) : {});
    } catch {
      resolve({});
    }
  });
});

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : {};
    state.requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });
    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/api/model') return send({ location: LOCATION, data: state.models });
    if (url.pathname === '/api/model/default') return send({ location: LOCATION, data: state.defaultModel });
    if (url.pathname === '/api/provider') return send({ location: LOCATION, data: state.providers });
    if (url.pathname === '/api/agent/title') {
      if (state.titleMissing) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ _tag: 'AgentNotFoundError', agentID: 'title', message: 'Agent not found: title' }));
      }
      const agent = {
        id: 'title',
        name: 'Title',
        request: { settings: {}, headers: {}, body: {} },
        mode: 'primary',
        hidden: true,
        permissions: [],
      };
      if (state.titleModel) agent.model = state.titleModel;
      return send({ location: LOCATION, data: agent });
    }
    if (url.pathname === '/api/experimental/generate') {
      const error = state.generateErrors.shift();
      if (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(error));
      }
      return send({ location: LOCATION, data: state.generate(body) });
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  state.models = [MODEL()];
  state.providers = [{ id: 'anthropic', name: 'Anthropic', activation: 'auto', package: 'x' }];
  state.defaultModel = MODEL();
  state.titleModel = null;
  state.titleMissing = false;
  state.generate = () => ({ text: 'generated' });
  state.requests = [];
  state.generateErrors = [];
  configureOpenCodeRuntimeProviders({
    buildOpenCodeUrl: (requestPath) => `${baseUrl}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
  });
  resetOpenCodeRuntimeProviders();
});

afterEach(() => {
  setAcpOneOffFallback(null);
});

const stubProvider = (overrides = {}) => {
  const calls = { resolveBackend: [], generate: [] };
  return {
    calls,
    provider: {
      resolveBackend: async (options) => {
        calls.resolveBackend.push(options);
        return overrides.backendId ?? 'acp-backend';
      },
      generate: async (options) => {
        calls.generate.push(options);
        if (overrides.generate) return overrides.generate(options);
        return { text: '  fallback text  ', warnings: ['helper ignored'] };
      },
    },
  };
};

const lastGenerate = () => state.requests.filter((entry) => entry.path === '/api/experimental/generate').at(-1);

const mountRoutes = (service) => {
  const handlers = {};
  registerSmallModelRoutes({
    get(route, handler) { handlers[`GET ${route}`] = handler; },
    post(route, handler) { handlers[`POST ${route}`] = handler; },
  }, { getSmallModelService: async () => service });
  return handlers;
};

const runHandler = async (handler, req) => {
  let status = 200;
  let payload;
  const res = {
    status(value) { status = value; return res; },
    json(value) { payload = value; },
  };
  await handler(req, res);
  return { status, payload };
};

describe('ACP one-off fallback', () => {
  it('leaves an OpenCode success byte-identical while the fallback is set', async () => {
    const { calls, provider } = stubProvider();
    setAcpOneOffFallback(provider);

    const result = await generateSmallModelText({ prompt: 'summarize this', directory: '/proj' });

    expect(result).toEqual({
      text: 'generated',
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      source: 'default',
    });
    expect(calls.resolveBackend).toHaveLength(0);
    expect(calls.generate).toHaveLength(0);
    expect(getAcpOneOffFallback()).toBe(provider);
  });

  it('falls back on the no-client 404 and forwards sessionKey to resolveBackend', async () => {
    configureOpenCodeRuntimeProviders(null);
    const { calls, provider } = stubProvider();
    setAcpOneOffFallback(provider);

    const result = await generateSmallModelText({
      prompt: '  hello fallback  ',
      system: 'be terse',
      maxOutputTokens: 100,
      sessionKey: 'ses_1',
    });

    expect(calls.resolveBackend).toEqual([{ sessionKey: 'ses_1' }]);
    expect(calls.generate).toEqual([{
      backendId: 'acp-backend',
      instruction: 'be terse',
      input: 'hello fallback',
      maxChars: 400,
    }]);
    expect(result).toEqual({
      text: 'fallback text',
      source: 'acp-oneoff',
      backendId: 'acp-backend',
      warnings: ['helper ignored'],
    });
    expect('providerID' in result).toBe(false);
    expect('modelID' in result).toBe(false);
  });

  it('falls back on the no-model 404 without a sessionKey and defaults the budget', async () => {
    state.models = [MODEL({ id: 'claude-sonnet-5', modelID: 'claude-sonnet-5', family: 'claude-sonnet' })];
    state.defaultModel = null;
    const { calls, provider } = stubProvider();
    setAcpOneOffFallback(provider);

    const result = await generateSmallModelText({ prompt: 'hi', directory: '/proj' });

    // No family match, no default model: the OpenCode path reports no model.
    expect(calls.resolveBackend).toEqual([{}]);
    expect(calls.generate[0]).toMatchObject({
      backendId: 'acp-backend',
      instruction: 'Reply with exactly what is requested and nothing else.',
      input: 'hi',
      maxChars: 2000,
    });
    expect(result).toMatchObject({ text: 'fallback text', source: 'acp-oneoff', backendId: 'acp-backend' });
  });

  it('keeps the historical no-model 404 when the fallback is unset', async () => {
    state.models = [MODEL({ id: 'claude-sonnet-5', modelID: 'claude-sonnet-5', family: 'claude-sonnet' })];
    state.defaultModel = null;

    const failure = await generateSmallModelText({ prompt: 'hi', directory: '/proj' }).catch((error) => error);

    expect(failure).toMatchObject({
      message: 'No small model available — OpenCode reports no default model',
      statusCode: 404,
    });
  });

  it('does not fall back on the exhausted-catalog 503', async () => {
    const { calls, provider } = stubProvider();
    setAcpOneOffFallback(provider);
    const unavailable = { _tag: 'InvalidRequestError', message: 'Model unavailable: zai-coding-plan/glm-5.3-flash' };
    state.generateErrors = [unavailable];
    // One attempt only: the retry schedule belongs to the OpenCode path, and
    // this suite must not wait through it.
    const { setUnavailableRetryDelaysForTest } = await import('./index.js');
    setUnavailableRetryDelaysForTest([]);
    try {
      await expect(generateSmallModelText({ prompt: 'write a commit', model: 'zai-coding-plan/glm-5.3-flash' }))
        .rejects.toMatchObject({ statusCode: 503, code: 'small-model-unavailable' });
    } finally {
      setUnavailableRetryDelaysForTest();
    }

    expect(calls.resolveBackend).toHaveLength(0);
    expect(calls.generate).toHaveLength(0);
  });

  it('does not fall back on an oversized-input 413', async () => {
    const { calls, provider } = stubProvider();
    setAcpOneOffFallback(provider);

    await expect(generateSmallModelText({
      prompt: 'x'.repeat(20_000),
      directory: '/proj',
      onOverflow: 'error',
    })).rejects.toMatchObject({ statusCode: 413, code: 'context-too-small' });

    expect(calls.resolveBackend).toHaveLength(0);
    expect(calls.generate).toHaveLength(0);
    expect(lastGenerate()).toBeUndefined();
  });

  it('surfaces provider failures as-is', async () => {
    configureOpenCodeRuntimeProviders(null);
    const failure = Object.assign(new Error('backend exploded'), { code: 'ACP_BACKEND_UNAVAILABLE' });
    const { provider } = stubProvider({ generate: async () => { throw failure; } });
    setAcpOneOffFallback(provider);

    await expect(generateSmallModelText({ prompt: 'hi' })).rejects.toBe(failure);
  });

  it('ignores a non-string sessionKey for resolveBackend', async () => {
    configureOpenCodeRuntimeProviders(null);
    const { calls, provider } = stubProvider();
    setAcpOneOffFallback(provider);

    await generateSmallModelText({ prompt: 'hi', sessionKey: 42 });

    expect(calls.resolveBackend).toEqual([{}]);
  });
});

describe('ACP fallback routes', () => {
  it('passes sessionKey through POST /api/small-model/generate', async () => {
    const seen = [];
    const handlers = mountRoutes({
      generateSmallModelText: async (options) => {
        seen.push(options);
        return { text: 'ok', source: 'default', providerID: 'anthropic', modelID: 'x' };
      },
    });

    const { status, payload } = await runHandler(
      handlers['POST /api/small-model/generate'],
      { body: { prompt: 'hi', sessionKey: 'ses_9' } },
    );

    expect(status).toBe(200);
    expect(payload.text).toBe('ok');
    expect(seen[0].sessionKey).toBe('ses_9');
  });

  it('ignores a non-string sessionKey on POST /api/small-model/generate', async () => {
    const seen = [];
    const handlers = mountRoutes({
      generateSmallModelText: async (options) => {
        seen.push(options);
        return { text: 'ok', source: 'default', providerID: 'anthropic', modelID: 'x' };
      },
    });

    await runHandler(handlers['POST /api/small-model/generate'], { body: { prompt: 'hi', sessionKey: 42 } });

    expect('sessionKey' in seen[0]).toBe(false);
  });

  it('reports available with a synthetic model when OpenCode is null and the fallback is set', async () => {
    const { provider } = stubProvider();
    setAcpOneOffFallback(provider);
    const handlers = mountRoutes({
      describeSmallModel: async () => null,
      listAuthenticatedProviders: async () => ['anthropic'],
      getAcpOneOffFallback,
    });

    const { status, payload } = await runHandler(handlers['GET /api/small-model'], { query: {} });

    expect(status).toBe(200);
    expect(payload).toEqual({
      available: true,
      model: { source: 'acp-oneoff' },
      authenticatedProviders: ['anthropic'],
    });
  });

  it('reports unavailable when OpenCode is null and the fallback is unset', async () => {
    const handlers = mountRoutes({
      describeSmallModel: async () => null,
      listAuthenticatedProviders: async () => [],
      getAcpOneOffFallback,
    });

    const { payload } = await runHandler(handlers['GET /api/small-model'], { query: {} });

    expect(payload).toEqual({ available: false, model: null, authenticatedProviders: [] });
  });

  it('leaves an OpenCode resolution untouched while the fallback is set', async () => {
    const { provider } = stubProvider();
    setAcpOneOffFallback(provider);
    const resolved = { providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'default' };
    const handlers = mountRoutes({
      describeSmallModel: async () => resolved,
      listAuthenticatedProviders: async () => ['anthropic'],
      getAcpOneOffFallback,
    });

    const { payload } = await runHandler(handlers['GET /api/small-model'], { query: {} });

    expect(payload).toEqual({ available: true, model: resolved, authenticatedProviders: ['anthropic'] });
  });

  it('keeps describeSmallModel OpenCode-only while the fallback is set', async () => {
    const { provider } = stubProvider();
    setAcpOneOffFallback(provider);
    configureOpenCodeRuntimeProviders(null);

    expect(await describeSmallModel({ directory: '/proj' })).toBeNull();
  });
});
