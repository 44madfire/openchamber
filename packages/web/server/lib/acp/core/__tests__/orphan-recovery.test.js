import { spawn } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawnAcpAgent } from '../spawn.js';
import { createManagedProcessRegistry } from '../../../opencode/managed-process-registry.js';

// Live orphan recovery: real agent processes (node script, native binary,
// batch shim) are registered, their "owner" dies (a dead ownerPid is
// recorded), and the real startup reaper must kill exactly those processes.
describe('acp orphan recovery (live processes)', () => {
  const originalRegistryDir = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  let registryDir;
  let registry;
  // The registry dir rides on a process env var, so tests in this file
  // must not run concurrently with each other: serialize via a chain.
  let chain = Promise.resolve();
  const serialized = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  afterEach(async () => {
    if (originalRegistryDir === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = originalRegistryDir;
  });

  const setupRegistry = async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'acp-orphan-reg-'));
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = registryDir;
    registry = createManagedProcessRegistry();
    return registry;
  };

  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const waitForDeath = async (pid, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !isAlive(pid);
  };

  it('reaps an orphaned node agent after its owner died', async () => serialized(async () => {
    await setupRegistry();
    const dir = await mkdtemp(join(tmpdir(), 'acp-orphan-node-'));
    const script = join(dir, 'agent.mjs');
    await writeFile(script, 'setTimeout(() => {}, 60000);');
    // The test owns the entry content (dead owner), so the spawn's own
    // fire-and-forget registration is disabled — no write/write race.
    const spawned = spawnAcpAgent({
      command: process.execPath,
      args: [script],
      registerProcess: () => {},
      unregisterProcess: () => {},
    });
    const pid = spawned.pid;
    try {
      expect(isAlive(pid)).toBe(true);
      const startTimeMs = await registry.readProcessStartTimeMs(pid);
      expect(Number.isFinite(startTimeMs)).toBe(true);
      await registry.registerManagedProcess({
        pid, ownerPid: 2_000_000_001, kind: 'acp', startTimeMs, command: process.execPath,
        invocation: `${process.execPath} ${script}`,
      });
      const { inspected, reaped } = await registry.reapOrphanedProcesses();
      expect(inspected).toBe(1);
      expect(reaped).toBe(1);
      expect(await waitForDeath(pid)).toBe(true);
      expect(await readdir(registryDir)).toEqual([]);
    } finally {
      await spawned.kill().catch(() => {});
    }
  }), 30_000);

  it('reaps an orphaned native agent after its owner died', async () => serialized(async () => {
    // Portable native fixture: Windows ping waits ~60 s; POSIX sleep waits.
    // No developer-local binaries: runs on any checkout and on CI.
    const native = process.platform === 'win32'
      ? { command: 'C:/Windows/System32/ping.exe', args: ['-n', '60', '127.0.0.1'] }
      : { command: '/bin/sleep', args: ['60'] };
    await setupRegistry();
    const spawned = spawnAcpAgent({ ...native, registerProcess: () => {}, unregisterProcess: () => {} });
    const pid = spawned.pid;
    try {
      expect(isAlive(pid)).toBe(true);
      const startTimeMs = await registry.readProcessStartTimeMs(pid);
      expect(Number.isFinite(startTimeMs)).toBe(true);
      await registry.registerManagedProcess({
        pid,
        ownerPid: 2_000_000_001,
        kind: 'acp',
        startTimeMs,
        command: native.command,
        invocation: `${native.command} ${native.args.join(' ')}`,
      });
      const { inspected, reaped } = await registry.reapOrphanedProcesses();
      expect(inspected).toBe(1);
      expect(reaped).toBe(1);
      expect(await waitForDeath(pid)).toBe(true);
    } finally {
      await spawned.kill().catch(() => {});
    }
  }), 30_000);

  // Opt-in real-agent coverage: set ACP_ORPHAN_AGENT='<command> <args...>'
  // (e.g. the omp binary) to reap a genuine agent process. Skipped
  // otherwise — automated suites use the portable fixtures above.
  const realAgentSpec = process.env.ACP_ORPHAN_AGENT;
  (realAgentSpec ? it : it.skip)('reaps a real agent binary when ACP_ORPHAN_AGENT is set', async () => serialized(async () => {
    const [command, ...args] = realAgentSpec.split(/\s+/);
    await setupRegistry();
    const spawned = spawnAcpAgent({ command, args, registerProcess: () => {}, unregisterProcess: () => {} });
    const pid = spawned.pid;
    try {
      expect(isAlive(pid)).toBe(true);
      const startTimeMs = await registry.readProcessStartTimeMs(pid);
      await registry.registerManagedProcess({
        pid, ownerPid: 2_000_000_001, kind: 'acp', startTimeMs, command,
        invocation: `${command} ${args.join(' ')}`,
      });
      const { inspected, reaped } = await registry.reapOrphanedProcesses();
      expect(inspected).toBe(1);
      expect(reaped).toBe(1);
      expect(await waitForDeath(pid)).toBe(true);
    } finally {
      await spawned.kill().catch(() => {});
    }
  }), 30_000);

  it('reaps an orphaned batch-shim tree (cmd.exe + child)', async () => serialized(async () => {
    await setupRegistry();
    const dir = await mkdtemp(join(tmpdir(), 'acp-orphan-bat-'));
    const script = join(dir, 'agent.mjs');
    await writeFile(script, 'setTimeout(() => {}, 60000);');
    const shim = join(dir, 'agent.cmd');
    // Plain (non-npm) shim: forces the cmd.exe fallback path.
    await writeFile(shim, `@ECHO off\r\n"${process.execPath}" "${script}"\r\n`);
    const spawned = spawnAcpAgent({ command: shim, registerProcess: () => {}, unregisterProcess: () => {} });
    const pid = spawned.pid;
    try {
      expect(isAlive(pid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const startTimeMs = await registry.readProcessStartTimeMs(pid);
      expect(Number.isFinite(startTimeMs)).toBe(true);
      await registry.registerManagedProcess({
        pid, ownerPid: 2_000_000_001, kind: 'acp', startTimeMs, command: shim,
      });
      const { inspected, reaped } = await registry.reapOrphanedProcesses();
      expect(inspected).toBe(1);
      expect(reaped).toBe(1);
      expect(await waitForDeath(pid)).toBe(true);
    } finally {
      await spawned.kill().catch(() => {});
    }
  }), 30_000);

  it('leaves a live-owned agent alone', async () => serialized(async () => {
    await setupRegistry();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await registry.registerManagedProcess({
        pid: child.pid, ownerPid: process.pid, kind: 'acp',
        startTimeMs: Date.now(), command: process.execPath,
      });
      const { inspected, reaped } = await registry.reapOrphanedProcesses();
      expect(inspected).toBe(1);
      expect(reaped).toBe(0);
      expect(isAlive(child.pid)).toBe(true);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }), 30_000);
});
