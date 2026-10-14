import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcpBackendManager } from './backend-manager.js';
import { createOneOff, trimOneOffOutput } from './oneoff.js';
import { createAcpBackendRegistry } from './registry.js';

const FIXTURE_AGENT = fileURLToPath(new URL('./__tests__/oneoff-agent.mjs', import.meta.url));

const tempDir = (prefix) => mkdtemp(join(tmpdir(), prefix));

const fixtureEntry = (overrides = {}) => ({
  id: 'fixture',
  label: 'fixture',
  command: process.execPath,
  args: [FIXTURE_AGENT],
  enabled: true,
  ...overrides,
});

const managers = [];

afterEach(async () => {
  while (managers.length > 0) await managers.pop().shutdown();
});

// Mirrors the production wiring (see oneoff.js header): the one-off hook
// claims its own session's updates, everything else reaches `passthrough`
// (standing in for the session router). `knownSessions` stands in for the
// indexed normal-session set used to disambiguate the creation window;
// agent→client requests for one-off sessions are declined, others reach
// `pendingRequests` (which the test drains like the session router would).
const setup = async ({ entry = {}, entries = null, oneOffOptions = {}, managerOptions = {}, knownSessions = null } = {}) => {
  const registry = createAcpBackendRegistry({ dataDir: await tempDir('acp-oneoff-reg-'), resolveCommand: () => null });
  await registry.save(entries ?? [fixtureEntry(entry)]);
  const { spawnAcpAgent } = await import('./spawn.js');
  const spawnAgent = (options) =>
    spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} });
  const holder = { current: null };
  const passthrough = [];
  const pendingRequests = [];
  const known = knownSessions instanceof Set ? knownSessions : new Set(knownSessions ?? []);
  const manager = createAcpBackendManager({
    registry,
    spawnAgent,
    stderrFlushMs: 10,
    ...managerOptions,
    connectionHooks: (backendId) => ({
      onSessionUpdate: async (params) => {
        const hooks = holder.current?.hooksForOneOff(backendId, { isKnownSession: (id) => known.has(id) });
        if (hooks && hooks.onSessionUpdate(params)) return;
        passthrough.push(params);
      },
      onRequestPermission: async (params) => {
        const declined = holder.current?.hooksForOneOff(backendId).onRequestPermission(params);
        if (declined) return declined;
        return new Promise((resolve) => { pendingRequests.push({ kind: 'permission', resolve }); });
      },
      onElicitation: async (params) => {
        const declined = holder.current?.hooksForOneOff(backendId).onElicitation(params);
        if (declined) return declined;
        return new Promise((resolve) => { pendingRequests.push({ kind: 'elicitation', resolve }); });
      },
    }),
  });
  managers.push(manager);
  const oneOff = createOneOff({ manager, registry, ...oneOffOptions });
  holder.current = oneOff;
  const drainRequests = () => {
    for (const request of pendingRequests.splice(0)) {
      request.resolve(request.kind === 'permission'
        ? { outcome: { outcome: 'cancelled' } }
        : { action: 'cancel' });
    }
  };
  return { oneOff, manager, registry, passthrough, pendingRequests, drainRequests, known };
};

const stderrOf = async (manager, backendId = 'fixture') =>
  (await manager.status(backendId)).stderrTail;

// The agent writes lifecycle markers to stderr; the pipe delivers them
// asynchronously, so a marker asserted immediately after its RPC completed
// may not have arrived yet. Poll until it lands — and REJECT when the cap
// expires, so a missing marker fails loudly instead of asserting on a
// silent partial tail.
const stderrWith = async (manager, marker, backendId = 'fixture', timeoutMs = 15_000) => {
  const start = Date.now();
  for (;;) {
    const stderr = await stderrOf(manager, backendId);
    if (stderr.includes(marker)) return stderr;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for stderr to contain ${JSON.stringify(marker)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const stderrLines = async (manager, prefix, backendId = 'fixture') =>
  (await stderrOf(manager, backendId)).split('\n').filter((line) => line.startsWith(prefix));

const configLines = async (manager, backendId = 'fixture') =>
  (await stderrLines(manager, 'CONFIG:', backendId))
    .map((line) => JSON.parse(line.slice('CONFIG:'.length)));

// The CONFIG echoes land on the stderr pipe after generate resolves; wait
// until `count` of them have arrived before reading the full ordered list.
const configLinesWith = async (manager, count, backendId = 'fixture', timeoutMs = 15_000) => {
  const start = Date.now();
  for (;;) {
    const lines = await configLines(manager, backendId);
    if (lines.length >= count) return lines;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} CONFIG lines (saw ${lines.length})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('acp one-off generation', () => {
  it('generates text through a throwaway session and deletes it', async () => {
    const tmpRoot = await tempDir('acp-oneoff-root-');
    const { oneOff, manager } = await setup({ oneOffOptions: { tmpRoot } });
    const result = await oneOff.generate({
      backendId: 'fixture',
      instruction: 'Write a 6-word commit message.',
      input: 'fix typo in README',
    });
    expect(result.text).toBe('fixture-reply');
    expect(result.sessionCleanup).toBe('deleted');
    const stderr = await stderrWith(manager, 'DELETE:oneoff-session-1');
    expect(stderr).toContain('DELETE:oneoff-session-1');
    expect(await stderrWith(manager, 'NEW:oneoff-session-1')).toMatch(/NEW:oneoff-session-1 cwd=.*acp-oneoff-/);
    // The per-call temp dir is removed afterwards.
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('sends the strict-format instruction plus input as text blocks', async () => {
    const { oneOff, manager } = await setup({
      entry: { env: { ONEOFF_FIX_RECORD_PROMPTS: '1' } },
    });
    await oneOff.generate({ backendId: 'fixture', instruction: 'Summarize.', input: 'some diff' });
    const stderr = await stderrWith(manager, 'PROMPT:');
    const line = stderr.split('\n').find((entry) => entry.startsWith('PROMPT:'));
    expect(line).toBeTruthy();
    const { prompt } = JSON.parse(line.slice('PROMPT:'.length));
    expect(prompt).toHaveLength(2);
    expect(prompt[0]).toMatchObject({ type: 'text' });
    expect(prompt[0].text).toContain('Summarize.');
    expect(prompt[0].text).toContain('nothing else');
    expect(prompt[1]).toEqual({ type: 'text', text: 'some diff' });
  });

  it('applies helper config model-first and warns on the rest', async () => {
    const { oneOff, manager } = await setup({
      entry: {
        helper: {
          config: {
            model: 'helper-model',
            effort: 'none',
            turbo: 'true',
            unknown: 'x',
          },
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    const applied = await configLinesWith(manager, 3);
    // Model before dependents: a later model switch must not reset them.
    expect(applied).toEqual([
      { sessionId: 'oneoff-session-1', configId: 'model', value: 'helper-model', type: null },
      { sessionId: 'oneoff-session-1', configId: 'effort', value: 'none', type: null },
      { sessionId: 'oneoff-session-1', configId: 'turbo', value: true, type: 'boolean' },
    ]);
    expect(result.warnings).toEqual([
      'helper config "unknown" ignored: not advertised by this session',
    ]);
  });

  it('skips unadvertised values and boolean mismatches with warnings, never failing', async () => {
    const { oneOff, manager } = await setup({
      entry: {
        helper: {
          config: { model: 'no-such-model', turbo: 'maybe' },
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.text).toBe('fixture-reply');
    expect(await configLines(manager)).toEqual([]);
    expect(result.warnings).toEqual([
      'helper config "model" ignored: "no-such-model" is not an advertised value',
      'helper config "turbo" ignored: "maybe" is not a boolean value',
    ]);
  });

  it('warns when the agent rejects a helper value instead of failing', async () => {
    const { oneOff } = await setup({
      entry: {
        helper: { config: { model: 'helper-model' } },
        env: { ONEOFF_FIX_SET_CONFIG_BEHAVIOUR: JSON.stringify({ model: 'invalid' }) },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.text).toBe('fixture-reply');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^helper config "model" rejected: /);
  });

  it('re-validates later settings against each set_config response (model-dependent options)', async () => {
    // Setting `model` advertises a new `thinking` option and narrows
    // `effort` to just `high`: `thinking` (unadvertised at session/new)
    // must still apply, while the helper's `effort: none` must warn —
    // and the recorded CONFIG order proves model went first.
    const afterModel = [
      {
        id: 'model', name: 'Model', type: 'select', currentValue: 'helper-model',
        options: [{ value: 'helper-model', name: 'Helper' }],
      },
      {
        id: 'effort', name: 'Effort', type: 'select', currentValue: 'high',
        options: [{ value: 'high', name: 'High' }],
      },
      {
        id: 'thinking', name: 'Thinking', type: 'select', currentValue: 'max',
        options: [{ value: 'minimal', name: 'Minimal' }, { value: 'max', name: 'Max' }],
      },
    ];
    const { oneOff, manager } = await setup({
      entry: {
        helper: { config: { model: 'helper-model', thinking: 'minimal', effort: 'none' } },
        env: { ONEOFF_FIX_SET_CONFIG_RESPONSE: JSON.stringify({ model: afterModel }) },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.text).toBe('fixture-reply');
    expect(await configLinesWith(manager, 2)).toEqual([
      { sessionId: 'oneoff-session-1', configId: 'model', value: 'helper-model', type: null },
      { sessionId: 'oneoff-session-1', configId: 'thinking', value: 'minimal', type: null },
    ]);
    expect(result.warnings).toEqual([
      'helper config "effort" ignored: "none" is not an advertised value',
    ]);
  });

  it('collects only agent_message_chunk text and skips thoughts and tools', async () => {
    const { oneOff } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'THOUGHT' } } },
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kept-' } } },
            { update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', status: 'pending' } },
            { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'TOOL-OUT' } }] } },
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kept' } } },
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA' } } },
          ]),
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.text).toBe('kept-kept');
  });

  it('swallows creation-window and setup banners without collecting them', async () => {
    // pi-acp emits its startup info as agent_message_chunk right after
    // session/new, before the response — while the client has no
    // collector for the id yet. The creation claim swallows it (and a
    // second banner racing helper setup is claimed by the collector but
    // still pre-turn, so never collected).
    const { oneOff, passthrough } = await setup({
      entry: {
        helper: { config: { model: 'helper-model' } },
        env: {
          ONEOFF_FIX_NEW_BANNERS: JSON.stringify([
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CREATION-BANNER' } },
            { sessionUpdate: 'available_commands_update', availableCommands: [] },
          ]),
          ONEOFF_FIX_NEW_DELAY_MS: '50',
          ONEOFF_FIX_CONFIG_DELAY_MS: '50',
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-text' } } },
          ]),
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.text).toBe('turn-text');
    expect(passthrough).toEqual([]);
  });

  it('drops post-new setup banners that land after the response resolves', async () => {
    // pi-acp posts its Skills/Extensions banner via setTimeout 0 AFTER
    // session/new resolves — the collector exists by then, so the
    // creation claim cannot help; the pre-turn gate must refuse to
    // collect it. Only the prompt round-trip's own chunks count.
    const { oneOff, passthrough } = await setup({
      entry: {
        helper: { config: { model: 'helper-model' } },
        env: {
          ONEOFF_FIX_LATE_BANNERS: JSON.stringify([
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Skills\n## Extensions\n' } },
          ]),
          ONEOFF_FIX_CONFIG_DELAY_MS: '50',
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turn-text' } } },
          ]),
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.text).toBe('turn-text');
    expect(passthrough).toEqual([]);
  });

  it('strips a banner that raced into the turn, recognized by session/new _meta', async () => {
    // The gate cannot beat an agent-side race: a banner emitted between
    // the new-response and the prompt round-trip may still land inside
    // the collected turn text (pi-acp PONG probe). Here the prompt
    // script itself leads with the banner bytes, exactly as pi-acp's
    // session/new `_meta.piAcp.startupInfo` reports them: the client
    // strips that verbatim prefix from the result.
    const banner = '## Skills\n## Extensions\n';
    const { oneOff, passthrough } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_STARTUP_META: banner,
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: banner } } },
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } },
          ]),
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Reply PONG.', input: 'ping' });
    expect(result.text).toBe('PONG');
    expect(passthrough).toEqual([]);
  });

  it('never strips model output that merely resembles no known banner', async () => {
    // No `_meta.piAcp.startupInfo` on the new-response: even banner-like
    // turn text passes through untouched. Exact-match only.
    const { oneOff } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Skills\n## Extensions\nPONG' } } },
          ]),
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Reply PONG.', input: 'ping' });
    expect(result.text).toBe('## Skills\n## Extensions\nPONG');
  });

  it('still passes known normal-session traffic through during creation', async () => {
    // The creation claim must be narrow: an update for an indexed normal
    // session arriving mid-creation still reaches the session router.
    const { oneOff, passthrough, known } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_NEW_DELAY_MS: '100',
          ONEOFF_FIX_NOTIFY_OTHER: JSON.stringify({
            sessionId: 'normal-session-9',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'sibling' } },
          }),
        },
      },
    });
    known.add('normal-session-9');
    // Backend boot takes longer than the hook probe below: connect first,
    // outside the measured generate, so the creation window is open when
    // probed. (connectAgent's initialize runs on first acquire.)
    await oneOff.generate({ backendId: 'fixture', instruction: 'warm.', input: 'x' });
    passthrough.length = 0;
    const hooks = oneOff.hooksForOneOff('fixture', { isKnownSession: (id) => known.has(id) });
    const slow = oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    // Wait until the creation claim is live: an unknown id gets claimed.
    const deadline = Date.now() + 5000;
    for (;;) {
      const claimed = hooks.onSessionUpdate({
        sessionId: 'oneoff-session-probe',
        update: { sessionUpdate: 'session_info_update', title: 'probe' },
      });
      if (claimed) break;
      if (Date.now() > deadline) throw new Error('creation claim never armed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Known normal-session traffic passes through even mid-creation…
    expect(hooks.onSessionUpdate({
      sessionId: 'normal-session-9',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'concurrent' } },
    })).toBe(false);
    // …while the throwaway's own setup traffic is claimed.
    expect(hooks.onSessionUpdate({
      sessionId: 'oneoff-session-2',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'setup' } },
    })).toBe(true);
    await slow;
    expect(passthrough).toEqual([
      { sessionId: 'normal-session-9', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'sibling' } } },
    ]);
  });

  it('declines permission and elicitation requests for one-off sessions', async () => {
    const { oneOff, manager, pendingRequests, drainRequests } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([
            { permission: { toolCall: { toolCallId: 't1' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } },
            { elicitation: { mode: 'form', message: 'Which?', requestedSchema: { type: 'object', properties: {} } } },
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } },
          ]),
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.text).toBe('done');
    // Nothing parked at the session router: both were declined inline.
    expect(pendingRequests).toEqual([]);
    drainRequests();
    const stderr = await stderrWith(manager, 'PERMISSION:');
    expect(stderr).toContain('PERMISSION:{"outcome":{"outcome":"cancelled"}}');
    expect(await stderrWith(manager, 'ELICITATION:')).toContain('ELICITATION:{"action":"cancel"}');
  });

  it('reports usage and cost from usage_update', async () => {
    const { oneOff } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } },
            { update: { sessionUpdate: 'usage_update', used: 1234, size: 100000, cost: { amount: 0.0015, currency: 'USD' } } },
          ]),
        },
      },
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.usage).toEqual({ totalTokens: 1234, contextSize: 100000 });
    expect(result.cost).toEqual({ amount: 0.0015, currency: 'USD' });
  });

  it('cancels the turn on hard timeout and still cleans up', async () => {
    // Fully deterministic: a controllable deadline timer replaces the
    // wall-clock setTimeout, so startup speed cannot race the deadline.
    // The rejection handler attaches immediately; the test fires the
    // deadline only AFTER the explicit ENTERED acknowledgement proves
    // the turn is parked at the agent mid-turn.
    let fireDeadline = null;
    const createDeadlineTimer = (callback) => {
      if (fireDeadline) throw new Error('unexpected second deadline timer');
      fireDeadline = callback;
      return { unref() {} };
    };
    const { oneOff, manager } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([{ holdForCancel: 30_000 }]),
        },
      },
      oneOffOptions: { timeoutMs: 2000, createDeadlineTimer },
    });
    const pending = oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ACP_ONEOFF_TIMEOUT' });
    pending.catch(() => {});
    await stderrWith(manager, 'ENTERED:oneoff-session-1');
    fireDeadline();
    await rejected;
    expect(await stderrWith(manager, 'CANCELLED:oneoff-session-1')).toContain('CANCELLED:oneoff-session-1');
    expect(await stderrWith(manager, 'DELETE:oneoff-session-1')).toContain('DELETE:oneoff-session-1');
  });

  it('times out a stuck session/new and lets the next call through', async () => {
    const tmpRoot = await tempDir('acp-oneoff-stuck-new-');
    const { oneOff, manager } = await setup({
      entry: { env: { ONEOFF_FIX_HANG: 'new' } },
      // The deadline must clear slow spawn+initialize under parallel
      // load (seconds) yet still prove the timeout path fires on the
      // hang rather than on startup.
      oneOffOptions: { tmpRoot, timeoutMs: 2000 },
    });
    const started = Date.now();
    // First the stuck call fails fast…
    await expect(oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' }))
      .rejects.toMatchObject({ code: 'ACP_ONEOFF_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(10_000);
    // …its temp dir is gone…
    expect(await readdir(tmpRoot)).toEqual([]);
    // …but the agent never answered newSession, so nothing was created.
    expect(await stderrWith(manager, 'HUNG:new')).toContain('HUNG:new');
    // …and the queue is free: this call would hang too, so only assert the
    // first call released the slot by racing a second call's timeout.
    const second = Date.now();
    await expect(oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' }))
      .rejects.toMatchObject({ code: 'ACP_ONEOFF_TIMEOUT' });
    expect(Date.now() - second).toBeLessThan(10_000);
  });

  it('times out a stuck set_config_option without wedging the backend', async () => {
    const { oneOff, manager } = await setup({
      entry: {
        helper: { config: { model: 'helper-model' } },
        env: { ONEOFF_FIX_HANG: 'config' },
      },
      oneOffOptions: { timeoutMs: 2000 },
    });
    const started = Date.now();
    await expect(oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' }))
      .rejects.toMatchObject({ code: 'ACP_ONEOFF_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(10_000);
    const stderr = await stderrWith(manager, 'HUNG:config:oneoff-session-1:model');
    expect(stderr).toContain('HUNG:config:oneoff-session-1:model');
    expect(stderr).toContain('DELETE:oneoff-session-1');
  });

  it('caps a stuck delete/close and still resolves the call', async () => {
    const { oneOff, manager } = await setup({
      entry: { env: { ONEOFF_FIX_HANG: 'delete' } },
      oneOffOptions: { cleanupTimeoutMs: 200 },
    });
    const started = Date.now();
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.text).toBe('fixture-reply');
    expect(result.sessionCleanup).toBe('left');
    expect(await stderrWith(manager, 'HUNG:delete:oneoff-session-1')).toContain('HUNG:delete:oneoff-session-1');
    // The queue moved on: a second call also resolves (also capped).
    const second = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(second.sessionCleanup).toBe('left');
  });

  it('closes when delete is missing and leaves when neither is advertised', async () => {
    const closeOnly = await setup({
      entries: [fixtureEntry({
        id: 'close-only',
        env: { ONEOFF_FIX_CAPS: JSON.stringify({ sessionCapabilities: { close: {} } }) },
      })],
    });
    const closed = await closeOnly.oneOff.generate({ backendId: 'close-only', instruction: 'Hi.', input: 'x' });
    expect(closed.sessionCleanup).toBe('closed');
    expect(await stderrWith(closeOnly.manager, 'CLOSE:oneoff-session-1', 'close-only')).toContain('CLOSE:oneoff-session-1');

    const neither = await setup({
      entries: [fixtureEntry({
        id: 'neither',
        env: { ONEOFF_FIX_CAPS: JSON.stringify({ sessionCapabilities: {} }) },
      })],
    });
    const left = await neither.oneOff.generate({ backendId: 'neither', instruction: 'Hi.', input: 'x' });
    expect(left.sessionCleanup).toBe('left');
    const stderr = await stderrOf(neither.manager, 'neither');
    expect(stderr).not.toContain('DELETE:');
    expect(stderr).not.toContain('CLOSE:');
  });

  it('serializes calls per backend while different backends overlap', async () => {
    // Admission recorded AT the boundary itself: the test wraps the
    // manager's acquire so each lease grant pushes synchronously into
    // the shared event stream — independent of the test's sequential
    // awaits. The final assertion is a strict ordering over that
    // stream: second admission follows first release, fast done
    // precedes it. Fixture cleanup assertions stay on the real agent.
    const hold = JSON.stringify([{ holdForCancel: 30_000 }]);
    const slow = fixtureEntry({ id: 'slow', env: { ONEOFF_FIX_PROMPT_SCRIPT: hold } });
    const fast = fixtureEntry({ id: 'fast', env: { ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([]) } });
    const events = [];
    const note = (name) => events.push(name);
    const handle = await setup({ entries: [slow, fast], oneOffOptions: { timeoutMs: 30_000 } });
    const { oneOff, manager } = handle;
    // Wrap AFTER oneOff construction: generateOne calls manager.acquire
    // per attempt, so every admission — including a concurrent one a
    // broken gate would allow — is recorded at grant time.
    const realAcquire = manager.acquire.bind(manager);
    let slowAdmissions = 0;
    manager.acquire = async (backendId) => {
      const lease = await realAcquire(backendId);
      if (backendId === 'slow') {
        slowAdmissions += 1;
        note(slowAdmissions === 1 ? 'first-admitted' : 'second-admitted');
        const realRelease = lease.release.bind(lease);
        lease.release = () => { note(slowAdmissions === 1 ? 'first-released' : 'second-released'); realRelease(); };
      }
      return lease;
    };
    const cancelAt = (backendId, sessionId) =>
      manager.ensureReady(backendId).then(({ connection }) => connection.cancel({ sessionId }));
    const first = oneOff.generate({ backendId: 'slow', instruction: 'A.', input: 'a' });
    first.catch(() => {});
    // First turn parked at the agent (holding the per-backend slot).
    await stderrWith(manager, 'ENTERED:oneoff-session-1', 'slow');
    const second = oneOff.generate({ backendId: 'slow', instruction: 'B.', input: 'b' });
    second.catch(() => {});
    const other = await oneOff.generate({ backendId: 'fast', instruction: 'C.', input: 'c' });
    expect(other.text).toBe('');
    note('fast-done');
    // Release the parked first turn; the queued sibling is admitted only
    // after the first RELEASES (slot release), then release it too.
    await cancelAt('slow', 'oneoff-session-1');
    const firstResult = await first;
    expect(firstResult.sessionCleanup).toBe('deleted');
    await stderrWith(manager, 'ENTERED:oneoff-session-2', 'slow');
    await cancelAt('slow', 'oneoff-session-2');
    const secondResult = await second;
    expect(secondResult.sessionCleanup).toBe('deleted');
    expect(events).toEqual(['first-admitted', 'fast-done', 'first-released', 'second-admitted', 'second-released']);
  });

  it('holds a lease so idle reap cannot kill the backend mid-turn', async () => {
    // No wall-clock margins: the turn parks until the test releases it,
    // and the reap deadline passing is OBSERVED (a lease-free control
    // backend reaps on it) while the leased one-off backend stays ready.
    const reapFired = [];
    const { oneOff, manager } = await setup({
      entries: [
        fixtureEntry({ id: 'leased', env: { ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([{ holdForCancel: 30_000 }]) } }),
        fixtureEntry({ id: 'control', env: { ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([]) } }),
      ],
      managerOptions: { idleReapMs: 100 },
      oneOffOptions: { timeoutMs: 30_000 },
    });
    manager.events.on('backend-idle-reaped', (event) => reapFired.push(event.backendId));
    const waitForReap = (backendId) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 10_000);
      timer.unref?.();
      const onReap = (event) => {
        if (event.backendId !== backendId) return;
        manager.events.off('backend-idle-reaped', onReap);
        clearTimeout(timer);
        resolve(event.backendId);
      };
      manager.events.on('backend-idle-reaped', onReap);
    });
    // Control first: a lease-free backend observably reaps on the deadline.
    await manager.ensureReady('control');
    expect(await waitForReap('control')).toBe('control');
    expect((await manager.status('control')).state).toBe('idle');
    // Park the one-off turn, then reap the control AGAIN while parked:
    // the deadline observably passes during the lease.
    const call = oneOff.generate({ backendId: 'leased', instruction: 'Hi.', input: 'x' });
    call.catch(() => {});
    const startDeadline = Date.now() + 10_000;
    for (;;) {
      const stderr = await stderrOf(manager, 'leased');
      if (stderr.split('\n').some((line) => line.startsWith('NEW:'))) break;
      if (Date.now() > startDeadline) throw new Error('one-off session never started');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await manager.ensureReady('control');
    expect(await waitForReap('control')).toBe('control');
    // The leased backend survived deadlines that reaped the control.
    expect((await manager.status('leased')).state).toBe('ready');
    expect(reapFired).not.toContain('leased');
    // Release the parked turn by shutting down (aborts the call); the
    // backend was ready until shutdown and never idle-reaped.
    await manager.shutdown();
    await expect(call).rejects.toThrow();
    expect(reapFired).not.toContain('leased');
  });

  it('lets sibling-session updates pass through to the session router', async () => {
    const { oneOff, passthrough } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_NOTIFY_OTHER: JSON.stringify({
            sessionId: 'normal-session-9',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'sibling' } },
          }),
        },
      },
      knownSessions: ['normal-session-9'],
    });
    const result = await oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' });
    expect(result.text).toBe('fixture-reply');
    // The one-off's own chunks were swallowed; the sibling's reached the router.
    expect(passthrough).toEqual([
      { sessionId: 'normal-session-9', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'sibling' } } },
    ]);
    // And the collector released the session: later strays pass through too.
    const hooks = oneOff.hooksForOneOff('fixture');
    expect(hooks.onSessionUpdate({
      sessionId: 'oneoff-session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
    })).toBe(false);
  });

  it('removes the temp cwd even when the prompt fails', async () => {
    const tmpRoot = await tempDir('acp-oneoff-fail-');
    const { oneOff } = await setup({
      entry: {
        env: { ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([{ error: { message: 'boom' } }]) },
      },
      oneOffOptions: { tmpRoot },
    });
    await expect(oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' }))
      .rejects.toThrow();
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('validates its inputs', async () => {
    const { oneOff } = await setup();
    await expect(oneOff.generate({ backendId: '', instruction: 'x', input: 'y' }))
      .rejects.toMatchObject({ code: 'ACP_ONEOFF_INVALID' });
    await expect(oneOff.generate({ backendId: 'fixture', instruction: '  ', input: 'y' }))
      .rejects.toMatchObject({ code: 'ACP_ONEOFF_INVALID' });
    await expect(oneOff.generate({ backendId: 'fixture', instruction: 'x', input: 42 }))
      .rejects.toMatchObject({ code: 'ACP_ONEOFF_INVALID' });
    await expect(oneOff.generate({ backendId: 'fixture', instruction: 'x', input: 'y', maxChars: -1 }))
      .rejects.toMatchObject({ code: 'ACP_ONEOFF_INVALID' });
  });

  it('uses a fresh empty cwd per call', async () => {
    const { oneOff, manager } = await setup();
    await oneOff.generate({ backendId: 'fixture', instruction: 'A.', input: 'a' });
    await oneOff.generate({ backendId: 'fixture', instruction: 'B.', input: 'b' });
    // Both NEW echoes must have landed before counting them.
    const start = Date.now();
    let cwds = [];
    for (;;) {
      const stderr = await stderrOf(manager);
      cwds = stderr.split('\n')
        .filter((line) => line.startsWith('NEW:'))
        .map((line) => line.split('cwd=')[1]);
      if (cwds.length >= 2 || Date.now() - start > 15_000) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cwds).toHaveLength(2);
    expect(cwds[0]).not.toBe(cwds[1]);
    for (const cwd of cwds) {
      await expect(stat(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

describe('trimOneOffOutput', () => {
  it('strips fences, quotes, preamble and sign-off, then truncates', () => {
    expect(trimOneOffOutput('```\nFix typo in README\n```')).toBe('Fix typo in README');
    expect(trimOneOffOutput('"Fix typo in README"')).toBe('Fix typo in README');
    expect(trimOneOffOutput('Here is your commit message:\nFix typo in README')).toBe('Fix typo in README');
    expect(trimOneOffOutput('Sure!\nFix typo in README\n\nHope this helps!')).toBe('Fix typo in README');
    expect(trimOneOffOutput('Fix typo in README')).toBe('Fix typo in README');
    expect(trimOneOffOutput('  ')).toBe('');
    expect(trimOneOffOutput('abcdef', 4)).toBe('abcd');
    expect(trimOneOffOutput('Fix typo in README', 0)).toBe('');
  });

  it('unwraps fences behind a preamble and preserves real headings', () => {
    expect(trimOneOffOutput('Here is your commit message:\n```\nFix typo\n```')).toBe('Fix typo');
    expect(trimOneOffOutput('Sure!\n"Fix typo"')).toBe('Fix typo');
    // Legitimate requested headings survive.
    expect(trimOneOffOutput('Summary:\nChanged parser')).toBe('Summary:\nChanged parser');
    expect(trimOneOffOutput('Notes:\n- a\n- b')).toBe('Notes:\n- a\n- b');
    expect(trimOneOffOutput('Fixes:\n#123')).toBe('Fixes:\n#123');
  });
});
