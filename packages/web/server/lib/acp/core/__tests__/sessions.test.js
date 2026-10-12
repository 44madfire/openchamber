import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcpBackendManager } from '../backend-manager.js';
import { createAcpBackendRegistry } from '../registry.js';
import { createAcpSessionIndex } from '../session-index.js';
import { createAcpSessionService } from '../sessions.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

const tempDir = (prefix) => mkdtemp(join(tmpdir(), prefix));

const fakeEntry = (overrides = {}) => ({
  id: 'fake',
  label: 'fake',
  command: process.execPath,
  args: [FAKE_AGENT],
  enabled: true,
  ...overrides,
});

const managers = [];
const services = [];

afterEach(async () => {
  while (services.length > 0) services.pop().dispose();
  while (managers.length > 0) await managers.pop().shutdown();
});

const setup = async ({ entry = {}, entries = null, indexDir, serviceOptions = {} } = {}) => {
  const registry = createAcpBackendRegistry({ dataDir: await tempDir('acp-svc-reg-'), resolveCommand: () => null });
  await registry.save(entries ?? [fakeEntry(entry)]);
  const { spawnAcpAgent } = await import('../spawn.js');
  const spawnAgent = (options) =>
    spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} });
  const index = createAcpSessionIndex({ dataDir: indexDir ?? await tempDir('acp-svc-idx-') });
  // The manager needs the service's hooks before first connect, and the
  // service needs the manager: forward through a holder, like the host.
  // Hooks are bound per backend via the factory.
  const holder = { current: null };
  const manager = createAcpBackendManager({
    registry,
    spawnAgent,
    stderrFlushMs: 10,
    connectionHooks: (backendId, generation) => holder.current?.hooksForBackend(backendId, generation) ?? {},
  });
  managers.push(manager);
  const service = createAcpSessionService({ manager, index, registry, settleMs: 5, watchdogMs: 200, ...serviceOptions });
  holder.current = service;
  services.push(service);
  return { service, manager, index, registry };
};

const syncEvents = (service) => {
  const frames = [];
  service.events.on('sync', (frame) => frames.push(frame));
  return frames;
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

describe('acp session service', () => {
  it('creates a session via session/new and emits session.created', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([{ id: 'model', name: 'Model', type: 'select', currentValue: 'm1' }]),
        },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    expect(session.id).toMatch(/^ses_acp-fake_r/);
    expect(session.directory).toBe('C:\\work');
    expect(session.projectID).toBe('acp:fake');
    expect(session.metadata.acp).toMatchObject({ backendId: 'fake' });
    expect(session.metadata.acp.configOptions).toEqual([
      { id: 'model', name: 'Model', type: 'select', current: 'm1' },
    ]);
    expect(frames).toHaveLength(1);
    expect(frames[0].events[0].type).toBe('session.created');
  });

  it('prompts, streams chunks, and settles the turn', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'he' } } },
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'llo' } } },
          ]),
        },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'hi' }] });
    await until(() => frames.some((frame) =>
      frame.events.some((event) => event.type === 'session.idle')));

    const types = frames.flatMap((frame) => frame.events.map((event) => event.type));
    expect(types.slice(0, 4)).toEqual(['session.created', 'message.updated', 'message.parts.replaced', 'session.status']);
    const page = await service.messages({ key: session.id, limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].parts[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(page.items[1].info.id).toBe('msg_1');
  });

  it('409s a second prompt while busy', async () => {
    const { service } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 300 }]) } },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'one' }] });
    await expect(
      service.prompt({ key: session.id, messageId: 'msg_2', parts: [{ type: 'text', text: 'two' }] }),
    ).rejects.toMatchObject({ code: 'ACP_SESSION_BUSY' });
    await service.cancel({ key: session.id });
  });

  it('cancels mid-stream: interrupted, cascade, follow-up works', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'part' } } },
            { holdForCancel: 5000 },
          ]),
        },
      },
      // This test drives the cancel itself; recovery must not interfere.
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    await until(() => frames.some((frame) =>
      frame.events.some((event) => event.type === 'message.part.delta')));
    expect(await service.cancel({ key: session.id })).toBe(true);
    await until(() => frames.some((frame) =>
      frame.events.some((event) => event.type === 'session.idle' && event.properties.outcome === 'interrupted')));
    const tail = await manager.status('fake').then(() => service.messages({ key: session.id, limit: 5 }));
    expect(tail.items[0].parts[0].text).toBe('part');

    // Follow-up works after the cancel.
    await service.prompt({ key: session.id, messageId: 'msg_2', parts: [{ type: 'text', text: 'again' }] });
    await service.cancel({ key: session.id });
    expect(await service.cancel({ key: session.id })).toBe(false);
  });

  it('reopens a cold session via load replay', async () => {
    const indexDir = await tempDir('acp-svc-reopen-');
    const replay = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a1' } },
    ];
    const first = await setup({ indexDir, entry: { env: { FAKE_ACP_LOAD_REPLAY: JSON.stringify(replay) } } });
    const created = await first.service.create({ backendId: 'fake', directory: 'C:\\work' });
    const key = created.session.id;
    first.service.dispose();
    await first.manager.shutdown();
    managers.splice(managers.indexOf(first.manager), 1);

    const second = await setup({ indexDir, entry: { env: { FAKE_ACP_LOAD_REPLAY: JSON.stringify(replay) } } });
    const opened = await second.service.open({ key });
    expect(opened.session.id).toBe(key);
    const page = await second.service.messages({ key, limit: 10 });
    expect(page.items.map((item) => item.info.role)).toEqual(['assistant', 'user']);
    expect(page.items[1].parts[0].text).toBe('q1');
    expect(page.items[0].parts[0].text).toBe('a1');
  });

  it('deletes via delete cap, closes when delete is missing', async () => {
    const withDelete = await setup({
      entry: {
        env: {
          FAKE_ACP_DELETE: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { delete: {} } }),
        },
      },
    });
    const created = await withDelete.service.create({ backendId: 'fake', directory: 'C:\\work' });
    await expect(withDelete.service.delete({ key: created.session.id })).resolves.toBe(true);
    await expect(withDelete.index.get(created.session.id)).resolves.toBeNull();

    const closeOnly = await setup({
      entry: {
        env: {
          FAKE_ACP_CLOSE: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { close: {} } }),
        },
      },
    });
    const created2 = await closeOnly.service.create({ backendId: 'fake', directory: 'C:\\work' });
    await expect(closeOnly.service.delete({ key: created2.session.id })).resolves.toBe(true);
    await expect(closeOnly.index.get(created2.session.id)).resolves.toBeNull();
  });

  it('merges session/list and drops other directories', async () => {
    const seeds = [
      { sessionId: 'listed-here', cwd: 'C:\\work', title: 'from agent' },
      { sessionId: 'listed-elsewhere', cwd: 'C:\\other', title: 'nope' },
    ];
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_SESSIONS: JSON.stringify(seeds),
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { list: {} } }),
        },
      },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    const rows = await service.list({ directory: 'C:\\work' });
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(session.id);
    expect(ids).toContain('ses_acp-fake_rlisted-here');
    expect(ids).not.toContain('ses_acp-fake_rlisted-elsewhere');
    expect([...ids].sort()).toEqual(ids);
    expect(rows.find((row) => row.id === 'ses_acp-fake_rlisted-here').title).toBe('from agent');
  });

  it('renames persist as the user title and win over agent titles', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'session_info_update', title: 'agent title' } },
          ]),
        },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    const renamed = await service.rename({ key: session.id, title: 'my name' });
    expect(renamed.session.title).toBe('my name');
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    await until(() => frames.some((frame) =>
      frame.events.some((event) => event.type === 'session.idle')));
    expect((await service.open({ key: session.id })).session.title).toBe('my name');
  });

  it('sets config options via set_config_option and refreshes the cache', async () => {
    const { service, manager, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([{ id: 'model', name: 'Model', type: 'select', currentValue: 'm1' }]),
        },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.config({ key: session.id, configId: 'model', value: 'm2' });
    // The RPC reached the agent with the right params.
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/CONFIG:.*"configId":"model".*"value":"m2"/);
    // The session metadata refreshed and the index remembers the choice.
    expect(frames.some((frame) => frame.events.some((event) =>
      event.type === 'session.patched' && event.properties.patch.metadata !== undefined))).toBe(true);
    await expect(index.get(session.id)).resolves.toMatchObject({ lastConfig: { model: 'm2' } });
  });

  it('surfaces prompt errors as session.error', async () => {
    const { service } = await setup({
      entry: {
        env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ error: { code: -32603, message: 'fake blew up' } }]) },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    const errorFrame = await until(() => frames.find((frame) =>
      frame.events.some((event) => event.type === 'session.error')));
    expect(errorFrame.events.find((event) => event.type === 'session.error')).toMatchObject({
      properties: { sessionID: session.id, error: { message: expect.stringContaining('fake blew up') } },
    });
  });

  it('reports busy status per directory', async () => {
    const { service } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 300 }]) } },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    expect(await service.status({ directory: 'C:\\work' })).toEqual({ [session.id]: { type: 'idle' } });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    expect(await service.status({ directory: 'C:\\work' })).toEqual({ [session.id]: { type: 'busy' } });
    expect(await service.status({ directory: 'C:\\other' })).toEqual({});
    await service.cancel({ key: session.id });
  });

  it('errors live sessions when the backend crashes', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_CRASH_ON: '400',
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 5000 }]),
        },
      },
      // The crash (400ms) must land before any watchdog recovery.
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    const errorFrame = await until(() => frames.find((frame) =>
      frame.events.some((event) => event.type === 'session.error')), { timeout: 8000 });
    expect(errorFrame.events.find((event) => event.type === 'session.error')).toMatchObject({
      properties: { error: { message: expect.stringContaining('exited') } },
    });
    expect(service.getLive(session.id)).toBeNull();
  });

  it('routes updates only to the bound backend (same native id, two backends)', async () => {
    const promptScript = JSON.stringify([
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'backend-b-output' } } },
    ]);
    const { service } = await setup({
      entries: [fakeEntry({ id: 'a' }), fakeEntry({ id: 'b', env: { FAKE_ACP_PROMPT_SCRIPT: promptScript } })],
    });
    const createdA = await service.create({ backendId: 'a', directory: 'C:\\work' });
    const createdB = await service.create({ backendId: 'b', directory: 'C:\\work' });
    // Both fakes mint `fake-session-1`: the second backend's output must
    // still land in its own projector.
    await service.prompt({ key: createdA.session.id, messageId: 'msg_a', parts: [{ type: 'text', text: 'qa' }] });
    await service.prompt({ key: createdB.session.id, messageId: 'msg_b', parts: [{ type: 'text', text: 'qb' }] });
    await until(async () => {
      const page = await service.messages({ key: createdB.session.id, limit: 5 });
      return page.items[0]?.info?.finish === 'stop' && page;
    });
    const pageA = await service.messages({ key: createdA.session.id, limit: 5 });
    // A's transcript holds only its own question — none of b's output.
    expect(JSON.stringify(pageA)).not.toContain('backend-b-output');
    const pageB = await service.messages({ key: createdB.session.id, limit: 5 });
    expect(pageB.items[0].parts[0].text).toBe('backend-b-output');
  });

  it('shares one load across concurrent cold opens', async () => {
    const indexDir = await tempDir('acp-svc-conc-');
    const replay = [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a1' } }];
    const first = await setup({ indexDir, entry: { env: { FAKE_ACP_LOAD_REPLAY: JSON.stringify(replay) } } });
    const created = await first.service.create({ backendId: 'fake', directory: 'C:\\work' });
    const key = created.session.id;
    first.service.dispose();
    await first.manager.shutdown();
    managers.splice(managers.indexOf(first.manager), 1);

    const second = await setup({ indexDir, entry: { env: { FAKE_ACP_LOAD_REPLAY: JSON.stringify(replay) } } });
    const [one, two] = await Promise.all([second.service.open({ key }), second.service.open({ key })]);
    expect(one.session.id).toBe(key);
    expect(two.session.id).toBe(key);
    // One projector served both callers.
    expect(second.service.getLive(key)).not.toBeNull();
    const page = await second.service.messages({ key, limit: 10 });
    expect(page.items.map((item) => item.info.role)).toEqual(['assistant']);
  });

  it('resumes (not reloads) a warm session after a backend restart', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_RESUME: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { resume: {} } }),
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kept' } } },
          ]),
        },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    await until(() => frames.some((frame) =>
      frame.events.some((event) => event.type === 'session.idle')));
    await manager.restart('fake');
    const reopened = await service.open({ key: session.id });
    expect(reopened.session.id).toBe(session.id);
    // Resume keeps the live projection (no replay duplication).
    const page = await service.messages({ key: session.id, limit: 10 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].parts[0].text).toBe('kept');
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toContain('RESUME:');
  });

  it('answers parked permission requests with cancelled on cancel', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { permission: { toolCall: { toolCallId: 't1' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } },
            { holdForCancel: 5000 },
          ]),
        },
      },
      // Parked requests emit no updates; recovery must not fire mid-test.
      serviceOptions: { watchdogMs: 30_000 },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    await until(async () => (await manager.status('fake')).stderrTail.includes('PERMISSION:') === false
      && service.getLive(session.id) !== null
      && (await service.messages({ key: session.id, limit: 1 }).catch(() => null), true));
    // Give the agent a beat to park the permission request server-side.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await service.cancel({ key: session.id })).toBe(true);
    await until(async () => (await manager.status('fake')).stderrTail.includes('PERMISSION:'));
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/PERMISSION:.*"cancelled"/);
  });

  it('discovers agent sessions with an empty index and persists them', async () => {
    const seeds = [{ sessionId: 'agent-known', cwd: 'C:\\work', title: 'agent history' }];
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_SESSIONS: JSON.stringify(seeds),
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { list: {} } }),
        },
      },
    });
    const rows = await service.list({ directory: 'C:\\work' });
    expect(rows.map((row) => row.id)).toEqual(['ses_acp-fake_ragent-known']);
    // Persisted: opening works without a prior create.
    await expect(index.get('ses_acp-fake_ragent-known')).resolves.toMatchObject({ nativeId: 'agent-known' });
    const opened = await service.open({ key: 'ses_acp-fake_ragent-known' });
    expect(opened.session.title).toBe('agent history');
  });

  it('sends set_mode directly for modes-without-config agents', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_MODES: JSON.stringify({
            currentModeId: 'build',
            availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
          }),
        },
      },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.config({ key: session.id, configId: 'mode', value: 'plan' });
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toContain('MODE:');
    expect(tail).not.toContain('CONFIG:');
    expect(service.getLive(session.id).projector.session().metadata.acp.modes).toContainEqual(
      expect.objectContaining({ id: 'plan', current: true }),
    );
  });

  it('persists agent titles to the index (survives without reopen)', async () => {
    const indexDir = await tempDir('acp-svc-title-');
    const first = await setup({
      indexDir,
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'session_info_update', title: 'agent-named' } },
          ]),
        },
      },
    });
    const frames = syncEvents(first.service);
    const { session } = await first.service.create({ backendId: 'fake', directory: 'C:\\work' });
    await first.service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    await until(() => frames.some((frame) =>
      frame.events.some((event) => event.type === 'session.idle')));
    await until(async () => (await first.index.get(session.id))?.title === 'agent-named');
    first.service.dispose();
    await first.manager.shutdown();
    managers.splice(managers.indexOf(first.manager), 1);

    const second = await setup({ indexDir });
    const rows = await second.service.list({ directory: 'C:\\work' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('agent-named');
  });

  it('evicts idle projections under the LRU cap and rebuilds via load', async () => {
    const replay = [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'rebuilt' } }];
    const { service } = await setup({
      entry: { env: { FAKE_ACP_LOAD_REPLAY: JSON.stringify(replay) } },
      serviceOptions: { maxInactiveProjections: 1, idleEvictMs: 60_000 },
    });
    const one = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    const two = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    // The first projection evicted (cap 1); its index entry stays.
    expect(service.getLive(one.session.id)).toBeNull();
    expect(service.getLive(two.session.id)).not.toBeNull();
    // Reopening rebuilds via load replay.
    await service.open({ key: one.session.id });
    const page = await service.messages({ key: one.session.id, limit: 10 });
    expect(page.items[0].parts[0].text).toBe('rebuilt');
  });

  it('watchdog recovers a stalled turn: reload, retry once, then error', async () => {
    const { service } = await setup({
      entry: {
        env: {
          // Never resolves: no updates, no result. The watchdog must fire.
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 30_000 }]),
          FAKE_ACP_LOAD_REPLAY: JSON.stringify([
            { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 150, settleMs: 5 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    // First watchdog: recovery reloads and replays the prompt once; the
    // retry also stalls, so the second watchdog errors the turn.
    const errorFrame = await until(() => frames.find((frame) =>
      frame.events.some((event) => event.type === 'session.error'
        && event.properties.error.message.includes('stalled twice'))), { timeout: 15000 });
    expect(errorFrame).toBeDefined();
    // Terminal recovery drops the record; a fresh open rebuilds via load
    // (proving the lock released and the session still opens).
    expect(service.getLive(session.id)).toBeNull();
    const reopened = await service.open({ key: session.id });
    expect(reopened.session.id).toBe(session.id);
    const page = await service.messages({ key: session.id, limit: 10 });
    expect(page.items.map((item) => item.info.role)).toEqual(['user']);
  }, 20000);

  it('rejects stale-generation callbacks after a backend restart', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_RESUME: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { resume: {} } }),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    const staleGeneration = service.getLive(session.id).generation;
    const staleHooks = service.hooksForBackend('fake', staleGeneration);
    await manager.restart('fake');
    await service.open({ key: session.id });
    expect(service.getLive(session.id).generation).not.toBe(staleGeneration);
    // Stale update: dropped.
    staleHooks.onSessionUpdate({
      sessionId: service.getLive(session.id) && 'fake-session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE' } },
    });
    const page = await service.messages({ key: session.id, limit: 10 });
    expect(JSON.stringify(page)).not.toContain('STALE');
    // Stale permission/elicitation: answered cancelled, never parked.
    expect(await staleHooks.onRequestPermission({ sessionId: 'fake-session-1' }))
      .toEqual({ outcome: { outcome: 'cancelled' } });
    expect(await staleHooks.onElicitation({ sessionId: 'fake-session-1' }))
      .toEqual({ action: 'cancel' });
    expect(service.getLive(session.id).pendingRequests).toHaveLength(0);
  });

  it('watchdog load failure emits a terminal error and releases the turn', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 30_000 }]),
          FAKE_ACP_LOAD_ERROR: JSON.stringify({ code: -32603, message: 'load failed' }),
        },
      },
      serviceOptions: { watchdogMs: 150, settleMs: 5 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
    const errorFrame = await until(() => frames.find((frame) =>
      frame.events.some((event) => event.type === 'session.error'
        && event.properties.error.message.includes('watchdog reload failed'))), { timeout: 15000 });
    expect(errorFrame).toBeDefined();
    // Waiters released: the record dropped and the session reopens.
    expect(service.getLive(session.id)).toBeNull();
  }, 20000);

  it('omits discoveries whose sidecar write fails', async () => {
    const seeds = [{ sessionId: 'listed-but-unpersisted', cwd: 'C:\\work', title: 'x' }];
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_SESSIONS: JSON.stringify(seeds),
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { list: {} } }),
        },
      },
    });
    // Fail only the discovery upsert (seeded rows would already exist).
    const realUpsert = index.upsert.bind(index);
    index.upsert = async (key, patch) => {
      if (key === 'ses_acp-fake_rlisted-but-unpersisted') throw new Error('disk full');
      return realUpsert(key, patch);
    };
    const rows = await service.list({ directory: 'C:\\work' });
    // The unpersisted discovery is omitted — every returned row opens.
    expect(rows.map((row) => row.id)).not.toContain('ses_acp-fake_rlisted-but-unpersisted');
    for (const row of rows) {
      await expect(service.open({ key: row.id })).resolves.toBeDefined();
    }
  });
});
