import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcpBackendManager } from '../backend-manager.js';
import { createAcpBackendRegistry } from '../registry.js';
import { createAcpSessionIndex } from '../session-index.js';
import { createAcpSessionService } from '../sessions.js';
import { normalizeDirectory } from '../directory-key.js';

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
  const service = createAcpSessionService({ canonicalDirectory: async (d) => normalizeDirectory(d), manager, index, registry, settleMs: 5, watchdogMs: 200, ...serviceOptions });
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
  it('does not resurrect a close-only delete via session/list', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_CLOSE: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { close: {}, list: {} } }),
        },
      },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await expect(service.delete({ key: session.id })).resolves.toBe(true);
    // The agent's list still names the closed session (close is not delete);
    // the listing must not resurrect it, and the index must stay clean.
    const rows = await service.list({ directory: 'C:\\work' });
    expect(rows.map((row) => row.id)).not.toContain(session.id);
    await expect(service.open({ key: session.id })).rejects.toMatchObject({ code: 'ACP_SESSION_UNKNOWN' });
  });

  it('D2: pre-prompt agent chunks become a sealed agent notice, not turn content', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_UNSOLICITED_UPDATES: JSON.stringify([
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Skills\n' } },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '- a\n' } },
          ]),
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } } },
          ]),
        },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    // The banner lands before any prompt: one sealed agent-notice message.
    await until(() => frames.some((frame) => frame.events.some((event) =>
      event.type === 'message.updated' && event.properties.info?.role === 'agent-notice')));
    const pre = await service.messages({ key: session.id, limit: 5 });
    expect(pre.items).toHaveLength(1);
    expect(pre.items[0].info.role).toBe('agent-notice');
    expect(pre.items[0].info.text).toBe('## Skills\n- a\n');
    expect(pre.items[0].parts).toEqual([]);
    // The first turn starts clean: the notice stays its own message and the
    // assistant carries only turn output.
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'hi' }] });
    await until(() => frames.some((frame) =>
      frame.events.some((event) => event.type === 'session.idle')));
    const page = await service.messages({ key: session.id, limit: 10 });
    expect(page.items.map((item) => item.info.role)).toEqual(['assistant', 'user', 'agent-notice']);
    expect(page.items[0].parts.map((part) => part.text).join('')).toBe('reply');
  });

  it('D5: delete succeeds with a warning when the agent session is already gone', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_DELETE: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { delete: {} } }),
          FAKE_ACP_DELETE_ERROR: JSON.stringify({ message: 'ACP connection closed' }),
        },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    const outcome = await service.delete({ key: session.id });
    expect(outcome).toEqual({ deleted: true, warning: expect.stringContaining('ACP connection closed') });
    await expect(index.get(session.id)).resolves.toBeNull();
    expect(frames.some((frame) => frame.events.some((event) =>
      event.type === 'session.deleted' && event.properties.sessionID === session.id))).toBe(true);
    // Unknown afterwards: no zombie on list or open.
    expect((await service.list({ directory: 'C:\\work' })).map((row) => row.id)).not.toContain(session.id);
    await expect(service.open({ key: session.id })).rejects.toMatchObject({ code: 'ACP_SESSION_UNKNOWN' });
  });

  it('D5: delete still throws when the agent session may be alive', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_DELETE: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { delete: {} } }),
          FAKE_ACP_DELETE_ERROR: JSON.stringify({ code: -32603, message: 'provider quota exceeded' }),
        },
      },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    // The SDK wraps agent-thrown text as "Internal error" (details in
    // `data.details`); what matters is the delete throws and keeps state.
    await expect(service.delete({ key: session.id })).rejects.toThrow('Internal error');
    await expect(index.get(session.id)).resolves.not.toBeNull();
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

  it('D4: errors (409) when the agent silently keeps the old config value', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([{ id: 'model', name: 'Model', type: 'select', currentValue: 'm1' }]),
          FAKE_ACP_CONFIG_SILENT_KEEP: 'true',
        },
      },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    // The RPC answers success but keeps m1: the caller gets
    // ACP_CONFIG_NOT_APPLIED with the agent's resulting value.
    await expect(service.config({ key: session.id, configId: 'model', value: 'm2' }))
      .rejects.toMatchObject({ code: 'ACP_CONFIG_NOT_APPLIED', message: expect.stringContaining('m1') });
    // Session state follows the agent, not the request: metadata shows m1
    // and the index persists m1 (the rejected m2 must not resurrect).
    const reopened = await service.open({ key: session.id });
    expect(reopened.session.metadata.acp.configOptions.find((o) => o.id === 'model').current).toBe('m1');
    await expect(index.get(session.id)).resolves.toMatchObject({ lastConfig: { model: 'm1' } });
    expect(frames.some((frame) => frame.events.some((event) =>
      event.type === 'session.patched' && event.properties.patch.metadata !== undefined))).toBe(true);
  });

  it('keeps sequential model→effort changes in lastConfig (one-off inherits both)', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([
            { id: 'model', name: 'Model', type: 'select', currentValue: 'm1' },
            { id: 'effort', name: 'Effort', type: 'select', currentValue: 'low' },
          ]),
        },
      },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.config({ key: session.id, configId: 'model', value: 'm2' });
    await service.config({ key: session.id, configId: 'effort', value: 'high' });
    // The second change merges against the live entry, not the creation
    // snapshot: the model must not roll back to m1.
    await expect(index.get(session.id)).resolves.toMatchObject({ lastConfig: { model: 'm2', effort: 'high' } });
  });

  it('snapshots agent-side dependent resets from set_config_option responses', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([
            { id: 'model', name: 'Model', type: 'select', currentValue: 'm1' },
            { id: 'effort', name: 'Effort', type: 'select', currentValue: 'high' },
          ]),
          FAKE_ACP_CONFIG_RESETS: JSON.stringify({ model: { effort: 'default' } }),
        },
      },
    });
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.config({ key: session.id, configId: 'model', value: 'm2' });
    // The response reset effort agent-side: lastConfig carries the reset,
    // not the stale pre-switch value.
    await expect(index.get(session.id)).resolves.toMatchObject({ lastConfig: { model: 'm2', effort: 'default' } });
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

describe('acp session interaction (Phase 1.4)', () => {
  const PERMISSION_STEP = {
    toolCall: {
      toolCallId: 'toolu_perm1',
      name: 'shell',
      title: 'echo hi',
      kind: 'execute',
      status: 'pending',
      locations: [{ path: 'C:/work' }],
      rawInput: { command: 'echo hi' },
    },
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ],
  };

  it('parks request_permission, projects permission.asked, replies selected', async () => {
    const { service, manager } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ permission: PERMISSION_STEP }]) } },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const asked = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'permission.asked'));
    expect(asked.properties).toMatchObject({
      sessionID: session.id,
      action: 'shell',
      resources: expect.arrayContaining(['echo hi']),
    });
    const requestId = asked.properties.id;
    await expect(service.getPermission({ key: session.id, requestId })).resolves.toMatchObject({
      permission: { id: requestId },
    });
    await expect(service.listPendingPermissions({ directory: 'C:\\work' }))
      .resolves.toHaveLength(1);
    await service.replyPermission({ key: session.id, requestId, reply: 'once' });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/PERMISSION:.*"outcome":"selected".*"optionId":"once"/);
    expect(frames.flatMap((frame) => frame.events).some((event) =>
      event.type === 'permission.replied' && event.properties.requestID === requestId)).toBe(true);
    await expect(service.replyPermission({ key: session.id, requestId, reply: 'once' }))
      .rejects.toMatchObject({ code: 'ACP_PERMISSION_UNKNOWN' });
  });

  it('reject maps to reject_once and a cancelled turn is not interrupted (T2)', async () => {
    const { service } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ permission: PERMISSION_STEP }, { stopReason: 'cancelled' }]) } },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const asked = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'permission.asked'));
    await service.replyPermission({ key: session.id, requestId: asked.properties.id, reply: 'reject' });
    const idle = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'session.idle'));
    // T2: the agent reports the decline as `cancelled`; the UI sees a
    // normal finish, not an interruption.
    expect(idle.properties.outcome).toBe('succeeded');
  });

  it('answers parked permissions with cancelled on cancel', async () => {
    const { service, manager } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ permission: PERMISSION_STEP }, { holdForCancel: 5000 }]) } },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'permission.asked'));
    expect(await service.cancel({ key: session.id })).toBe(true);
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/PERMISSION:.*"outcome":"cancelled"/);
    expect(frames.flatMap((frame) => frame.events).some((event) => event.type === 'permission.replied')).toBe(true);
    await expect(service.listPendingPermissions({ directory: 'C:\\work' })).resolves.toHaveLength(0);
  });

  it('projects multi-allow permissions as single-select forms', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{
            permission: {
              toolCall: { toolCallId: 'toolu_choice', title: 'Pick one' },
              options: [
                { optionId: 'a', kind: 'allow_once', name: 'Alpha' },
                { optionId: 'b', kind: 'allow_once', name: 'Beta' },
              ],
            },
          }]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const created = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'form.created'));
    expect(created.properties.form.fields).toHaveLength(1);
    expect(created.properties.form.fields[0].options.map((option) => option.value)).toEqual(['a', 'b']);
    expect(frames.flatMap((frame) => frame.events).some((event) => event.type === 'permission.asked')).toBe(false);
    await service.replyForm({ key: session.id, formId: created.properties.form.id, answer: { choice: 'b' } });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/PERMISSION:.*"outcome":"selected".*"optionId":"b"/);
  });

  it('round-trips elicitation forms: asked, answered, settled', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{
            elicitation: {
              mode: 'form',
              message: 'Questions',
              requestedSchema: {
                type: 'object',
                properties: {
                  q0: { type: 'string', title: 'Color', oneOf: [{ const: 'Red', title: 'Red' }] },
                  ok: { type: 'boolean', title: 'Confirm' },
                },
                required: ['q0'],
              },
            },
          }]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const created = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'form.created'));
    const formId = created.properties.form.id;
    expect(created.properties.form.fields.map((field) => field.key)).toEqual(['q0', 'ok']);
    await expect(service.listPendingForms({ directory: 'C:\\work' })).resolves.toHaveLength(1);
    await service.replyForm({ key: session.id, formId, answer: { q0: 'Red', ok: true } });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/ELICITATION:.*"action":"accept"/);
    expect(tail).toMatch(/"q0":"Red"/);
    expect(frames.flatMap((frame) => frame.events).some((event) =>
      event.type === 'form.settled' && event.properties.formID === formId)).toBe(true);
  });

  it('declines URL elicitations without parking a form', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{
            elicitation: { mode: 'url', elicitationId: 'e1', url: 'https://example.invalid/auth', message: 'Auth' },
          }]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/ELICITATION:.*"action":"decline"/);
    expect(frames.flatMap((frame) => frame.events).some((event) => event.type === 'form.created')).toBe(false);
  });

  it('routes child traffic to a child session with a parent link', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_sub', name: 'subagent', title: 'subagent', kind: 'think', status: 'in_progress', rawInput: { description: 'Do it' } } },
            {
              childUpdate: {
                rootSessionId: 'fake-session-1',
                childSessionId: 'fake-child-1',
                parentSessionId: 'fake-session-1',
                depth: 1,
                title: 'Do it',
                type: 'status',
                status: 'running',
              },
            },
            {
              childUpdate: {
                rootSessionId: 'fake-session-1',
                childSessionId: 'fake-child-1',
                parentSessionId: 'fake-session-1',
                depth: 1,
                title: 'Do it',
                type: 'update',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child text' } },
              },
            },
            {
              childUpdate: {
                rootSessionId: 'fake-session-1',
                childSessionId: 'fake-child-1',
                parentSessionId: 'fake-session-1',
                depth: 1,
                title: 'Do it',
                type: 'status',
                status: 'completed',
              },
            },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const childCreated = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'session.created' && event.properties.info.parentID === session.id));
    const childKey = childCreated.properties.info.id;
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle' && event.properties.sessionID === session.id));
    // The child transcript holds the routed chunk.
    const page = await service.messages({ key: childKey, limit: 10 });
    expect(JSON.stringify(page)).toContain('child text');
    // The index links parent and child.
    await expect(index.get(childKey)).resolves.toMatchObject({ parentKey: session.id });
    // The parent subagent part links to the child key.
    const parentPage = await service.messages({ key: session.id, limit: 10 });
    const subagent = parentPage.items.flatMap((item) => item.parts)
      .find((part) => part.type === 'tool' && part.callID === 'toolu_sub');
    expect(subagent.state.metadata.sessionID).toBe(childKey);
    // Children list under the directory with their parent id.
    const rows = await service.list({ directory: 'C:\\work' });
    expect(rows.find((row) => row.id === childKey)?.parentID).toBe(session.id);
  });

  it('projects standard compaction updates to a compaction message', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' } },
            { update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'summary text' } } },
            { update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' } },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: '/compact' }] });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
    const all = frames.flatMap((frame) => frame.events);
    const running = all.find((event) => event.type === 'message.updated'
      && event.properties.info?.role === 'compaction' && event.properties.info?.status === 'running');
    expect(running).toBeDefined();
    expect(all.some((event) => event.type === 'message.compaction.delta'
      && event.properties.delta === 'summary text')).toBe(true);
    const settled = all.find((event) => event.type === 'message.updated'
      && event.properties.info?.role === 'compaction' && event.properties.info?.status === 'completed');
    expect(settled.properties.info.summary).toBe('summary text');
    expect(settled.properties.info.id).toBe(running.properties.info.id);
  });

  it('projects the _meta compaction fallback to the same message shape', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status: 'started', messageId: 'm1', reason: 'manual' } } } },
            { update: { sessionUpdate: 'session_info_update', _meta: { 'opencode/compaction': { status: 'completed', messageId: 'm1', reason: 'manual' } } } },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: '/compact' }] });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
    const all = frames.flatMap((frame) => frame.events);
    const compactions = all.filter((event) => event.type === 'message.updated'
      && event.properties.info?.role === 'compaction');
    expect(compactions.map((event) => event.properties.info.status)).toEqual(['running', 'completed']);
    expect(compactions[0].properties.info.id).toBe(compactions[1].properties.info.id);
  });

  it('serves cached commands and persists the config cache', async () => {
    const { service, registry } = await setup({
      entry: {
        env: {
          FAKE_ACP_CONFIG_OPTIONS: JSON.stringify([{ id: 'model', name: 'Model', type: 'select', currentValue: 'm1' }]),
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] } },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
    await expect(service.commands({ key: session.id })).resolves.toEqual([{ name: 'compact', description: 'Compact' }]);
    expect(frames.flatMap((frame) => frame.events).some((event) =>
      event.type === 'catalog.updated' && event.properties.kind === 'command')).toBe(true);
    // The session/new seed landed in the registry cache (best-effort write).
    await until(async () => {
      const entries = await registry.list();
      return (entries.find((entry) => entry.id === 'fake')?.cache?.configOptions ?? []).length > 0;
    });
    await expect(service.configCache({ backendId: 'fake' })).resolves.toEqual([
      expect.objectContaining({ id: 'model' }),
    ]);
    await expect(service.configCache({ backendId: 'missing' })).rejects.toMatchObject({ code: 'ACP_BACKEND_UNKNOWN' });
  });
});

describe('acp interaction review regressions', () => {
  const PERMISSION_STEP = {
    toolCall: {
      toolCallId: 'toolu_perm1',
      name: 'shell',
      title: 'echo hi',
      kind: 'execute',
      status: 'pending',
      locations: [{ path: 'C:/work' }],
      rawInput: { command: 'echo hi' },
    },
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ],
  };

  const childStatusStep = (childSessionId, parentSessionId, status) => ({
    childUpdate: {
      rootSessionId: 'fake-session-1',
      childSessionId,
      parentSessionId,
      depth: parentSessionId === 'fake-session-1' ? 1 : 2,
      title: `child ${childSessionId}`,
      type: 'status',
      status,
    },
  });

  const childTextStep = (childSessionId, parentSessionId, text) => ({
    childUpdate: {
      rootSessionId: 'fake-session-1',
      childSessionId,
      parentSessionId,
      depth: parentSessionId === 'fake-session-1' ? 1 : 2,
      title: `child ${childSessionId}`,
      type: 'update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });

  it('rejects invalid form answers with 400 and retains the form', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{
            elicitation: {
              mode: 'form',
              message: 'Q',
              requestedSchema: {
                type: 'object',
                properties: {
                  color: { type: 'string', enum: ['red'] },
                  n: { type: 'integer', minimum: 1 },
                },
                required: ['color', 'n'],
              },
            },
          }]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const created = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'form.created'));
    const formId = created.properties.form.id;
    await expect(service.replyForm({ key: session.id, formId, answer: { color: 'blue', n: 0.8 } }))
      .rejects.toMatchObject({ code: 'ACP_INVALID_REQUEST' });
    // Retained for correction: the pending list still shows it, no settle.
    await expect(service.listPendingForms({ directory: 'C:\\work' })).resolves.toHaveLength(1);
    expect(frames.flatMap((frame) => frame.events).some((event) => event.type === 'form.settled')).toBe(false);
    await service.replyForm({ key: session.id, formId, answer: { color: 'red', n: 2 } });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
  });

  it('marks declinedInTurn when a choice form selects a reject option (T2)', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            {
              permission: {
                toolCall: { toolCallId: 'toolu_choice', title: 'Pick' },
                options: [
                  { optionId: 'yes', kind: 'allow_once', name: 'Yes' },
                  { optionId: 'maybe', kind: 'allow_once', name: 'Maybe' },
                  { optionId: 'no', kind: 'reject_once', name: 'No' },
                ],
              },
            },
            { stopReason: 'cancelled' },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const created = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'form.created'));
    await service.replyForm({ key: session.id, formId: created.properties.form.id, answer: { choice: 'no' } });
    const idle = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'session.idle'));
    expect(idle.properties.outcome).toBe('succeeded');
  });

  it('settles parked requests when a child is deleted', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            childStatusStep('fake-child-1', 'fake-session-1', 'running'),
            { permission: { ...PERMISSION_STEP, sessionId: 'fake-child-1' } },
            { holdForCancel: 5000 },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const childCreated = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'session.created' && event.properties.info.parentID === session.id));
    const childKey = childCreated.properties.info.id;
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'permission.asked' && event.properties.sessionID === childKey));
    await service.delete({ key: childKey });
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/PERMISSION:.*"outcome":"cancelled"/);
    expect(frames.flatMap((frame) => frame.events).some((event) =>
      event.type === 'permission.replied' && event.properties.sessionID === childKey)).toBe(true);
    await service.cancel({ key: session.id });
  });

  it('cascades parent cancel and turn end to descendant parked requests', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            childStatusStep('fake-child-1', 'fake-session-1', 'running'),
            childStatusStep('fake-grand-1', 'fake-child-1', 'running'),
            { permission: { ...PERMISSION_STEP, sessionId: 'fake-child-1' } },
            { holdForCancel: 5000 },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'permission.asked'));
    // The prompt script blocks on the parked permission, so the grandchild
    // elicitation parks through the bound hooks directly (same path the
    // connection serves agent requests on).
    const hooks = service.hooksForBackend('fake', service.getLive(session.id).generation);
    const elicitation = hooks.onElicitation({
      sessionId: 'fake-grand-1',
      mode: 'form',
      message: 'GQ',
      requestedSchema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    expect(elicitation).toBeInstanceOf(Promise);
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'form.created'));
    expect(await service.cancel({ key: session.id })).toBe(true);
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/PERMISSION:.*"outcome":"cancelled"/);
    await expect(elicitation).resolves.toEqual({ action: 'cancel' });
    await expect(service.listPendingPermissions({ directory: 'C:\\work' })).resolves.toHaveLength(0);
    await expect(service.listPendingForms({ directory: 'C:\\work' })).resolves.toHaveLength(0);
  });

  it('sweeps descendant parked requests when the parent turn ends', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            childStatusStep('fake-child-1', 'fake-session-1', 'running'),
            // Park on the child, then finish WITHOUT answering: the turn-end
            // sweep settles it. The fake holds the permission resolver until
            // the prompt ends — emulate by ending the script right after.
            { permission: { ...PERMISSION_STEP, sessionId: 'fake-child-1' } },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    // Answer the child permission from the test as soon as it parks, then
    // verify nothing lingers after idle (the sweep is the backstop).
    const answerer = (async () => {
      const asked = await until(() => frames.flatMap((frame) => frame.events)
        .find((event) => event.type === 'permission.asked'));
      await service.replyPermission({ key: asked.properties.sessionID, requestId: asked.properties.id, reply: 'once' });
    })();
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    await answerer;
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle'));
    await expect(service.listPendingPermissions({ directory: 'C:\\work' })).resolves.toHaveLength(0);
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/PERMISSION:.*"outcome":"selected"/);
    void manager;
  });

  it('adopts descendants to the new generation on parent reconnect', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            childStatusStep('fake-child-1', 'fake-session-1', 'running'),
            childTextStep('fake-child-1', 'fake-session-1', 'original'),
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const childCreated = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'session.created' && event.properties.info.parentID === session.id));
    const childKey = childCreated.properties.info.id;
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle' && event.properties.sessionID === session.id));
    const staleGeneration = service.getLive(session.id).generation;
    await manager.restart('fake');
    await service.open({ key: session.id });
    const parent = service.getLive(session.id);
    expect(parent.generation).not.toBe(staleGeneration);
    // The child adopted the new generation: bound traffic routes again.
    const child = service.getLive(childKey);
    expect(child.generation).toBe(parent.generation);
    const hooks = service.hooksForBackend('fake', parent.generation);
    const asked = hooks.onRequestPermission({
      sessionId: 'fake-child-1',
      toolCall: { toolCallId: 'toolu_new', name: 'shell', title: 't', kind: 'execute', rawInput: {} },
      options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow' }],
    });
    expect(asked).toBeInstanceOf(Promise);
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'permission.asked' && event.properties.sessionID === childKey));
    await service.delete({ key: childKey });
    await asked;
  });

  it('rebuilds child transcripts alongside the parent and rolls back on failure', async () => {
    const replay = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'replayed' },
        _meta: { 'opencode/child-session': { id: 'fake-child-1', parentID: 'fake-session-1', depth: 1, title: 'c1' } },
      },
    ];
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_LOAD_REPLAY: JSON.stringify(replay),
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            childStatusStep('fake-child-1', 'fake-session-1', 'running'),
            childTextStep('fake-child-1', 'fake-session-1', 'original'),
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const childCreated = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'session.created' && event.properties.info.parentID === session.id));
    const childKey = childCreated.properties.info.id;
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle' && event.properties.sessionID === session.id));
    await manager.restart('fake');
    await service.open({ key: session.id });
    // Replacement, not append: 'original' is gone, 'replayed' is canonical.
    const page = await service.messages({ key: childKey, limit: 10 });
    expect(JSON.stringify(page)).toContain('replayed');
    expect(JSON.stringify(page)).not.toContain('original');
    expect(page.items).toHaveLength(1);
  });

  it('rolls child transcripts back when the parent load fails', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_LOAD_ERROR: JSON.stringify({ code: -32603, message: 'load failed' }),
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            childStatusStep('fake-child-1', 'fake-session-1', 'running'),
            childTextStep('fake-child-1', 'fake-session-1', 'original'),
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    const childCreated = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'session.created' && event.properties.info.parentID === session.id));
    const childKey = childCreated.properties.info.id;
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle' && event.properties.sessionID === session.id));
    await manager.restart('fake');
    await expect(service.open({ key: session.id })).rejects.toMatchObject({ code: -32603 });
    // The child keeps its pre-rebuild transcript.
    const page = await service.messages({ key: childKey, limit: 10 });
    expect(JSON.stringify(page)).toContain('original');
  });
});

describe('acp transitive cancellation (review round 2)', () => {
  const childPermission = (sessionId) => ({
    sessionId,
    toolCall: {
      toolCallId: `toolu_late_${sessionId}`,
      name: 'shell',
      title: 'late',
      kind: 'execute',
      rawInput: { command: 'late' },
    },
    options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }],
  });

  const childStatusStep = (childSessionId, parentSessionId) => ({
    childUpdate: {
      rootSessionId: 'fake-session-1',
      childSessionId,
      parentSessionId,
      depth: 1,
      title: `child ${childSessionId}`,
      type: 'status',
      status: 'running',
    },
  });

  it('answers a late child request immediately when the parent turn was cancelled', async () => {
    const { service, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            childStatusStep('fake-child-1', 'fake-session-1'),
            { awaitCancelThenPermission: { timeoutMs: 8000, permission: childPermission('fake-child-1') } },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.created' && event.properties.info.parentID === session.id));
    // The backend sends the child permission only after it observes our
    // cancel, and gates its cancelled prompt on the answer. Without
    // transitive cancellation the client parks it and this cancel hangs
    // behind a user reply that can never come — fail fast instead.
    const cancelled = await Promise.race([
      service.cancel({ key: session.id }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancel hung on a parked late request')), 15000)),
    ]);
    expect(cancelled).toBe(true);
    const tail = (await manager.status('fake')).stderrTail;
    expect(tail).toMatch(/PERMISSION:.*"outcome":"cancelled"/);
    // Never parked, never shown: no card for an already-cancelled turn.
    expect(frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'permission.asked')).toBe(false);
    const idle = await until(() => frames.flatMap((frame) => frame.events)
      .find((event) => event.type === 'session.idle' && event.properties.sessionID === session.id));
    expect(idle.properties.outcome).toBe('interrupted');
  });

  it('parks child requests again once the next parent turn starts', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
            childStatusStep('fake-child-1', 'fake-session-1'),
            { awaitCancelThenPermission: { timeoutMs: 1500, permission: childPermission('fake-child-1') } },
          ]),
        },
      },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
    // Turn 1: cancel first so the late child request is answered cancelled.
    await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'go' }] });
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.created' && event.properties.info.parentID === session.id));
    expect(await service.cancel({ key: session.id })).toBe(true);
    await until(() => frames.flatMap((frame) => frame.events)
      .some((event) => event.type === 'session.idle' && event.properties.sessionID === session.id));
    // Turn 2 (no cancel): the script's permission step times out waiting,
    // sends anyway, and the client must PARK it — the new turn cleared the
    // ancestor's cancelled state.
    const askedBefore = frames.flatMap((frame) => frame.events)
      .filter((event) => event.type === 'permission.asked').length;
    await service.prompt({ key: session.id, messageId: 'msg_2', parts: [{ type: 'text', text: 'again' }] });
    const asked = await until(() => frames.flatMap((frame) => frame.events)
      .filter((event) => event.type === 'permission.asked').slice(askedBefore)[0]);
    await service.replyPermission({ key: asked.properties.sessionID, requestId: asked.properties.id, reply: 'once' });
    await until(() => frames.flatMap((frame) => frame.events)
      .filter((event) => event.type === 'session.idle' && event.properties.sessionID === session.id).length >= 2);
  });
});
