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
// asynchronously, so a marker asserted immediately after a fast timeout
// may not have arrived yet. Poll briefly instead of asserting once.
const stderrWith = async (manager, marker, backendId = 'fixture', timeoutMs = 5000) => {
  const start = Date.now();
  for (;;) {
    const stderr = await stderrOf(manager, backendId);
    if (stderr.includes(marker)) return stderr;
    if (Date.now() - start > timeoutMs) return stderr;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const stderrLines = async (manager, prefix, backendId = 'fixture') =>
  (await stderrOf(manager, backendId)).split('\n').filter((line) => line.startsWith(prefix));

const configLines = async (manager, backendId = 'fixture') =>
  (await stderrLines(manager, 'CONFIG:', backendId))
    .map((line) => JSON.parse(line.slice('CONFIG:'.length)));

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
    const stderr = await stderrOf(manager);
    expect(stderr).toContain('DELETE:oneoff-session-1');
    expect(stderr).toMatch(/NEW:oneoff-session-1 cwd=.*acp-oneoff-/);
    // The per-call temp dir is removed afterwards.
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it('sends the strict-format instruction plus input as text blocks', async () => {
    const { oneOff, manager } = await setup({
      entry: { env: { ONEOFF_FIX_RECORD_PROMPTS: '1' } },
    });
    await oneOff.generate({ backendId: 'fixture', instruction: 'Summarize.', input: 'some diff' });
    const stderr = await stderrOf(manager);
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
    const applied = await configLines(manager);
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
    expect(await configLines(manager)).toEqual([
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
    const stderr = await stderrOf(manager);
    expect(stderr).toContain('PERMISSION:{"outcome":{"outcome":"cancelled"}}');
    expect(stderr).toContain('ELICITATION:{"action":"cancel"}');
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
    const { oneOff, manager } = await setup({
      entry: {
        env: {
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([{ holdForCancel: 30_000 }]),
        },
      },
      oneOffOptions: { timeoutMs: 300 },
    });
    const started = Date.now();
    await expect(oneOff.generate({ backendId: 'fixture', instruction: 'Hi.', input: 'x' }))
      .rejects.toMatchObject({ code: 'ACP_ONEOFF_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(10_000);
    const stderr = await stderrOf(manager);
    expect(stderr).toContain('CANCELLED:oneoff-session-1');
    expect(stderr).toContain('DELETE:oneoff-session-1');
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
    expect(await stderrOf(closeOnly.manager, 'close-only')).toContain('CLOSE:oneoff-session-1');

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
    const script = JSON.stringify([{ sleepMs: 400 }]);
    const slow = fixtureEntry({
      id: 'slow',
      env: { ONEOFF_FIX_PROMPT_SCRIPT: script, ONEOFF_FIX_PROMPT_DELAY_MS: '100' },
    });
    const fast = fixtureEntry({
      id: 'fast',
      env: { ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([]) },
    });
    const { oneOff } = await setup({ entries: [slow, fast] });
    const started = Date.now();
    const [first, second, other] = await Promise.all([
      oneOff.generate({ backendId: 'slow', instruction: 'A.', input: 'a' }),
      oneOff.generate({ backendId: 'slow', instruction: 'B.', input: 'b' }),
      oneOff.generate({ backendId: 'fast', instruction: 'C.', input: 'c' }),
    ]);
    // Same-backend calls ran one after another (~1 s), not in parallel.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(first.sessionCleanup).toBe('deleted');
    expect(second.sessionCleanup).toBe('deleted');
    expect(other.text).toBe('');
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
    const stderr = await stderrOf(manager);
    const cwds = stderr.split('\n')
      .filter((line) => line.startsWith('NEW:'))
      .map((line) => line.split('cwd=')[1]);
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
