import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AcpVersionMismatchError } from '../protocol-version.js';
import { AcpBackendError, createAcpBackendManager } from '../backend-manager.js';
import { createAcpBackendRegistry } from '../registry.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

const tempDir = () => mkdtemp(join(tmpdir(), 'acp-manager-'));

const seedRegistry = async (entries) => {
  const registry = createAcpBackendRegistry({ dataDir: await tempDir(), resolveCommand: () => null });
  await registry.save(entries);
  return registry;
};

// Real spawns without touching the operator's managed-process registry
// (the orphan-recovery suite covers the real registry with an isolated dir).
const isolatedSpawn = async () => {
  const { spawnAcpAgent } = await import('../spawn.js');
  return (options) => spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} });
};

const fakeEntry = (overrides = {}) => ({
  id: 'fake',
  label: 'fake',
  command: process.execPath,
  args: [FAKE_AGENT],
  enabled: true,
  ...overrides,
});

const isAlive = (pid) => {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The child `exit` event lands just after the kill resolves; wait for the
// kernel to reap the PID rather than sleeping a fixed beat.
const untilExited = async (child, timeoutMs) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for PID ${child.pid} to exit`)), timeoutMs);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

describe('backend manager', () => {
  it('lazily starts one process per backend and reports ready', async () => {
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry()]),
    });
    try {
      expect((await manager.status('fake')).state).toBe('idle');
      const first = await manager.ensureReady('fake');
      const second = await manager.ensureReady('fake');
      expect(second).toBe(first);
      const status = await manager.status('fake');
      expect(status.state).toBe('ready');
      expect(status.protocolVersion).toBe(1);
      expect(status.agentInfo).toMatchObject({ name: 'fake-agent' });
      expect(status.lastError).toBeNull();
    } finally {
      await manager.shutdown();
    }
  });

  it('shares one start across concurrent callers', async () => {
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry()]),
    });
    try {
      const [a, b] = await Promise.all([manager.ensureReady('fake'), manager.ensureReady('fake')]);
      expect(a).toBe(b);
    } finally {
      await manager.shutdown();
    }
  });

  it('reports unconfigured for missing and disabled backends', async () => {
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry({ enabled: false })]),
    });
    try {
      expect((await manager.status('fake')).state).toBe('unconfigured');
      expect((await manager.status('ghost')).state).toBe('unconfigured');
      await expect(manager.ensureReady('fake')).rejects.toMatchObject({ code: 'ACP_BACKEND_DISABLED' });
      await expect(manager.ensureReady('ghost')).rejects.toMatchObject({ code: 'ACP_BACKEND_UNKNOWN' });
    } finally {
      await manager.shutdown();
    }
  });

  it('surfaces a version mismatch as AcpVersionMismatchError and keeps error status', async () => {
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry({ env: { FAKE_ACP_PROTOCOL_VERSION: '2' } })]),
    });
    try {
      await expect(manager.ensureReady('fake')).rejects.toBeInstanceOf(AcpVersionMismatchError);
      const status = await manager.status('fake');
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/mismatch/i);
    } finally {
      await manager.shutdown();
    }
  });

  it('reports startup failure with the stderr tail', async () => {
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry({
        env: { FAKE_ACP_EXIT_CODE: '7', FAKE_ACP_STDERR: 'traceback-line' },
      })]),
    });
    try {
      await expect(manager.ensureReady('fake')).rejects.toBeInstanceOf(AcpBackendError);
      const status = await manager.status('fake');
      expect(status.state).toBe('error');
      expect(status.stderrTail).toContain('traceback-line');
    } finally {
      await manager.shutdown();
    }
  });

  it('emits backend-exit on crash and respawns on next use', async () => {
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry({ env: { FAKE_ACP_CRASH_ON: '300' } })]),
    });
    try {
      await manager.ensureReady('fake');
      const crashed = await new Promise((resolve) => manager.events.once('backend-exit', resolve));
      expect(crashed.backendId).toBe('fake');
      expect((await manager.status('fake')).state).toBe('error');
      expect((await manager.status('fake')).lastError).toMatch(/exited/);
    } finally {
      await manager.shutdown();
    }
  });

  it('serves again after a crash once the backend restarts', async () => {
    const dataDir = await tempDir();
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await registry.save([fakeEntry({ env: { FAKE_ACP_CRASH_ON: '200' } })]);
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry,
    });
    try {
      await manager.ensureReady('fake');
      await new Promise((resolve) => manager.events.once('backend-exit', resolve));
      await registry.save([fakeEntry()]);
      const status = await manager.restart('fake');
      expect(status.state).toBe('ready');
      expect((await manager.status('fake')).lastError).toBeNull();
    } finally {
      await manager.shutdown();
    }
  });

  it('restarts a backend into a fresh process', async () => {
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry()]),
    });
    try {
      const before = await manager.ensureReady('fake');
      const status = await manager.restart('fake');
      expect(status.state).toBe('ready');
      const after = await manager.ensureReady('fake');
      expect(after).not.toBe(before);
    } finally {
      await manager.shutdown();
    }
  });

  it('authenticates agent methods and refuses terminal ones', async () => {
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry({
        env: {
          FAKE_ACP_AUTHENTICATE: '1',
          FAKE_ACP_AUTH_METHODS: JSON.stringify([
            { id: 'agent-login', name: 'Login' },
            { id: 'term', name: 'Terminal', type: 'terminal' },
          ]),
        },
      })]),
    });
    try {
      const status = await manager.authenticate('fake', 'agent-login');
      expect(status.state).toBe('ready');
      await expect(manager.authenticate('fake', 'term')).rejects.toMatchObject({ code: 'ACP_AUTH_TERMINAL' });
      await expect(manager.authenticate('fake', 'ghost')).rejects.toMatchObject({ code: 'ACP_AUTH_UNKNOWN_METHOD' });
    } finally {
      await manager.shutdown();
    }
  });

  it('reaps idle backends and keeps leased ones alive', async () => {
    // No fixed sleeps: the reap deadline passing is OBSERVED via a
    // lease-free control backend reaping on it, while the leased backend
    // stays ready — then the released lease reaps too.
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry(), fakeEntry({ id: 'control', label: 'control' })]),
      idleReapMs: 200,
    });
    const reaped = new Promise((resolve, reject) => {
      const seen = new Set();
      const timer = setTimeout(() => reject(new Error(`timed out waiting for idle reap (saw: ${[...seen]})`)), 15_000);
      timer.unref?.();
      manager.events.on('backend-idle-reaped', ({ backendId }) => {
        seen.add(backendId);
        if (seen.has('control') && seen.has('fake')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    try {
      const lease = await manager.acquire('fake');
      await manager.ensureReady('control');
      // The control (lease-free) reaps on the deadline; the leased one
      // cannot — observe both without sleeping a fixed beat.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('control backend never reaped')), 15_000);
        timer.unref?.();
        manager.events.on('backend-idle-reaped', function onReap({ backendId }) {
          if (backendId !== 'control') return;
          clearTimeout(timer);
          manager.events.removeListener('backend-idle-reaped', onReap);
          resolve();
        });
      });
      expect((await manager.status('fake')).state).toBe('ready');
      lease.release();
      await reaped;
      expect((await manager.status('fake')).state).toBe('idle');
    } finally {
      await manager.shutdown();
    }
  });

  it('leaves no agent process behind after shutdown', async () => {
    // Capture the exact PIDs this manager spawns (via the spawnAgent
    // injection) and assert those — and only those — exited. Machine-wide
    // PID snapshots flaked under parallel workers.
    const spawned = [];
    const baseSpawn = await isolatedSpawn();
    const manager = createAcpBackendManager({
      spawnAgent: (options) => {
        const agent = baseSpawn(options);
        spawned.push(agent.child);
        return agent;
      },
      registry: await seedRegistry([fakeEntry(), fakeEntry({ id: 'fake2', label: 'fake2' })]),
    });
    await manager.ensureReady('fake');
    await manager.ensureReady('fake2');
    expect(spawned.map((child) => child.pid)).toHaveLength(2);
    await manager.shutdown();
    for (const child of spawned) {
      await untilExited(child, 10_000);
      expect(isAlive(child.pid)).toBe(false);
    }
    expect((await manager.status('fake')).state).toBe('idle');
    expect((await manager.status('fake2')).state).toBe('idle');
  }, 30_000);

  it('stops a backend removed from the registry and refuses to serve it', async () => {
    const dataDir = await tempDir();
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await registry.save([fakeEntry()]);
    let kills = 0;
    const { spawnAcpAgent } = await import('../spawn.js');
    const manager = createAcpBackendManager({
      registry,
      spawnAgent: (options) => {
        const spawned = spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} });
        const kill = spawned.kill;
        spawned.kill = async (...args) => { kills += 1; return kill(...args); };
        return spawned;
      },
    });
    try {
      await manager.ensureReady('fake');
      await registry.save([]);
      expect(await manager.listStatuses()).toEqual([]);
      expect(kills).toBe(1);
      await expect(manager.ensureReady('fake')).rejects.toMatchObject({ code: 'ACP_BACKEND_UNKNOWN' });
    } finally {
      await manager.shutdown();
    }
  });

  it('stops a backend disabled in the registry and refuses to serve it', async () => {
    const dataDir = await tempDir();
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await registry.save([fakeEntry()]);
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry,
    });
    try {
      await manager.ensureReady('fake');
      await registry.save([fakeEntry({ enabled: false })]);
      const statuses = await manager.listStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].state).toBe('unconfigured');
      await expect(manager.ensureReady('fake')).rejects.toMatchObject({ code: 'ACP_BACKEND_DISABLED' });
    } finally {
      await manager.shutdown();
    }
  });

  it('calls onConnect with version and agentInfo on every connect', async () => {
    const connects = [];
    const manager = createAcpBackendManager({
      spawnAgent: await isolatedSpawn(),
      registry: await seedRegistry([fakeEntry()]),
      onConnect: (info) => { connects.push(info); },
    });
    try {
      await manager.ensureReady('fake');
      await manager.restart('fake');
      expect(connects).toHaveLength(2);
      for (const info of connects) {
        expect(info).toEqual({
          backendId: 'fake',
          protocolVersion: 1,
          agentInfo: expect.objectContaining({ name: 'fake-agent' }),
        });
      }
    } finally {
      await manager.shutdown();
    }
  });
});

describe('backend manager lifecycle races', () => {
  // Deterministic overlap probes with injected spawn/connect: every spawned
  // process is tracked, connects resolve on demand, kills are counted.
  const controllable = () => {
    const processes = [];
    let nextId = 1;
    let connectGate = null;
    const api = {
      processes,
      spawnAgent: () => {
        const proc = {
          id: nextId++,
          alive: true,
          child: {},
          getStderrTail: () => '',
          kill: async () => { proc.alive = false; },
        };
        processes.push(proc);
        return proc;
      },
      connectAgent: () => new Promise((resolve, reject) => {
        connectGate = { resolve, reject };
      }),
      resolveConnect: (overrides = {}) => {
        const gate = connectGate;
        connectGate = null;
        gate.resolve({
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: 'fake', version: '1' },
          waitForExit: () => new Promise(() => {}),
          ...overrides,
        });
      },
      aliveIds: () => processes.filter((proc) => proc.alive).map((proc) => proc.id),
    };
    return api;
  };

  const memoryRegistry = (entries) => {
    let current = entries;
    return {
      get: async (id) => current.find((entry) => entry.id === id) ?? null,
      list: async () => current,
      set: (entries) => { current = entries; },
    };
  };

  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('never publishes a start that shutdown overtook', async () => {
    const ctl = controllable();
    const manager = createAcpBackendManager({
      registry: memoryRegistry([{ id: 'b', enabled: true, command: 'x', args: [] }]),
      spawnAgent: ctl.spawnAgent,
      connectAgent: ctl.connectAgent,
      stderrFlushMs: 1,
    });
    const started = manager.ensureReady('b');
    await tick();
    // Shutdown settles the in-flight start: resolve the connect after the
    // generation bump, then both promises complete.
    const shuttingDown = manager.shutdown();
    await tick();
    ctl.resolveConnect();
    await shuttingDown;
    await expect(started).rejects.toMatchObject({ code: 'ACP_BACKEND_SHUTDOWN' });
    expect(ctl.aliveIds()).toEqual([]);
    expect((await manager.status('b')).state).not.toBe('ready');
    await expect(manager.ensureReady('b')).rejects.toMatchObject({ code: 'ACP_BACKEND_SHUTDOWN' });
  });

  it('serializes overlapping restarts: one survivor, no orphans', async () => {
    const ctl = controllable();
    const manager = createAcpBackendManager({
      registry: memoryRegistry([{ id: 'b', enabled: true, command: 'x', args: [] }]),
      spawnAgent: ctl.spawnAgent,
      connectAgent: async () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        agentInfo: { name: 'fake' },
        waitForExit: () => new Promise(() => {}),
      }),
      stderrFlushMs: 1,
    });
    const first = manager.restart('b');
    const second = manager.restart('b');
    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(firstStatus.state).toBe('ready');
    expect(secondStatus.state).toBe('ready');
    // Both restarts resolve ready; regardless of how the fresh start was
    // shared, exactly one process survives and shutdown kills everything.
    expect(ctl.aliveIds()).toHaveLength(1);
    await manager.shutdown();
    expect(ctl.aliveIds()).toEqual([]);
  });

  it('a stop during initialize kills the late connection instead of publishing it', async () => {
    const ctl = controllable();
    const manager = createAcpBackendManager({
      registry: memoryRegistry([{ id: 'b', enabled: true, command: 'x', args: [] }]),
      spawnAgent: ctl.spawnAgent,
      connectAgent: ctl.connectAgent,
      stderrFlushMs: 1,
    });
    const started = manager.ensureReady('b');
    await tick();
    const stopped = manager.stop('b');
    // Let the stop's generation bump land, then resolve the stale connect.
    await tick();
    ctl.resolveConnect();
    await expect(started).rejects.toMatchObject({ code: 'ACP_BACKEND_SUPERSEDED' });
    await stopped;
    expect(ctl.aliveIds()).toEqual([]);
    expect((await manager.status('b')).state).toBe('idle');
  });

  it('restart during acquire leaves the lease releasable and the backend fresh', async () => {
    const ctl = controllable();
    const manager = createAcpBackendManager({
      registry: memoryRegistry([{ id: 'b', enabled: true, command: 'x', args: [] }]),
      spawnAgent: ctl.spawnAgent,
      connectAgent: async () => ({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
        agentInfo: { name: 'fake' },
        waitForExit: () => new Promise(() => {}),
      }),
      stderrFlushMs: 1,
      idleReapMs: 50,
    });
    const lease = await manager.acquire('b');
    const status = await manager.restart('b');
    expect(status.state).toBe('ready');
    expect(ctl.aliveIds()).toHaveLength(1);
    expect(() => lease.release()).not.toThrow();
    await manager.shutdown();
    expect(ctl.aliveIds()).toEqual([]);
  });
});
