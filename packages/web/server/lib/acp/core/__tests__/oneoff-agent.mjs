#!/usr/bin/env node
/**
 * One-off generation fixture agent: a purpose-built ACP agent for the
 * `oneoff.test.js` suite. Owned by the OneOff plan — NOT the shared
 * `fake-agent.mjs`, which other agents are editing concurrently.
 *
 * Driven entirely by `ONEOFF_FIX_*` env vars (JSON unless noted):
 * - ONEOFF_FIX_CONFIG_OPTIONS: `configOptions` returned by session/new (and
 *   session/load). Default: a select `model` + select `effort` + boolean `turbo`.
 * - ONEOFF_FIX_SET_CONFIG_BEHAVIOUR: `{ "<configId>": "ok" | "invalid" | "error" }`.
 *   `invalid` throws `{ code: -32602 }` (unknown value); `error` throws a
 *   generic failure. Default: everything `ok` (recorded to stderr as CONFIG lines).
 * - ONEOFF_FIX_SET_CONFIG_RESPONSE: `{ "<configId>": configOptions[] }` — the
 *   complete advertised set returned after setting that id (models
 *   model-dependent options: setting `model` can advertise new ids or
 *   change current values). Default: echoes the session/new set.
 * - ONEOFF_FIX_PROMPT_SCRIPT: prompt-turn script, same step shape as the
 *   shared fake agent (`update`, `sleepMs`, `holdForCancel`, `error`,
 *   `stopReason`, `notify`). `permission`/`elicitation` steps issue the
 *   agent→client request and record the client's answer to stderr as
 *   `PERMISSION:`/`ELICITATION:` lines. Default: one agent_message_chunk
 *   "fixture-reply".
 * - ONEOFF_FIX_CAPS: extra agent capabilities merged over the defaults
 *   (`sessionCapabilities: { delete: {}, close: {} }`). Pass e.g.
 *   `{ "sessionCapabilities": { "close": {} } }` to be close-only, or
 *   `{ "sessionCapabilities": {} }` for neither.
 * - ONEOFF_FIX_PROMPT_DELAY_MS: fixed delay before each prompt resolves.
 * - ONEOFF_FIX_RECORD_PROMPTS: when set (non-empty), prompt params are
 *   echoed to stderr as `PROMPT:` lines (for prompt-shape assertions).
 * - ONEOFF_FIX_NOTIFY_OTHER: `{ "sessionId": "...", "update": {...} }` —
 *   emitted as a sibling session's update during the next prompt turn, so
 *   tests can prove normal-session traffic is not stolen or disturbed.
 * - ONEOFF_FIX_NEW_BANNERS: update[] emitted for the new session BEFORE the
 *   session/new response resolves (exercises the creation-window claim).
 * - ONEOFF_FIX_LATE_BANNERS: update[] emitted for the new session AFTER the
 *   session/new response resolves (scheduled via setTimeout 0, like
 *   pi-acp's post-new Skills/Extensions banner): exercises the
 *   collector's pre-turn gate — claimed, never collected.
 * - ONEOFF_FIX_STARTUP_META: string echoed as `_meta.piAcp.startupInfo` on
 *   the session/new response (like pi-acp), so tests can prove the client
 *   strips a banner that raced past every gate into the turn text.
 * - ONEOFF_FIX_CONFIG_DELAY_MS: delay before each set_config response.
 * - ONEOFF_FIX_DELETE_DELAY_MS / ONEOFF_FIX_CLOSE_DELAY_MS: delay before
 *   the delete/close response (a huge value simulates a stuck cleanup).
 * - ONEOFF_FIX_HANG: comma list of methods that never respond:
 *   `new`, `config`, `delete`, `close`, `cancel`.
 * Every lifecycle event is echoed to stderr so tests can assert on it:
 * `NEW:<sessionId> cwd=<cwd>`, `CONFIG:{...}`, `ENTERED:<sessionId>` (the
 * prompt handler started — the turn is parked at the agent, not merely
 * created), `CANCELLED:<sessionId>`, `DELETE:<sessionId>`,
 * `CLOSE:<sessionId>`, `PERMISSION:{...}`, `ELICITATION:{...}`.
 */

import { Readable, Writable } from 'node:stream';

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

const readJson = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const DEFAULT_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'default-model',
    options: [
      { value: 'default-model', name: 'Default' },
      { value: 'helper-model', name: 'Helper' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'none', name: 'None' },
      { value: 'high', name: 'High' },
    ],
  },
  { id: 'turbo', name: 'Turbo', type: 'boolean', currentValue: false },
];

const CONFIG_OPTIONS = readJson(process.env.ONEOFF_FIX_CONFIG_OPTIONS, DEFAULT_CONFIG_OPTIONS);
const SET_CONFIG_BEHAVIOUR = readJson(process.env.ONEOFF_FIX_SET_CONFIG_BEHAVIOUR, {});
const SET_CONFIG_RESPONSE = readJson(process.env.ONEOFF_FIX_SET_CONFIG_RESPONSE, {});
const PROMPT_SCRIPT = readJson(process.env.ONEOFF_FIX_PROMPT_SCRIPT, [
  { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture-reply' } } },
]);
const CAPABILITIES = {
  sessionCapabilities: { delete: {}, close: {} },
  ...readJson(process.env.ONEOFF_FIX_CAPS, {}),
};
const PROMPT_DELAY_MS = Number(process.env.ONEOFF_FIX_PROMPT_DELAY_MS ?? 0);
const RECORD_PROMPTS = process.env.ONEOFF_FIX_RECORD_PROMPTS !== undefined
  && process.env.ONEOFF_FIX_RECORD_PROMPTS !== '';
const NOTIFY_OTHER = readJson(process.env.ONEOFF_FIX_NOTIFY_OTHER, null);
const NEW_BANNERS = readJson(process.env.ONEOFF_FIX_NEW_BANNERS, []);
const LATE_BANNERS = readJson(process.env.ONEOFF_FIX_LATE_BANNERS, []);
const STARTUP_META = process.env.ONEOFF_FIX_STARTUP_META ?? null;
const NEW_DELAY_MS = Number(process.env.ONEOFF_FIX_NEW_DELAY_MS ?? 0);
const CONFIG_DELAY_MS = Number(process.env.ONEOFF_FIX_CONFIG_DELAY_MS ?? 0);
const DELETE_DELAY_MS = Number(process.env.ONEOFF_FIX_DELETE_DELAY_MS ?? 0);
const CLOSE_DELAY_MS = Number(process.env.ONEOFF_FIX_CLOSE_DELAY_MS ?? 0);
const HANG = new Set(
  (process.env.ONEOFF_FIX_HANG ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hangForever = () => new Promise(() => {});

const cancelledSessions = new Set();
let nextSession = 1;

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

const agent = new AgentSideConnection((client) => ({
  initialize: async () => ({
    protocolVersion: 1,
    agentCapabilities: CAPABILITIES,
    authMethods: [],
    agentInfo: { name: 'oneoff-fixture-agent', version: '0.0.0' },
  }),
  newSession: async (params) => {
    if (HANG.has('new')) {
      process.stderr.write('HUNG:new\n');
      await hangForever();
    }
    const sessionId = `oneoff-session-${nextSession++}`;
    process.stderr.write(`NEW:${sessionId} cwd=${params?.cwd ?? ''}\n`);
    // Setup traffic emitted BEFORE the response resolves: exercises the
    // creation-window claim (the client has no collector for this id yet).
    for (const update of NEW_BANNERS) {
      await client.sessionUpdate({ sessionId, update });
    }
    if (NEW_DELAY_MS > 0) await sleep(NEW_DELAY_MS);
    // …and AFTER it resolves (pi-acp posts its Skills/Extensions banner
    // via setTimeout 0): the collector exists by the time these land,
    // but the turn gate must still refuse to collect them.
    if (LATE_BANNERS.length > 0) {
      setTimeout(() => {
        (async () => {
          for (const update of LATE_BANNERS) {
            await client.sessionUpdate({ sessionId, update });
          }
        })().catch(() => {});
      }, 0);
    }
    return {
      sessionId,
      configOptions: CONFIG_OPTIONS ?? undefined,
      ...(STARTUP_META ? { _meta: { piAcp: { startupInfo: STARTUP_META } } } : {}),
    };
  },
  loadSession: async () => ({ configOptions: CONFIG_OPTIONS ?? undefined }),
  listSessions: async (params) => ({ sessions: [], ...(params ? {} : {}) }),
  deleteSession: async (params) => {
    if (!CAPABILITIES?.sessionCapabilities?.delete) {
      const error = new Error('Method not found: session/delete');
      error.code = -32601;
      throw error;
    }
    if (HANG.has('delete')) {
      process.stderr.write(`HUNG:delete:${params?.sessionId ?? ''}\n`);
      await hangForever();
    }
    if (DELETE_DELAY_MS > 0) await sleep(DELETE_DELAY_MS);
    process.stderr.write(`DELETE:${params?.sessionId ?? ''}\n`);
    return {};
  },
  closeSession: async (params) => {
    if (!CAPABILITIES?.sessionCapabilities?.close) {
      const error = new Error('Method not found: session/close');
      error.code = -32601;
      throw error;
    }
    if (HANG.has('close')) {
      process.stderr.write(`HUNG:close:${params?.sessionId ?? ''}\n`);
      await hangForever();
    }
    if (CLOSE_DELAY_MS > 0) await sleep(CLOSE_DELAY_MS);
    process.stderr.write(`CLOSE:${params?.sessionId ?? ''}\n`);
    return {};
  },
  setSessionConfigOption: async (params) => {
    if (HANG.has('config')) {
      process.stderr.write(`HUNG:config:${params?.sessionId ?? ''}:${params?.configId ?? ''}\n`);
      await hangForever();
    }
    const behaviour = SET_CONFIG_BEHAVIOUR?.[params?.configId] ?? 'ok';
    process.stderr.write(`CONFIG:${JSON.stringify({ sessionId: params?.sessionId, configId: params?.configId, value: params?.value, type: params?.type ?? null })}\n`);
    if (CONFIG_DELAY_MS > 0) await sleep(CONFIG_DELAY_MS);
    if (behaviour === 'invalid') {
      const error = new Error(`Unknown config value for ${params?.configId}`);
      error.code = -32602;
      throw error;
    }
    if (behaviour === 'error') {
      throw new Error(`set_config_option failed for ${params?.configId}`);
    }
    return { configOptions: SET_CONFIG_RESPONSE?.[params?.configId] ?? CONFIG_OPTIONS ?? [] };
  },
  prompt: async (params) => {
    if (RECORD_PROMPTS) {
      process.stderr.write(`PROMPT:${JSON.stringify({ sessionId: params?.sessionId, prompt: params?.prompt ?? null })}\n`);
    }
    process.stderr.write(`ENTERED:${params?.sessionId ?? ''}\n`);
    if (PROMPT_DELAY_MS > 0) await sleep(PROMPT_DELAY_MS);
    let stopReason = 'end_turn';
    for (const step of PROMPT_SCRIPT) {
      if (!step || typeof step !== 'object') continue;
      if (typeof step.sleepMs === 'number') await sleep(step.sleepMs);
      if (step.update) {
        await client.sessionUpdate({ sessionId: params.sessionId, update: step.update });
      }
      if (step.notify) {
        await client.notify(step.notify.method, { sessionId: params.sessionId, ...(step.notify.params ?? {}) });
      }
      if (step.permission) {
        const outcome = await client.requestPermission({ sessionId: params.sessionId, ...step.permission });
        process.stderr.write(`PERMISSION:${JSON.stringify(outcome)}\n`);
      }
      if (step.elicitation) {
        const outcome = await client.createElicitation({ sessionId: params.sessionId, ...step.elicitation });
        process.stderr.write(`ELICITATION:${JSON.stringify(outcome)}\n`);
      }
      if (typeof step.holdForCancel === 'number') {
        const deadline = Date.now() + step.holdForCancel;
        while (!cancelledSessions.has(params.sessionId) && Date.now() < deadline) {
          await sleep(10);
        }
        if (cancelledSessions.has(params.sessionId)) {
          process.stderr.write(`CANCELLED:${params.sessionId}\n`);
          return { stopReason: 'cancelled' };
        }
      }
      if (step.error) {
        const failure = new Error(step.error.message ?? 'fixture prompt error');
        if (step.error.code !== undefined) failure.code = step.error.code;
        if (step.error.data !== undefined) failure.data = step.error.data;
        throw failure;
      }
      if (typeof step.stopReason === 'string') stopReason = step.stopReason;
    }
    if (NOTIFY_OTHER && typeof NOTIFY_OTHER.sessionId === 'string' && NOTIFY_OTHER.update) {
      await client.sessionUpdate({ sessionId: NOTIFY_OTHER.sessionId, update: NOTIFY_OTHER.update });
    }
    return { stopReason };
  },
  cancel: async (params) => {
    if (HANG.has('cancel')) {
      process.stderr.write(`HUNG:cancel:${params?.sessionId ?? ''}\n`);
      await hangForever();
    }
    if (params?.sessionId) cancelledSessions.add(params.sessionId);
  },
}), stream);

await agent.closed;
