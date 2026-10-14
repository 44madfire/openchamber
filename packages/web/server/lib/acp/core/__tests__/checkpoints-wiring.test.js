import { execFileSync, execSync } from 'node:child_process';
import fsp, { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcpBackendManager } from '../backend-manager.js';
import { createCheckpointStore, shadowDirFor } from '../checkpoints.js';
import { createSessionProjector } from '../projector.js';
import { createAcpBackendRegistry } from '../registry.js';
import { createAcpSessionIndex } from '../session-index.js';
import { CHECKPOINT_START_BUDGET_MS, createAcpSessionService } from '../sessions.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

const tempDir = (prefix) => mkdtemp(join(tmpdir(), prefix));

const managers = [];
const services = [];

afterEach(async () => {
  while (services.length > 0) services.pop().dispose();
  while (managers.length > 0) await managers.pop().shutdown();
});

const fakeEntry = (overrides = {}) => ({
  id: 'fake',
  label: 'fake',
  command: process.execPath,
  args: [FAKE_AGENT],
  enabled: true,
  ...overrides,
});

const setup = async ({ entry = {}, serviceOptions = {}, indexDir = null } = {}) => {
  const registry = createAcpBackendRegistry({ dataDir: await tempDir('acp-cpw-reg-'), resolveCommand: () => null });
  await registry.save([fakeEntry(entry)]);
  const { spawnAcpAgent } = await import('../spawn.js');
  const spawnAgent = (options) =>
    spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} });
  const holder = { current: null };
  const manager = createAcpBackendManager({
    registry,
    spawnAgent,
    stderrFlushMs: 10,
    connectionHooks: (backendId, generation) => holder.current?.hooksForBackend(backendId, generation) ?? {},
  });
  managers.push(manager);
  const dataDir = await tempDir('acp-cpw-data-');
  const index = createAcpSessionIndex({ dataDir: indexDir ?? dataDir });
  const home = await tempDir('acp-cpw-home-');
  await fsp.mkdir(join(home, '.config', 'git'), { recursive: true });
  await fsp.writeFile(join(home, 'global-gitconfig'), '');
  const isolatedEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, 'global-gitconfig'),
    GIT_CONFIG_SYSTEM: join(home, 'system-gitconfig'),
  };
  const checkpoints = createCheckpointStore({ dataDir, environment: isolatedEnv });
  const service = createAcpSessionService({
    manager, index, registry, checkpoints, settleMs: 5, watchdogMs: 500, ...serviceOptions,
  });
  holder.current = service;
  services.push(service);
  return { service, manager, index, registry, checkpoints, dataDir, isolatedEnv };
};

const syncEvents = (service) => {
  const frames = [];
  service.events.on('sync', (frame) => frames.push(frame));
  return frames;
};

const until = async (predicate, { timeout = 15_000 } = {}) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const untilIdle = (frames) => until(() => frames.some((frame) =>
  frame.events.some((event) => event.type === 'session.idle')));

const makeRepo = async (root, name, env) => {
  const cwd = join(root, name);
  await fsp.mkdir(cwd, { recursive: true });
  execFileSync('git', ['init', '--quiet', '.'], { cwd, env, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'cpw@example.invalid'], { cwd, env, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Cpw'], { cwd, env, windowsHide: true });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd, env, windowsHide: true });
  return cwd;
};

const headOf = (cwd, env) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, env, encoding: 'utf8', windowsHide: true }).trim();
const statusOf = (cwd, env) => execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=no'], { cwd, env, encoding: 'utf8', windowsHide: true });

describe('acp checkpoint wiring', () => {
  it('records start/end per turn in git and plain dirs', async () => {
    const { service, index, isolatedEnv } = await setup();
    const frames = syncEvents(service);
    const root = await tempDir('acp-cpw-proj-');
    const repo = await makeRepo(root, 'repo', isolatedEnv);
    await fsp.writeFile(join(repo, 'a.txt'), 'one\n');
    const plain = join(root, 'plain');
    await fsp.mkdir(plain, { recursive: true });
    await fsp.writeFile(join(plain, 'b.txt'), 'bee\n');

    for (const cwd of [repo, plain]) {
      const { session } = await service.create({ backendId: 'fake', directory: cwd });
      await service.prompt({ key: session.id, messageId: `msg-${cwd.length}-1`, parts: [{ type: 'text', text: 'hi' }] });
      await untilIdle(frames);
      frames.length = 0;
      const entry = await index.get(session.id);
      expect(entry.checkpoints).toHaveLength(1);
      expect(entry.checkpoints[0]).toMatchObject({ turn: 1, complete: true });
      expect(entry.checkpoints[0].start).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.checkpoints[0].end).toMatch(/^[0-9a-f]{40}$/);
      expect(await service.checkpoints({ key: session.id })).toEqual([{ turn: 1, complete: true }]);
    }
  });

  it('numbers turns canonically across a rebuild', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_LOAD_REPLAY: JSON.stringify([
            { sessionUpdate: 'user_message_chunk', messageId: 'u-1', content: { type: 'text', text: 'first' } },
            { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'answer' } },
            { sessionUpdate: 'user_message_chunk', messageId: 'u-2', content: { type: 'text', text: 'second' } },
            { sessionUpdate: 'agent_message_chunk', messageId: 'm-2', content: { type: 'text', text: 'answer 2' } },
          ]),
        },
      },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-rebuild-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'x\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    // Rebuild via load: the replay carries two historical turns, so the
    // next live prompt is turn 3 — and a second rebuild numbers it the same.
    service.dispose();
    services.splice(services.indexOf(service), 1);
    const reopened = await service.open({ key: session.id });
    expect(reopened.session.id).toBe(session.id);
    await service.prompt({ key: session.id, messageId: 'msg-live', parts: [{ type: 'text', text: 'live' }] });
    await untilIdle(frames);
    const projector = service.getLive(session.id).projector;
    expect(projector.turnNumberOf('msg-live')).toBe(3);
    const entry = await index.get(session.id);
    expect(entry.checkpoints.map((row) => row.turn)).toEqual([3]);
  });

  it('replay ordinals survive a rebuild: same stream, same numbers', () => {
    const a = createSessionProjector({ key: 'ses_acp-fake_r1', backendId: 'fake', directory: 'C:\\w' });
    const b = createSessionProjector({ key: 'ses_acp-fake_r1', backendId: 'fake', directory: 'C:\\w' });
    for (const projector of [a, b]) {
      projector.beginReplay();
      projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'u1' } } }, { replay: true });
      projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'r1' } } }, { replay: true });
      projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'u2' } } }, { replay: true });
      projector.endReplay();
    }
    const idsA = a.transcriptIds();
    const idsB = b.transcriptIds();
    expect(idsA).toEqual(idsB);
    expect(a.turnNumberOf(idsA[0])).toBe(1);
    expect(a.turnNumberOf(idsA[2])).toBe(2);
    expect(a.turnNumberOf(idsA[1])).toBeNull();
  });

  it('marks the turn incomplete when the start snapshot misses its budget', async () => {
    const hanging = { snapshot: () => new Promise(() => {}), diff: async () => [], restore: async () => ({}), gc: async () => ({ deletedRefs: 0 }) };
    const { service } = await setup({ serviceOptions: { checkpoints: hanging, checkpointStartBudgetMs: 50 } });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-budget-');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    const started = Date.now();
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'hi' }] });
    // The prompt went out despite the hanging snapshot: well under the hang.
    expect(Date.now() - started).toBeLessThan(5000);
    await untilIdle(frames);
    expect(await service.checkpoints({ key: session.id })).toEqual([{ turn: 1, complete: false }]);
    await expect(service.diff({ key: session.id, turn: 1 })).rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INCOMPLETE' });
    await expect(service.revert({ key: session.id, turn: 1 })).rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INCOMPLETE' });
  });

  it('budgets the default at 1.5 s', () => {
    expect(CHECKPOINT_START_BUDGET_MS).toBe(1500);
  });

  it('retries ACP_CHECKPOINT_BUSY once, then marks incomplete', async () => {
    let calls = 0;
    const flaky = {
      snapshot: async ({ phase }) => {
        calls += 1;
        // Every `start` attempt is busy (the warm probe included); the
        // prompt's start retries once, then the turn goes incomplete.
        if (phase === 'start') {
          throw Object.assign(new Error('busy'), { code: 'ACP_CHECKPOINT_BUSY' });
        }
        return { tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' };
      },
      diff: async () => [],
      restore: async () => ({ restored: [], removed: [], skipped: [] }),
      gc: async () => ({ deletedRefs: 0 }),
    };
    const { service } = await setup({ serviceOptions: { checkpoints: flaky } });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-busy-');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    const callsBeforePrompt = calls;
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'hi' }] });
    await untilIdle(frames);
    // Start attempted, busy, retried once, busy again → incomplete — but
    // the end snapshot is still captured (call 3) as a session-owned end
    // tree for later reverts. (The create-time warm probe may add calls;
    // only the prompt delta matters.)
    expect(calls - callsBeforePrompt).toBe(3);
    expect(await service.checkpoints({ key: session.id })).toEqual([{ turn: 1, complete: false }]);
  });

  it('still settles the end snapshot after cancel and after error', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ holdForCancel: 10_000 }]),
        },
      },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-cancel-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'slow' }] });
    await until(() => frames.some((frame) => frame.events.some((event) => event.type === 'session.status')));
    expect(await service.cancel({ key: session.id })).toBe(true);
    await untilIdle(frames);
    const entry = await index.get(session.id);
    expect(entry.checkpoints).toHaveLength(1);
    expect(entry.checkpoints[0]).toMatchObject({ turn: 1, complete: true });
    expect(entry.checkpoints[0].end).toMatch(/^[0-9a-f]{40}$/);

    const failing = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ error: { code: -32000, message: 'boom' } }]) } },
    });
    const failingFrames = syncEvents(failing.service);
    const cwd2 = await tempDir('acp-cpw-error-');
    await fsp.writeFile(join(cwd2, 'f.txt'), 'v1\n');
    const created = await failing.service.create({ backendId: 'fake', directory: cwd2 });
    await failing.service.prompt({ key: created.session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'x' }] });
    await until(() => failingFrames.some((frame) => frame.events.some((event) => event.type === 'session.idle')));
    const entry2 = await failing.index.get(created.session.id);
    expect(entry2.checkpoints[0]).toMatchObject({ turn: 1, complete: true });
  });

  it('diffs one turn in the FileDiffInfo shape', async () => {
    const { service } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 400 }]) } },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-diff-');
    await fsp.writeFile(join(cwd, 'note.txt'), 'line-1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'first' }] });
    await untilIdle(frames);
    frames.length = 0;
    // The agent edits DURING the turn (out-of-band from the service's
    // view, exactly like a real agent editing via its own tools): after
    // the start snapshot, before the slow prompt resolves.
    const second = service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'second' }] });
    await until(() => frames.some((frame) => frame.events.some((event) => event.type === 'session.status')));
    await fsp.writeFile(join(cwd, 'note.txt'), 'line-1\nline-2\n');
    await fsp.writeFile(join(cwd, 'new.txt'), 'fresh\n');
    await second;
    await untilIdle(frames);
    const diff = await service.diff({ key: session.id, turn: 2 });
    expect(diff.map((row) => row.file).sort()).toEqual(['new.txt', 'note.txt']);
    const note = diff.find((row) => row.file === 'note.txt');
    expect(note).toMatchObject({ additions: 1, deletions: 0, status: 'modified' });
    expect(note.patch).toContain('+line-2');
    const added = diff.find((row) => row.file === 'new.txt');
    expect(added).toMatchObject({ additions: 1, deletions: 0, status: 'added' });
    await expect(service.diff({ key: session.id, turn: 9 })).rejects.toMatchObject({ code: 'ACP_CHECKPOINT_UNKNOWN' });
  });

  it('reverts without fork: restores files, marks the boundary, notes the next prompt', async () => {
    const { service, index, manager } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_RECORD: '1', FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 400 }]) } },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-revert-');
    await fsp.writeFile(join(cwd, 'keep.txt'), 'keep\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    // Turn 2's agent edits (during the turn: after start, before end).
    const second = service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'two' }] });
    await until(() => frames.some((frame) => frame.events.some((event) => event.type === 'session.status')));
    await fsp.writeFile(join(cwd, 'keep.txt'), 'keep-changed\n');
    await fsp.writeFile(join(cwd, 'added.txt'), 'added\n');
    await second;
    await untilIdle(frames);
    frames.length = 0;

    const result = await service.revert({ key: session.id, turn: 2 });
    expect(result.restored.sort()).toEqual(['keep.txt']);
    expect(result.removed.sort()).toEqual(['added.txt']);
    expect(result.session.id).toBe(session.id);
    expect(await fsp.readFile(join(cwd, 'keep.txt'), 'utf8')).toBe('keep\n');
    await expect(fsp.stat(join(cwd, 'added.txt'))).rejects.toThrow();
    const entry = await index.get(session.id);
    expect(entry.revertedFromTurn).toBe(2);

    const patchEvents = frames.flatMap((frame) => frame.events).filter((event) => event.type === 'session.patched');
    expect(patchEvents).toHaveLength(1);
    expect(patchEvents[0].properties.patch.metadata.acp.revertedFromTurn).toBe(2);
    expect(patchEvents[0].properties.patch.revert).toEqual({ messageID: 'msg-2' });

    // The next prompt carries the note; the agent sees it first.
    await service.prompt({ key: session.id, messageId: 'msg-3', parts: [{ type: 'text', text: 'three' }] });
    await untilIdle(frames);
    const stderr = (await manager.status('fake')).stderrTail;
    const prompts = stderr.split('\n').filter((line) => line.startsWith('PROMPT:')).map((line) => JSON.parse(line.slice('PROMPT:'.length)));
    const last = prompts.at(-1);
    expect(last.prompt[0].text.startsWith('[Note: files were reverted to the state before turn 2; turns 2+ were undone]')).toBe(true);
    void index;
  });

  it('reverts via fork: restores files and returns the new session', async () => {
    const { service, index } = await setup({
      entry: {
        env: {
          FAKE_ACP_FORK: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { fork: {} } }),
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 400 }]),
        },
      },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-fork-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    const second = service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'two' }] });
    await until(() => frames.some((frame) => frame.events.some((event) => event.type === 'session.status')));
    await fsp.writeFile(join(cwd, 'f.txt'), 'v2\n');
    await second;
    await untilIdle(frames);
    frames.length = 0;

    const result = await service.revert({ key: session.id, turn: 2 });
    expect(result.restored).toEqual(['f.txt']);
    expect(result.session.id).not.toBe(session.id);
    expect(result.session.id).toMatch(/^ses_acp-fake_r/);
    expect(await fsp.readFile(join(cwd, 'f.txt'), 'utf8')).toBe('v1\n');
    // The source keeps its transcript rows and marks the boundary.
    const source = await index.get(session.id);
    expect(source.revertedFromTurn).toBe(2);
    expect(source.checkpoints).toHaveLength(2);
    const types = frames.flatMap((frame) => frame.events.map((event) => event.type));
    expect(types).toContain('session.patched');
    expect(types).toContain('session.created');
    // The fork is live and promptable.
    await service.prompt({ key: result.session.id, messageId: 'msg-f1', parts: [{ type: 'text', text: 'fork turn' }] });
    await untilIdle(frames);
  });

  it('refuses revert while busy', async () => {
    const { service } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ holdForCancel: 10_000 }]) } },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-busyrevert-');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'slow' }] });
    await until(() => frames.some((frame) => frame.events.some((event) => event.type === 'session.status')));
    await expect(service.revert({ key: session.id, turn: 1 })).rejects.toMatchObject({ code: 'ACP_SESSION_BUSY' });
    await service.cancel({ key: session.id });
    await untilIdle(frames);
  });

  it('forks explicitly only when advertised', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_FORK: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { fork: {} } }),
        },
      },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-explicitfork-');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    const { session: forked } = await service.fork({ key: session.id });
    expect(forked.id).not.toBe(session.id);
    const types = frames.flatMap((frame) => frame.events.map((event) => event.type));
    expect(types).toContain('session.forked');
    expect(types).toContain('session.created');

    const plain = await setup();
    const created = await plain.service.create({ backendId: 'fake', directory: await tempDir('acp-cpw-nofork-') });
    await expect(plain.service.fork({ key: created.session.id })).rejects.toMatchObject({ code: 'ACP_FORK_UNSUPPORTED' });
  });

  it('leaves the user repo index, HEAD and hooks untouched, and GCs refs on delete', async () => {
    const { service, isolatedEnv, dataDir } = await setup();
    const frames = syncEvents(service);
    const root = await tempDir('acp-cpw-untouched-');
    const repo = await makeRepo(root, 'repo', isolatedEnv);
    await fsp.writeFile(join(repo, 'tracked.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: repo, env: isolatedEnv, windowsHide: true });
    execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: repo, env: isolatedEnv, windowsHide: true });
    const headBefore = headOf(repo, isolatedEnv);
    const statusBefore = statusOf(repo, isolatedEnv);
    const hooksBefore = await fsp.readdir(join(repo, '.git', 'hooks'));

    const { session } = await service.create({ backendId: 'fake', directory: repo });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    await fsp.writeFile(join(repo, 'tracked.txt'), 'b\n');
    await service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'two' }] });
    await untilIdle(frames);
    await service.revert({ key: session.id, turn: 1 });
    // Turn 1's start captured `a` (matching HEAD); the revert restores
    // exactly that while the user repo's own index/HEAD/hooks stay as
    // they were.
    expect(await fsp.readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('a\n');

    expect(headOf(repo, isolatedEnv)).toBe(headBefore);
    expect(statusOf(repo, isolatedEnv)).toBe(statusBefore);
    expect(await fsp.readdir(join(repo, '.git', 'hooks'))).toEqual(hooksBefore);

    const shadow = shadowDirFor(dataDir, repo);
    const refsBefore = execSync(`git --git-dir="${shadow}" for-each-ref --format="%(refname)" refs/oc/`, { encoding: 'utf8', windowsHide: true });
    expect(refsBefore).toContain(session.id);
    await service.delete({ key: session.id });
    const refsAfter = execSync(`git --git-dir="${shadow}" for-each-ref --format="%(refname)" refs/oc/`, { encoding: 'utf8', windowsHide: true });
    expect(refsAfter).not.toContain(session.id);
  });
});

describe('acp checkpoint review findings', () => {
  it('revert uses the session-owned end tree when the latest turn is incomplete', async () => {
    const { service, index } = await setup();
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-owned-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    // A second session in the same project snapshots unrelated files —
    // its trees must never become this session's deletion base.
    const other = await service.create({ backendId: 'fake', directory: cwd });
    await fsp.writeFile(join(cwd, 'other.txt'), 'other\n');
    await service.prompt({ key: other.session.id, messageId: 'msg-o1', parts: [{ type: 'text', text: 'other turn' }] });
    await untilIdle(frames);
    frames.length = 0;
    // Incomplete latest turn on the first session (start row forced
    // incomplete, end retained): revert to turn 1 still works, with the
    // session's own end tree as the deletion base.
    const entry = await index.get(session.id);
    const incomplete = {
      turn: 2,
      start: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      end: entry.checkpoints[0].end,
      complete: false,
    };
    await index.upsert(session.id, { checkpoints: [...entry.checkpoints, incomplete] });
    service.getLive(session.id).entry = await index.get(session.id);
    const result = await service.revert({ key: session.id, turn: 1 });
    // other.txt is not a member of the session-owned current tree: kept.
    expect(await fsp.readFile(join(cwd, 'other.txt'), 'utf8')).toBe('other\n');
    expect(result.session.id).toBe(session.id);
  });

  it('rejects revert when no session-owned end tree exists', async () => {
    const hanging = {
      snapshot: () => new Promise(() => {}),
      diff: async () => [],
      restore: async () => { throw new Error('must not restore'); },
      gc: async () => ({ deletedRefs: 0 }),
    };
    const { service } = await setup({ serviceOptions: { checkpoints: hanging, checkpointStartBudgetMs: 30 } });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-noend-');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'hi' }] });
    await untilIdle(frames);
    await expect(service.revert({ key: session.id, turn: 1 })).rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INCOMPLETE' });
  });

  it('holds the mutation lock: prompt and delete refuse during restore', async () => {
    let releaseRestore;
    const gate = new Promise((resolve) => { releaseRestore = resolve; });
    const real = await setup();
    const { service } = real;
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-lock-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    // Swap the store's restore behind the service with a gated one.
    const store = real.checkpoints;
    const originalRestore = store.restore;
    store.restore = async (...args) => { await gate; return originalRestore(...args); };
    try {
      const reverting = service.revert({ key: session.id, turn: 1 });
      await until(() => service.getLive(session.id)?.mutating, { timeout: 5000 });
      await expect(service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'x' }] }))
        .rejects.toMatchObject({ code: 'ACP_SESSION_BUSY' });
      await expect(service.delete({ key: session.id })).rejects.toMatchObject({ code: 'ACP_SESSION_BUSY' });
      releaseRestore();
      const result = await reverting;
      expect(result.session.id).toBe(session.id);
    } finally {
      store.restore = originalRestore;
    }
  });

  it('fork rebuilds via load: inherited turns number canonically', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_FORK: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { fork: {} } }),
          FAKE_ACP_LOAD_REPLAY: JSON.stringify([
            { sessionUpdate: 'user_message_chunk', messageId: 'u-1', content: { type: 'text', text: 'first' } },
            { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'answer' } },
          ]),
        },
      },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-forkload-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    const { session: forked } = await service.fork({ key: session.id });
    // The fork rebuilt via its own load (the single replayed turn): the
    // next live prompt is turn 2, not turn 1.
    const projector = service.getLive(forked.id).projector;
    expect(projector.transcriptIds().length).toBeGreaterThan(1);
    await service.prompt({ key: forked.id, messageId: 'msg-f1', parts: [{ type: 'text', text: 'fork turn' }] });
    await untilIdle(frames);
    expect(service.getLive(forked.id).projector.turnNumberOf('msg-f1')).toBe(2);
  });

  it('fork-path revert arms the note exactly once on the fork', async () => {
    const { service, index, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_FORK: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { fork: {} } }),
          FAKE_ACP_PROMPT_RECORD: '1',
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 200 }]),
        },
      },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-forknote-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    const result = await service.revert({ key: session.id, turn: 1 });
    const forkKey = result.session.id;
    expect(forkKey).not.toBe(session.id);
    expect((await index.get(forkKey)).pendingRevertNote).toMatch(/reverted to the state before turn 1/);
    await service.prompt({ key: forkKey, messageId: 'msg-f1', parts: [{ type: 'text', text: 'after' }] });
    await untilIdle(frames);
    await service.prompt({ key: forkKey, messageId: 'msg-f2', parts: [{ type: 'text', text: 'again' }] });
    await untilIdle(frames);
    const stderr = (await manager.status('fake')).stderrTail;
    const notes = stderr.split('\n').filter((line) => line.includes('[Note: files were reverted'));
    expect(notes).toHaveLength(1);
    expect(await index.get(forkKey).then((e) => e.pendingRevertNote)).toBeUndefined();
  });

  it('GET serves the boundary from the projection; reopen restores it and the note', async () => {
    // The reopened transcript replays two historical turns, so the
    // persisted turn-2 boundary re-canonicalizes onto the replayed ids.
    const replay = {
      entry: {
        env: {
          FAKE_ACP_LOAD_REPLAY: JSON.stringify([
            { sessionUpdate: 'user_message_chunk', messageId: 'u-1', content: { type: 'text', text: 'first' } },
            { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'answer' } },
            { sessionUpdate: 'user_message_chunk', messageId: 'u-2', content: { type: 'text', text: 'second' } },
            { sessionUpdate: 'agent_message_chunk', messageId: 'm-2', content: { type: 'text', text: 'answer 2' } },
          ]),
        },
      },
    };
    const indexDir = await tempDir('acp-cpw-persist-idx-');
    const first = await setup({ indexDir });
    const frames = syncEvents(first.service);
    const cwd = await tempDir('acp-cpw-persist-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await first.service.create({ backendId: 'fake', directory: cwd });
    await first.service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    await first.service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'two' }] });
    await untilIdle(frames);
    await first.service.revert({ key: session.id, turn: 2 });
    // GET-after-revert serves the boundary from the projection.
    const got = await first.service.open({ key: session.id });
    expect(got.session.revert).toEqual({ messageID: 'msg-2' });
    expect(got.session.metadata.acp.revertedFromTurn).toBe(2);
    // Drop the live record (eviction/restart): reopen restores both.
    first.service.dispose();
    services.splice(services.indexOf(first.service), 1);
    const second = await setup({ indexDir, ...replay });
    const reopened = await second.service.open({ key: session.id });
    expect(reopened.session.revert?.messageID).toBeTruthy();
    expect(reopened.session.metadata.acp.revertedFromTurn).toBe(2);
    expect((await second.index.get(session.id)).pendingRevertNote).toMatch(/reverted to the state before turn 2/);
  });

  it('cancel during the start snapshot abandons the dispatch as interrupted', async () => {
    let releaseSnapshot;
    const gate = new Promise((resolve) => { releaseSnapshot = resolve; });
    const gated = {
      snapshot: async (args) => {
        if (args.phase === 'start' && args.turn === 1) await gate;
        return { tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' };
      },
      diff: async () => [],
      restore: async () => ({ restored: [], removed: [], skipped: [] }),
      gc: async () => ({ deletedRefs: 0 }),
    };
    const { service, manager } = await setup({
      entry: { env: { FAKE_ACP_PROMPT_RECORD: '1' } },
      serviceOptions: { checkpoints: gated },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-predispatch-');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    const prompting = service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'hi' }] });
    await until(() => service.getLive(session.id)?.turn?.dispatching === true, { timeout: 5000 });
    expect(await service.cancel({ key: session.id })).toBe(true);
    releaseSnapshot();
    await prompting;
    await untilIdle(frames);
    const idle = frames.flatMap((frame) => frame.events).find((event) => event.type === 'session.idle');
    expect(idle.properties.outcome).toBe('interrupted');
    // Nothing was dispatched to the agent.
    const stderr = (await manager.status('fake')).stderrTail;
    expect(stderr).not.toContain('PROMPT:');
  });

  it('backend crash settles the end snapshot for the dead turn', async () => {
    const { service, index, manager } = await setup({
      entry: { env: { FAKE_ACP_CRASH_ON: '2500', FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ sleepMs: 10_000 }]) } },
      serviceOptions: { watchdogMs: 30_000 },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-crash-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    // The backend dies mid-turn; crash teardown applies the exit error.
    await until(() => frames.some((frame) => frame.events.some((event) => event.type === 'session.error')), { timeout: 15000 });
    // The crash teardown settled an end snapshot (best-effort, after drop).
    await until(async () => (await index.get(session.id))?.checkpoints?.[0]?.end, { timeout: 30000 });
    const entry = await index.get(session.id);
    expect(entry.checkpoints[0]).toMatchObject({ turn: 1, complete: true });
    expect(entry.checkpoints[0].end).toMatch(/^[0-9a-f]{40}$/);
    await manager.shutdown();
  });
});

describe('acp checkpoint review findings, round 2', () => {
  it('mutating records are not evicted under LRU pressure', async () => {
    const handle = await setup({ serviceOptions: { maxInactiveProjections: 1 } });
    const { service } = handle;
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-noevict-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    // Gate the restore so the mutation lock is held while eviction
    // pressure builds.
    let releaseRestore;
    const gate = new Promise((resolve) => { releaseRestore = resolve; });
    const store = handle.checkpoints;
    const originalRestore = store.restore;
    store.restore = async (...args) => { await gate; return originalRestore(...args); };
    try {
      const reverting = service.revert({ key: session.id, turn: 1 });
      await until(() => service.getLive(session.id)?.mutating, { timeout: 5000 });
      const lockedRecord = service.getLive(session.id);
      // Eviction pressure: create + prompt another session (LRU cap 1
      // would evict the reverting record if mutating were evictable).
      const other = await service.create({ backendId: 'fake', directory: cwd });
      await service.prompt({ key: other.session.id, messageId: 'msg-o1', parts: [{ type: 'text', text: 'other' }] });
      await untilIdle(frames);
      expect(service.getLive(session.id)).toBe(lockedRecord);
      await expect(service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'x' }] }))
        .rejects.toMatchObject({ code: 'ACP_SESSION_BUSY' });
      await expect(service.delete({ key: session.id })).rejects.toMatchObject({ code: 'ACP_SESSION_BUSY' });
      await expect(service.fork({ key: session.id })).rejects.toMatchObject({ code: 'ACP_SESSION_BUSY' });
      await expect(service.revert({ key: session.id, turn: 1 })).rejects.toMatchObject({ code: 'ACP_SESSION_BUSY' });
      releaseRestore();
      const result = await reverting;
      expect(result.session.id).toBe(session.id);
    } finally {
      store.restore = originalRestore;
    }
  });

  it('watchdog terminal failure persists the end tree', async () => {
    const { service, index, manager } = await setup({
      entry: {
        env: {
          FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([{ holdForCancel: 10_000 }]),
          FAKE_ACP_LOAD_ERROR: JSON.stringify({ code: -32000, message: 'load down' }),
        },
      },
      serviceOptions: { watchdogMs: 300 },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-watchdog-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    // Watchdog fires, recovery load fails → terminal failure + drop.
    await until(() => frames.some((frame) => frame.events.some((event) => event.type === 'session.error')), { timeout: 15000 });
    await until(async () => (await index.get(session.id))?.checkpoints?.[0]?.end, { timeout: 15000 });
    const entry = await index.get(session.id);
    expect(entry.checkpoints[0]).toMatchObject({ turn: 1, complete: true });
    expect(entry.checkpoints[0].end).toMatch(/^[0-9a-f]{40}$/);
    await manager.shutdown().catch(() => {});
  });

  it('cancel during the note write abandons dispatch and restores the note', async () => {
    const inner = await setup({ entry: { env: { FAKE_ACP_PROMPT_RECORD: '1' } } });
    const frames = syncEvents(inner.service);
    const cwd = await tempDir('acp-cpw-notewrite-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await inner.service.create({ backendId: 'fake', directory: cwd });
    await inner.service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    await inner.service.revert({ key: session.id, turn: 1 });
    expect((await inner.index.get(session.id)).pendingRevertNote).toBeTruthy();
    // Gate the note-clearing upsert specifically; signal entry so the
    // test cancels exactly while gated (not before the snapshot).
    const realUpsert = inner.index.upsert;
    let releaseNote;
    const noteGate = new Promise((resolve) => { releaseNote = resolve; });
    let gated = true;
    let enteredGate = false;
    inner.index.upsert = async (key, patch) => {
      if (gated && key === session.id && patch && 'pendingRevertNote' in patch && patch.pendingRevertNote === undefined) {
        gated = false;
        enteredGate = true;
        await noteGate;
      }
      return realUpsert(key, patch);
    };
    const prompting = inner.service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'cancel me' }] });
    await until(() => enteredGate, { timeout: 10000 });
    const cancelling = inner.service.cancel({ key: session.id });
    // Let the cancel flag land while the note write is still gated.
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseNote();
    expect(await cancelling).toBe(true);
    await prompting;
    await untilIdle(frames);
    const idle = frames.flatMap((frame) => frame.events).find((event) => event.type === 'session.idle');
    expect(idle.properties.outcome).toBe('interrupted');
    // Nothing sent to the agent, and the note is restored for next time.
    const stderr = (await inner.manager.status('fake')).stderrTail;
    expect(stderr).not.toContain('cancel me');
    expect((await inner.index.get(session.id)).pendingRevertNote).toMatch(/reverted to the state before turn 1/);
    inner.index.upsert = realUpsert;
  });

  it('backend exit during the note write abandons dispatch and restores the note', async () => {
    const inner = await setup();
    const frames = syncEvents(inner.service);
    const cwd = await tempDir('acp-cpw-noteexit-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await inner.service.create({ backendId: 'fake', directory: cwd });
    await inner.service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    await inner.service.revert({ key: session.id, turn: 1 });
    const realUpsert = inner.index.upsert;
    let releaseNote;
    const noteGate = new Promise((resolve) => { releaseNote = resolve; });
    let gated = true;
    let enteredGate = false;
    inner.index.upsert = async (key, patch) => {
      if (gated && key === session.id && patch && 'pendingRevertNote' in patch && patch.pendingRevertNote === undefined) {
        gated = false;
        enteredGate = true;
        await noteGate;
      }
      return realUpsert(key, patch);
    };
    const prompting = inner.service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'after exit' }] });
    await until(() => enteredGate, { timeout: 10000 });
    // Crash the backend while the note write is gated: the record drops.
    inner.manager.events.emit('backend-exit', { backendId: 'fake', exit: { code: 1, signal: null } });
    releaseNote();
    await prompting;
    // Dispatch abandoned (no live turn); the note survives for the rebuild.
    expect(inner.service.getLive(session.id)).toBeNull();
    expect((await inner.index.get(session.id)).pendingRevertNote).toMatch(/reverted to the state before turn 1/);
    inner.index.upsert = realUpsert;
  });

  it('committing the revert clears the boundary everywhere', async () => {
    const indexDir = await tempDir('acp-cpw-commit-idx-');
    const first = await setup({
      indexDir,
      entry: {
        env: {
          FAKE_ACP_LOAD_REPLAY: JSON.stringify([
            { sessionUpdate: 'user_message_chunk', messageId: 'u-1', content: { type: 'text', text: 'first' } },
            { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'answer' } },
          ]),
        },
      },
    });
    const frames = syncEvents(first.service);
    const cwd = await tempDir('acp-cpw-commit-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await first.service.create({ backendId: 'fake', directory: cwd });
    await first.service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    frames.length = 0;
    await first.service.revert({ key: session.id, turn: 1 });
    expect((await first.service.open({ key: session.id })).session.revert).toBeTruthy();
    // The next prompt commits the revert.
    await first.service.prompt({ key: session.id, messageId: 'msg-2', parts: [{ type: 'text', text: 'two' }] });
    await untilIdle(frames);
    const committed = await first.service.open({ key: session.id });
    expect(committed.session.revert).toBeUndefined();
    expect(committed.session.metadata.acp.revertedFromTurn).toBeUndefined();
    // Cold list rows serve no boundary either.
    first.service.dispose();
    services.splice(services.indexOf(first.service), 1);
    const second = await setup({ indexDir });
    const listed = await second.service.list({ directory: cwd });
    const row = listed.find((s) => s.id === session.id);
    expect(row.revert).toBeUndefined();
    expect(row.metadata.acp.revertedFromTurn).toBeUndefined();
    // And reopen does not resurrect it from replay.
    const reopened = await second.service.open({ key: session.id });
    expect(reopened.session.revert).toBeUndefined();
    expect(reopened.session.metadata.acp.revertedFromTurn).toBeUndefined();
  });
});

describe('acp fork warmup (UI smoke)', () => {
  it('open during fork rebuild waits for the replay, never an empty page', async () => {
    const { service } = await setup({
      entry: {
        env: {
          FAKE_ACP_FORK: 'true',
          FAKE_ACP_CAPABILITIES: JSON.stringify({ sessionCapabilities: { fork: {} } }),
          FAKE_ACP_LOAD_REPLAY: JSON.stringify([
            { sessionUpdate: 'user_message_chunk', messageId: 'u-1', content: { type: 'text', text: 'first' } },
            { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'answer' } },
          ]),
        },
      },
    });
    const frames = syncEvents(service);
    const cwd = await tempDir('acp-cpw-forkwarm-');
    await fsp.writeFile(join(cwd, 'f.txt'), 'v1\n');
    const { session } = await service.create({ backendId: 'fake', directory: cwd });
    await service.prompt({ key: session.id, messageId: 'msg-1', parts: [{ type: 'text', text: 'one' }] });
    await untilIdle(frames);
    // Slow the fork's load by gating it through a wrapped connection is
    // overkill: the guard path is deterministic — start the fork, then
    // open the key while its replay is in flight (same tick race the
    // router hit). The open must resolve with a populated transcript.
    const forking = service.fork({ key: session.id });
    // Yield until the fork record exists and is replaying.
    const forkKey = await until(async () => {
      const rows = await service.list({ directory: cwd });
      const found = rows.find((s) => s.id !== session.id);
      return found?.id ?? null;
    }, { timeout: 10000 });
    const opened = await service.open({ key: forkKey });
    const { session: forked } = await forking;
    expect(opened.session.id).toBe(forked.id);
    const page = await service.messages({ key: forkKey });
    expect(page.items.length).toBeGreaterThan(0);
    expect(opened.session.title).toBeDefined();
  });
});
