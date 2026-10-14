#!/usr/bin/env node
/**
 * Spec-conformant fake ACP agent for tests, built on the SDK's
 * `AgentSideConnection`. Runnable as a child process (`node fake-agent.mjs`);
 * later phases extend the scripting surface, they never replace the harness.
 *
 * Configuration is env vars (set by the spawning test) so argv stays free for
 * node flags:
 *
 * - `FAKE_ACP_PROTOCOL_VERSION` — version to answer in `initialize`
 *   (default 1). Answer 2 to exercise version mismatch.
 * - `FAKE_ACP_AGENT_INFO` — JSON `{ name, version, ... }` for `agentInfo`.
 * - `FAKE_ACP_CAPABILITIES` — JSON object merged over the default agent
 *   capabilities.
 * - `FAKE_ACP_AUTH_METHODS` — JSON array for `authMethods`.
 * - `FAKE_ACP_INITIALIZE_DELAY_MS` — delay before answering `initialize`.
 * - `FAKE_ACP_EXIT_CODE` — exit immediately with this code (early-exit
 *   guard). `FAKE_ACP_EXIT_AFTER_MS` delays the exit.
 * - `FAKE_ACP_STDERR` — line written to stderr before serving (stderr tail).
 * - `FAKE_ACP_CRASH_ON` — `initialize` answers normally, then the process
 *   exits(1) after this many ms (crash detection).
 * - `FAKE_ACP_PROMPT_SCRIPT` — JSON array of steps run per `session/prompt`.
 *   Each step: `{ update }` sends a `session/update` notification with that
 *   update body; `{ sleepMs }` waits; `{ permission }` sends
 *   `session/request_permission` with that body and records the outcome on
 *   stderr as `PERMISSION:<json>`; `{ elicitation }` sends
 *   `elicitation/create` and records `ELICITATION:<json>`; `{ notify: { method,
 *   params } }` sends a raw notification (extension traffic); `{ childUpdate:
 *   params }` sends `opencode/session/child_update` with those params (child
 *   sessions); `{ holdForCancel: ms }` waits up to `ms` for a `session/cancel`
 *   and then finishes with `cancelled` (records `CANCELLED:<sessionId>`);
 *   `{ awaitCancelThenPermission: { permission, timeoutMs } }` waits for a
 *   cancel, then sends that permission and finishes `cancelled` (the result
 *   is gated on the answer); past the timeout with no cancel it sends the
 *   permission anyway and continues the script.
 *   `{ error: { code, message } }` throws a JSON-RPC error out of the prompt.
 *   `{ stopReason }` as the last step overrides the prompt result.
 * - `FAKE_ACP_SESSIONS` — JSON array of `{ sessionId, cwd, title?, updatedAt?
 *   }` pre-seeded for `session/list` (filtering by `cwd` when given).
 * - `FAKE_ACP_LOAD_REPLAY` — JSON array of `session/update` bodies replayed
 *   (in order) on every `session/load` before it responds.
 * - `FAKE_ACP_CONFIG_OPTIONS` — JSON array answered as `configOptions` from
 *   `session/new`, `session/load` and `session/resume`.
 * - `FAKE_ACP_MODES` — JSON `{ currentModeId, availableModes }` answered as
 *   `modes` from `session/new`, `session/load` and `session/resume`.
 * - `FAKE_ACP_DELETE` — when `true`, `session/delete` removes the session and
 *   records `DELETE:<sessionId>`; otherwise it throws method-not-found.
 * - `FAKE_ACP_CLOSE` — when `true`, `session/close` records
 *   `CLOSE:<sessionId>`; otherwise it throws method-not-found.
 * - `FAKE_ACP_RESUME` — when `true`, `session/resume` answers with the
 *   configured options/modes and records `RESUME:<sessionId>`; otherwise it
 *   throws method-not-found.
 * - `FAKE_ACP_FORK` — when `true`, `session/fork` mints a new session id,
 *   registers it, and records `FORK:<oldId> -> <newId>`; otherwise it
 *   throws method-not-found.
 * - `FAKE_ACP_LOAD_ERROR` — JSON `{ code, message }`: `session/load` throws
 *   it instead of replaying.
 * - `FAKE_ACP_PROMPT_RECORD` — when set, every prompt's `{ sessionId, prompt
 *   }` is recorded on stderr as `PROMPT:<json>`.
 * - `FAKE_ACP_AUTHENTICATE` — JSON object: when set, `authenticate` stores
 *   the received `methodId` on stderr as `AUTHENTICATE:<methodId>` and
 *   answers `{}`; otherwise `authenticate` throws method-not-found.
 * - `FAKE_ACP_CONFIG_SILENT_KEEP` — when `true`, `set_config_option` answers
 *   success while keeping the old `currentValue` (the omp/pi-acp
 *   cross-provider silent-keep, D4).
 * - `FAKE_ACP_CONFIG_RESETS` — JSON `{ "<configId>": { "<optionId>": <currentValue> } }`:
 *   setting the key also resets the named dependents in the response (a
 *   model switch resetting effort agent-side).
 * - `FAKE_ACP_UNSOLICITED_UPDATES` — JSON array of update bodies sent after
 *   every `session/new` response (pi-acp startup-banner shape, D2);
 *   `FAKE_ACP_UNSOLICITED_DELAY_MS` delays them (default 50).
 * - `FAKE_ACP_DELETE_ERROR` — JSON `{ code?, message? }`: `session/delete`
 *   throws it instead of deleting (zombie-session shape, D5).
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

const PROTOCOL_VERSION = Number(process.env.FAKE_ACP_PROTOCOL_VERSION ?? 1);
const AGENT_INFO = readJson(process.env.FAKE_ACP_AGENT_INFO, { name: 'fake-agent', version: '0.0.0' });
const CAPABILITIES = {
  loadSession: true,
  listSessions: true,
  ...readJson(process.env.FAKE_ACP_CAPABILITIES, {}),
};
const AUTH_METHODS = readJson(process.env.FAKE_ACP_AUTH_METHODS, []);
const INITIALIZE_DELAY_MS = Number(process.env.FAKE_ACP_INITIALIZE_DELAY_MS ?? 0);
const PROMPT_SCRIPT = readJson(process.env.FAKE_ACP_PROMPT_SCRIPT, []);
const SUPPORTS_AUTHENTICATE = process.env.FAKE_ACP_AUTHENTICATE !== undefined
  && process.env.FAKE_ACP_AUTHENTICATE !== '';

if (process.env.FAKE_ACP_STDERR) {
  process.stderr.write(`${process.env.FAKE_ACP_STDERR}\n`);
}

if (process.env.FAKE_ACP_EXIT_CODE !== undefined && process.env.FAKE_ACP_EXIT_CODE !== '') {
  const code = Number(process.env.FAKE_ACP_EXIT_CODE);
  const afterMs = Number(process.env.FAKE_ACP_EXIT_AFTER_MS ?? 0);
  // `afterMs < 0` means: exit on the first stdin byte (i.e. deterministically
  // after the client sent `initialize`, with no timer race either way).
  if (afterMs < 0) {
    process.stdin.once('data', () => process.exit(Number.isFinite(code) ? code : 1));
  } else {
    setTimeout(() => process.exit(Number.isFinite(code) ? code : 1), Number.isFinite(afterMs) ? afterMs : 0);
  }
  // Park the event loop until the exit fires; never serve.
  await new Promise(() => {});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sessions = new Map();
for (const seed of readJson(process.env.FAKE_ACP_SESSIONS, [])) {
  if (seed && typeof seed.sessionId === 'string') sessions.set(seed.sessionId, { ...seed });
}
let nextSession = 1;
const LOAD_REPLAY = readJson(process.env.FAKE_ACP_LOAD_REPLAY, []);
const CONFIG_OPTIONS = readJson(process.env.FAKE_ACP_CONFIG_OPTIONS, null);
const MODES = readJson(process.env.FAKE_ACP_MODES, null);
const SUPPORTS_DELETE = process.env.FAKE_ACP_DELETE === 'true';
const SUPPORTS_CLOSE = process.env.FAKE_ACP_CLOSE === 'true';
const SUPPORTS_RESUME = process.env.FAKE_ACP_RESUME === 'true';
const SUPPORTS_FORK = process.env.FAKE_ACP_FORK === 'true';
const LOAD_ERROR = readJson(process.env.FAKE_ACP_LOAD_ERROR, null);
const RECORD_PROMPTS = process.env.FAKE_ACP_PROMPT_RECORD !== undefined && process.env.FAKE_ACP_PROMPT_RECORD !== '';
// D2: updates emitted outside any prompt turn (setup banners after
// session/new), sent once the new session's response is on the wire.
const UNSOLICITED_UPDATES = readJson(process.env.FAKE_ACP_UNSOLICITED_UPDATES, []);
const UNSOLICITED_DELAY_MS = Number(process.env.FAKE_ACP_UNSOLICITED_DELAY_MS ?? 50);

const cancelledSessions = new Set();
// Live per-agent config state: set_config_option mutates it, and every
// response reports it — like a real agent, sequential changes accumulate.
const liveOptions = new Map();
const optionsFor = () => {
  if (!CONFIG_OPTIONS) return null;
  if (!liveOptions.has('options')) liveOptions.set('options', structuredClone(CONFIG_OPTIONS));
  return liveOptions.get('options');
};
const sessionOptions = () => ({
  ...(optionsFor() ? { configOptions: structuredClone(optionsFor()) } : {}),
  ...(MODES ? { modes: MODES } : {}),
});

const runPromptScript = async (agent, sessionId, prompt) => {
  if (RECORD_PROMPTS) {
    process.stderr.write(`PROMPT:${JSON.stringify({ sessionId, prompt: prompt ?? null })}\n`);
  }
  let stopReason = 'end_turn';
  for (const step of PROMPT_SCRIPT) {
    if (!step || typeof step !== 'object') continue;
    if (typeof step.sleepMs === 'number') await sleep(step.sleepMs);
    if (step.update) {
      await agent.sessionUpdate({ sessionId, update: step.update });
    }
    if (step.permission) {
      const outcome = await agent.requestPermission({ sessionId, ...step.permission });
      process.stderr.write(`PERMISSION:${JSON.stringify(outcome)}\n`);
    }
    if (step.elicitation) {
      const outcome = await agent.createElicitation({ sessionId, ...step.elicitation });
      process.stderr.write(`ELICITATION:${JSON.stringify(outcome)}\n`);
    }
    if (step.notify) {
      await agent.notify(step.notify.method, { sessionId, ...(step.notify.params ?? {}) });
    }
    if (step.childUpdate) {
      await agent.notify('opencode/session/child_update', { ...(step.childUpdate ?? {}) });
    }
    if (typeof step.holdForCancel === 'number') {
      const deadline = Date.now() + step.holdForCancel;
      while (!cancelledSessions.has(sessionId) && Date.now() < deadline) {
        await sleep(10);
      }
      if (cancelledSessions.has(sessionId)) {
        process.stderr.write(`CANCELLED:${sessionId}\n`);
        return { stopReason: 'cancelled' };
      }
    }
    if (step.awaitCancelThenPermission) {
      // Wait for a cancel, then send one permission and finish cancelled —
      // the prompt result is gated on the permission answer. Without
      // transitive cancellation the client parks it and the cancel hangs.
      // Past `timeoutMs` with no cancel, send it anyway and continue (the
      // client parks it like any in-turn request).
      const { permission, timeoutMs = 5000 } = step.awaitCancelThenPermission;
      const deadline = Date.now() + timeoutMs;
      while (!cancelledSessions.has(sessionId) && Date.now() < deadline) {
        await sleep(10);
      }
      const outcome = await agent.requestPermission({ sessionId, ...permission });
      process.stderr.write(`PERMISSION:${JSON.stringify(outcome)}\n`);
      if (cancelledSessions.has(sessionId)) {
        process.stderr.write(`CANCELLED:${sessionId}\n`);
        return { stopReason: 'cancelled' };
      }
    }
    if (step.error) {
      const failure = new Error(step.error.message ?? 'fake prompt error');
      if (step.error.code !== undefined) failure.code = step.error.code;
      if (step.error.data !== undefined) failure.data = step.error.data;
      throw failure;
    }
    if (typeof step.stopReason === 'string') stopReason = step.stopReason;
  }
  return { stopReason };
};

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

const agent = new AgentSideConnection((client) => ({
  initialize: async () => {
    if (INITIALIZE_DELAY_MS > 0) await sleep(INITIALIZE_DELAY_MS);
    if (process.env.FAKE_ACP_CRASH_ON !== undefined && process.env.FAKE_ACP_CRASH_ON !== '') {
      const afterMs = Number(process.env.FAKE_ACP_CRASH_ON);
      setTimeout(() => process.exit(1), Number.isFinite(afterMs) ? afterMs : 0);
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: CAPABILITIES,
      authMethods: AUTH_METHODS,
      agentInfo: AGENT_INFO,
    };
  },
  authenticate: async (params) => {
    if (!SUPPORTS_AUTHENTICATE) {
      const error = new Error(`Method not found: authenticate`);
      error.code = -32601;
      throw error;
    }
    process.stderr.write(`AUTHENTICATE:${params?.methodId ?? ''}\n`);
    return {};
  },
  newSession: async (params) => {
    const sessionId = `fake-session-${nextSession++}`;
    sessions.set(sessionId, { sessionId, cwd: params?.cwd ?? null, title: '' });
    // D2: like pi-acp's setTimeout-0 startup banner, setup traffic goes out
    // AFTER the response resolves, outside any prompt turn.
    if (Array.isArray(UNSOLICITED_UPDATES) && UNSOLICITED_UPDATES.length > 0) {
      const delay = Number.isFinite(UNSOLICITED_DELAY_MS) ? UNSOLICITED_DELAY_MS : 50;
      setTimeout(() => {
        (async () => {
          for (const update of UNSOLICITED_UPDATES) {
            await client.sessionUpdate({ sessionId, update });
          }
        })().catch(() => {});
      }, Math.max(0, delay));
    }
    return { sessionId, ...sessionOptions() };
  },
  loadSession: async (params) => {
    if (LOAD_ERROR) {
      const failure = new Error(LOAD_ERROR.message ?? 'fake load error');
      if (LOAD_ERROR.code !== undefined) failure.code = LOAD_ERROR.code;
      throw failure;
    }
    const sessionId = params?.sessionId;
    for (const update of LOAD_REPLAY) {
      await client.sessionUpdate({ sessionId, update });
    }
    return { ...sessionOptions() };
  },
  listSessions: async (params) => {
    const rows = [...sessions.values()]
      .filter((row) => !params?.cwd || row.cwd === params.cwd)
      .map((row) => ({
        sessionId: row.sessionId,
        cwd: row.cwd ?? params?.cwd ?? 'C:\\fake',
        ...(row.title !== undefined ? { title: row.title } : {}),
        ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
      }));
    return { sessions: rows };
  },
  deleteSession: async (params) => {
    if (!SUPPORTS_DELETE) {
      const error = new Error('Method not found: session/delete');
      error.code = -32601;
      throw error;
    }
    // D5: fail the delete RPC with an injected error (a session/connection
    // that is already gone must still drop local state).
    const failure = readJson(process.env.FAKE_ACP_DELETE_ERROR, null);
    if (failure) {
      const error = new Error(failure.message ?? 'fake delete error');
      if (failure.code !== undefined) error.code = failure.code;
      throw error;
    }
    sessions.delete(params?.sessionId);
    process.stderr.write(`DELETE:${params?.sessionId ?? ''}\n`);
    return {};
  },
  closeSession: async (params) => {
    if (!SUPPORTS_CLOSE) {
      const error = new Error('Method not found: session/close');
      error.code = -32601;
      throw error;
    }
    process.stderr.write(`CLOSE:${params?.sessionId ?? ''}\n`);
    return {};
  },
  resumeSession: async (params) => {
    if (!SUPPORTS_RESUME) {
      const error = new Error('Method not found: session/resume');
      error.code = -32601;
      throw error;
    }
    process.stderr.write(`RESUME:${params?.sessionId ?? ''}\n`);
    return { ...sessionOptions() };
  },
  unstable_forkSession: async (params) => {
    if (!SUPPORTS_FORK) {
      const error = new Error('Method not found: session/fork');
      error.code = -32601;
      throw error;
    }
    const sessionId = `fake-session-${nextSession++}`;
    sessions.set(sessionId, { sessionId, cwd: params?.cwd ?? null, title: '' });
    process.stderr.write(`FORK:${params?.sessionId ?? ''} -> ${sessionId}\n`);
    return { sessionId, ...sessionOptions() };
  },
  setSessionConfigOption: async (params) => {
    process.stderr.write(`CONFIG:${JSON.stringify({ sessionId: params?.sessionId, configId: params?.configId, value: params?.value })}\n`);
    // FAKE_ACP_CONFIG_SILENT_KEEP=true: answer success while keeping the old
    // value (the omp/pi-acp cross-provider silent-keep, D4). The caller must
    // detect the mismatch from `currentValue`, not from the RPC status.
    const silentKeep = process.env.FAKE_ACP_CONFIG_SILENT_KEEP === 'true';
    const resets = readJson(process.env.FAKE_ACP_CONFIG_RESETS, {});
    const dependent = resets?.[params?.configId];
    const options = optionsFor() ?? [];
    const next = (Array.isArray(options) ? options : []).map((option) => {
      if (silentKeep && option?.id === params?.configId) return option;
      if (option?.id === params?.configId) return { ...option, currentValue: params?.value ?? option?.currentValue };
      if (dependent && typeof dependent === 'object' && option?.id in dependent) {
        return { ...option, currentValue: dependent[option.id] };
      }
      return option;
    });
    if (optionsFor()) liveOptions.set('options', next);
    return { configOptions: structuredClone(next) };
  },
  setSessionMode: async (params) => {
    process.stderr.write(`MODE:${JSON.stringify({ sessionId: params?.sessionId, modeId: params?.modeId })}\n`);
    return {};
  },
  prompt: async (params) => runPromptScript(client, params.sessionId, params?.prompt),
  cancel: async (params) => {
    if (params?.sessionId) cancelledSessions.add(params.sessionId);
  },
}), stream);

await agent.closed;
