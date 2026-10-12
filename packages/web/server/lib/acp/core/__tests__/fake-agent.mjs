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
 *   params } }` sends a raw notification (extension traffic).
 *   `{ stopReason }` as the last step overrides the prompt result.
 * - `FAKE_ACP_AUTHENTICATE` — JSON object: when set, `authenticate` stores
 *   the received `methodId` on stderr as `AUTHENTICATE:<methodId>` and
 *   answers `{}`; otherwise `authenticate` throws method-not-found.
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
let nextSession = 1;

const runPromptScript = async (agent, sessionId) => {
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
  newSession: async () => {
    const sessionId = `fake-session-${nextSession++}`;
    sessions.set(sessionId, { created: Date.now() });
    return { sessionId };
  },
  loadSession: async () => ({}),
  listSessions: async () => ({ sessions: [] }),
  prompt: async (params) => runPromptScript(client, params.sessionId),
  cancel: async () => {},
}), stream);

await agent.closed;
