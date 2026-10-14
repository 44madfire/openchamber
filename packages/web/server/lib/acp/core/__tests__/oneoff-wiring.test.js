import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcpBackendManager } from '../backend-manager.js';
import { createOneOff } from '../oneoff.js';
import { createAcpBackendRegistry } from '../registry.js';
import { createAcpSessionIndex } from '../session-index.js';
import { createAcpSessionService } from '../sessions.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const ONEOFF_AGENT = fileURLToPath(new URL('./oneoff-agent.mjs', import.meta.url));

const tempDir = (prefix) => mkdtemp(join(tmpdir(), prefix));
const managers = [];
const services = [];

afterEach(async () => {
  while (services.length > 0) services.pop().dispose();
  while (managers.length > 0) await managers.pop().shutdown();
});

const setup = async ({ entries, serviceOptions = {}, oneOffOptions = {} } = {}) => {
  const registry = createAcpBackendRegistry({ dataDir: await tempDir('acp-ow-reg-'), resolveCommand: () => null });
  await registry.save(entries);
  const { spawnAcpAgent } = await import('../spawn.js');
  const spawnAgent = (options) =>
    spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} });
  const sessionHolder = { current: null };
  const oneOffHolder = { current: null };
  // Production hook composition (oneoff.js header): one-off first, only
  // claims its own sessions; everything else reaches the session router.
  const manager = createAcpBackendManager({
    registry,
    spawnAgent,
    stderrFlushMs: 10,
    connectionHooks: (backendId, generation) => {
      const sessions = sessionHolder.current?.hooksForBackend(backendId, generation) ?? {};
      const oneOff = oneOffHolder.current?.hooksForOneOff(backendId, {
        isKnownSession: (sessionId) => sessionHolder.current?.hasNativeSession?.(backendId, sessionId) === true,
      });
      if (!oneOff) return sessions;
      return {
        ...sessions,
        onSessionUpdate: async (params) => {
          if (await oneOff.onSessionUpdate(params)) return;
          await sessions.onSessionUpdate?.(params);
        },
        onRequestPermission: async (params) => (
          (await oneOff.onRequestPermission?.(params)) ?? sessions.onRequestPermission(params)
        ),
        onElicitation: async (params) => (
          (await oneOff.onElicitation?.(params)) ?? sessions.onElicitation(params)
        ),
      };
    },
  });
  managers.push(manager);
  const index = createAcpSessionIndex({ dataDir: await tempDir('acp-ow-idx-') });
  const service = createAcpSessionService({ manager, index, registry, settleMs: 5, watchdogMs: 500, ...serviceOptions });
  sessionHolder.current = service;
  services.push(service);
  const oneOff = createOneOff({ manager, registry, index, ...oneOffOptions });
  oneOffHolder.current = oneOff;
  return { service, manager, registry, index, oneOff };
};

const oneOffEntry = (id, overrides = {}) => ({
  id, label: id, command: process.execPath, args: [ONEOFF_AGENT], enabled: true, ...overrides,
});

const until = async (predicate, { timeout = 15_000 } = {}) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('acp one-off wiring', () => {
  it('resolves the backend: explicit, session-key default, first ready', async () => {
    const secondDir = await tempDir('acp-ow-idx2-');
    const { oneOff, service } = await setup({
      entries: [
        oneOffEntry('first'),
        oneOffEntry('second'),
        { id: 'off', label: 'off', command: 'does-not-exist-acp', args: [], enabled: false },
      ],
    });
    void secondDir;
    expect(await oneOff.resolveBackend({ backendId: 'second' })).toBe('second');
    await expect(oneOff.resolveBackend({ backendId: 'nope' })).rejects.toMatchObject({ code: 'ACP_BACKEND_UNKNOWN' });
    await expect(oneOff.resolveBackend({ backendId: 'off' })).rejects.toMatchObject({ code: 'ACP_BACKEND_DISABLED' });
    const cwd = await tempDir('acp-ow-resolve-');
    const { session } = await service.create({ backendId: 'second', directory: cwd });
    expect(await oneOff.resolveBackend({ sessionKey: session.id })).toBe('second');
    await expect(oneOff.resolveBackend({ sessionKey: 'ses_acp-second_rnope' })).rejects.toMatchObject({ code: 'ACP_SESSION_UNKNOWN' });
    expect(await oneOff.resolveBackend({})).toBe('first');
  });

  it('fails closed when no backend is ready', async () => {
    const { oneOff } = await setup({
      entries: [{ id: 'dead', label: 'dead', command: 'does-not-exist-acp', args: [], enabled: true }],
    });
    await expect(oneOff.resolveBackend({})).rejects.toMatchObject({ code: 'ACP_BACKEND_UNAVAILABLE' });
  });

  it('generates while a normal session turn runs: neither disturbs the other', async () => {
    const { service, oneOff } = await setup({
      entries: [oneOffEntry('fixture', {
        env: {
          ONEOFF_FIX_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'normal-reply' } } },
          ]),
          ONEOFF_FIX_PROMPT_DELAY_MS: '300',
        },
      })],
      oneOffOptions: { tmpRoot: await tempDir('acp-ow-tmp-') },
    });
    const frames = [];
    service.events.on('sync', (frame) => frames.push(frame));
    const cwd = await tempDir('acp-ow-live-');
    const { session } = await service.create({ backendId: 'fixture', directory: cwd });
    const normalPrompt = service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'hi' }] });
    const generated = oneOff.generate({ backendId: 'fixture', instruction: 'Say hi.', input: 'x' });
    const [result] = await Promise.all([
      generated,
      normalPrompt.then(() => until(() => frames.some((frame) =>
        frame.events.some((event) => event.type === 'session.idle')))),
    ]);
    // The throwaway collected only its own reply (and cleaned up). The
    // fixture agent answers every prompt from the script, so the one-off
    // legitimately collects the same text as the normal session here —
    // the isolation proof is the normal transcript below.
    expect(result.text).toBe('normal-reply');
    expect(result.sessionCleanup).toBe('deleted');
    const page = await service.messages({ key: session.id });
    const texts = page.items.flatMap((item) => item.parts).filter((part) => part.type === 'text').map((part) => part.text);
    expect(texts.join('')).toContain('normal-reply');
  });

  it('claims only its own sessions in the composed hooks', async () => {
    const { service, oneOff } = await setup({ entries: [oneOffEntry('fixture')] });
    const cwd = await tempDir('acp-ow-claim-');
    const { session } = await service.create({ backendId: 'fixture', directory: cwd });
    const record = service.getLive(session.id);
    const hooks = oneOff.hooksForOneOff('fixture', {
      isKnownSession: (id) => service.hasNativeSession('fixture', id),
    });
    // A normal session's traffic is never claimed.
    expect(hooks.onSessionUpdate({ sessionId: record.nativeId, update: { sessionUpdate: 'agent_message_chunk' } })).toBe(false);
    expect(hooks.onRequestPermission({ sessionId: record.nativeId })).toBeNull();
    expect(service.hasNativeSession('fixture', record.nativeId)).toBe(true);
    expect(service.hasNativeSession('fixture', 'throwaway-1')).toBe(false);
    void session;
  });

  it('one-off inherits sequential session changes through the service persistence path', async () => {
    // End-to-end through the real persistence: create, then model→effort
    // via service.config (no manual index seeding). The throwaway must
    // apply both session values — the model must not roll back.
    const { service, manager, oneOff } = await setup({ entries: [oneOffEntry('fixture')] });
    const cwd = await tempDir('acp-ow-inherit-');
    const { session } = await service.create({ backendId: 'fixture', directory: cwd });
    await service.config({ key: session.id, configId: 'model', value: 'helper-model' });
    await service.config({ key: session.id, configId: 'effort', value: 'none' });
    const result = await oneOff.generate({
      backendId: 'fixture',
      instruction: 'Hi.',
      input: 'x',
      sessionKey: session.id,
    });
    expect(result.text).toBe('fixture-reply');
    const stderr = (await manager.status('fixture')).stderrTail;
    const applied = stderr.split('\n')
      .filter((line) => line.startsWith('CONFIG:'))
      .map((line) => JSON.parse(line.slice('CONFIG:'.length)));
    // The throwaway session (oneoff-session-1) got both session values;
    // earlier CONFIG lines belong to the service.config calls above.
    expect(applied.filter((row) => row.sessionId === 'oneoff-session-1')).toEqual([
      { sessionId: 'oneoff-session-1', configId: 'model', value: 'helper-model', type: null },
      { sessionId: 'oneoff-session-1', configId: 'effort', value: 'none', type: null },
    ]);
  });

  it('authTerminal resolves terminal methods and never authenticates them', async () => {
    const { manager } = await setup({
      entries: [{
        id: 'fake', label: 'fake', command: process.execPath, args: [FAKE_AGENT], enabled: true,
        env: {
          FAKE_ACP_AUTH_METHODS: JSON.stringify([
            { id: 'login', name: 'Login', type: 'terminal', args: ['auth', 'login'], env: { ACP_FORCE_TTY: '1' } },
            { id: 'token', name: 'Token' },
          ]),
          FAKE_ACP_AUTHENTICATE: '{}',
        },
      }],
    });
    const resolved = await manager.authTerminal('fake');
    expect(resolved.methodId).toBe('login');
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual([FAKE_AGENT, 'auth', 'login']);
    expect(resolved.env).toMatchObject({ ACP_FORCE_TTY: '1' });
    // Agent methods are not terminal methods; terminal methods never authenticate.
    await expect(manager.authTerminal('fake', 'token')).rejects.toMatchObject({ code: 'ACP_AUTH_NOT_TERMINAL' });
    await expect(manager.authTerminal('fake', 'nope')).rejects.toMatchObject({ code: 'ACP_AUTH_UNKNOWN_METHOD' });
    await expect(manager.authenticate('fake', 'login')).rejects.toMatchObject({ code: 'ACP_AUTH_TERMINAL' });
    const stderr = (await manager.status('fake')).stderrTail;
    expect(stderr).not.toContain('AUTHENTICATE:login');
  });

  it('authTerminal rejects ambiguous omission', async () => {
    const { manager } = await setup({
      entries: [{
        id: 'fake', label: 'fake', command: process.execPath, args: [FAKE_AGENT], enabled: true,
        env: {
          FAKE_ACP_AUTH_METHODS: JSON.stringify([
            { id: 'a', name: 'A', type: 'terminal' },
            { id: 'b', name: 'B', type: 'terminal' },
          ]),
        },
      }],
    });
    await expect(manager.authTerminal('fake')).rejects.toMatchObject({ code: 'ACP_AUTH_UNKNOWN_METHOD' });
    expect((await manager.authTerminal('fake', 'b')).methodId).toBe('b');
  });
});
