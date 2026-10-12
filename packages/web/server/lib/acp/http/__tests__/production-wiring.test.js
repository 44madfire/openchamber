import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { createAcpBackendRegistry } from '../../core/registry.js';
import { createFeatureRoutesRuntime } from '../../../opencode/feature-routes-runtime.js';
import { createGracefulShutdownRuntime } from '../../../opencode/shutdown-runtime.js';

const FAKE_AGENT = fileURLToPath(new URL('../../core/__tests__/fake-agent.mjs', import.meta.url));

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Production wiring: the manager is created inside the REAL feature
// runtime's registerRoutes, HTTP goes through the real Express app, and
// shutdown flows through the REAL graceful-shutdown sequence wired exactly
// as server/index.js wires it. The test never calls manager.shutdown() —
// if the production hook were removed, the agent would survive and the
// test would fail.
describe('acp production shutdown wiring', () => {
  it('stops the feature-runtime-owned backend via graceful shutdown', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'acp-prod-wire-'));
    // Seed the registry the production code reads: the runtime creates its
    // own registry + manager from openchamberDataDir.
    const seed = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await seed.save([{
      id: 'fake', label: 'fake', command: process.execPath, args: [FAKE_AGENT], enabled: true,
    }]);
    // Isolated managed-process registry: the production spawn writes here,
    // and the test finds the agent pid in it (no operator-dir litter).
    const managedDir = await mkdtemp(join(tmpdir(), 'acp-prod-managed-'));
    const previousManagedDir = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = managedDir;

    const featureRuntime = createFeatureRoutesRuntime({ clientReloadDelayMs: 0 });
    const app = express();
    // Prefix registrations before ACP only mount routes (no I/O at
    // registration), so inert runtimes suffice; ACP registration itself is
    // the real production code under test.
    const inert = new Proxy({}, { get: () => () => { throw new Error('must not be called during registration'); } });
    await featureRuntime.registerRoutes(app, {
      openchamberDataDir: dataDir,
      permissionAutoAcceptRuntime: inert,
      messageQueueRuntime: inert,
      routingRuntime: inert,
      readCustomThemesFromDisk: inert.get,
      saveImportedTheme: inert.get,
      deleteImportedTheme: inert.get,
      refreshOpenCodeAfterConfigChange: inert.get,
      // Everything after ACP registration: fail loudly if reached, so the
      // test pins ACP's position before the OpenCode proxy wiring.
      crypto: null,
      getOpenCodeResolutionSnapshot: () => { throw new Error('unreachable in this test'); },
    }).catch((error) => {
      // registerRoutes continues past ACP into OpenCode route wiring that
      // needs the full host; that tail is out of scope here. ACP routes
      // (and manager ownership) are already registered at that point.
      if (!/unreachable in this test|must not be called|cannot read|undefined/i.test(error?.message ?? '')) throw error;
    });

    const manager = featureRuntime.getAcpBackendManager();
    expect(manager).not.toBeNull();

    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    // The real graceful-shutdown runtime, wired to the feature runtime
    // exactly as server/index.js does it.
    const shutdownRuntime = createGracefulShutdownRuntime({
      process: { exit: vi.fn() },
      shutdownTimeoutMs: 5000,
      getExitOnShutdown: () => false,
      getIsShuttingDown: () => false,
      setIsShuttingDown: () => {},
      syncToHmrState: () => {},
      openCodeWatcherRuntime: { stop: async () => {} },
      sessionRuntime: { dispose: async () => {} },
      scheduledTasksRuntime: { stop: async () => {} },
      getHealthCheckInterval: () => null,
      clearHealthCheckInterval: () => {},
      getTerminalRuntime: () => null,
      setTerminalRuntime: () => {},
      getMessageStreamRuntime: () => null,
      setMessageStreamRuntime: () => {},
      shouldSkipOpenCodeStop: () => true,
      getOpenCodePort: () => null,
      getOpenCodeProcess: () => null,
      setOpenCodeProcess: () => {},
      killProcessOnPort: () => {},
      waitForPortRelease: async () => true,
      getServer: () => server,
      getUiAuthController: () => null,
      setUiAuthController: () => {},
      getActiveTunnelController: () => null,
      setActiveTunnelController: () => {},
      tunnelAuthController: { clearActiveTunnel: () => {} },
      beginGuestServiceShutdown: () => {},
      stopAllGuestServices: async () => {},
      getGuestSurfaceRuntime: () => null,
      getRealtimeProxyRuntime: () => null,
      getDictationRuntime: () => null,
      getRelayService: () => null,
      getRelayReconcileTimer: () => null,
      // Production wiring, verbatim from server/index.js.
      shutdownAcpBackends: () => featureRuntime.shutdownAcpBackends(),
    });

    try {
      const restartRes = await fetch(`${base}/api/acp/backends/fake/restart`, { method: 'POST' });
      expect(restartRes.status).toBe(200);
      const restartBody = await restartRes.json();
      expect(restartBody.backend).toMatchObject({ state: 'ready', protocolVersion: 1 });

      // Prove the HTTP-serving manager IS the owned one: its status agrees.
      expect((await manager.status('fake')).state).toBe('ready');

      // Find the agent pid through the isolated managed-process registry:
      // the production spawn wrote it. Registration captures the OS
      // creation stamp first, so poll briefly for the file to land.
      const { readdir, readFile } = await import('node:fs/promises');
      let agentPid = null;
      for (let attempt = 0; attempt < 50 && agentPid === null; attempt++) {
        const names = await readdir(managedDir).catch(() => []);
        for (const name of names) {
          try {
            const entry = JSON.parse(await readFile(join(managedDir, name), 'utf8'));
            if (entry?.kind === 'acp' && Number.isInteger(entry.pid) && isAlive(entry.pid)) agentPid = entry.pid;
          } catch {
            // ignore
          }
        }
        if (agentPid === null) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(agentPid).not.toBeNull();

      // THE production shutdown path — not manager.shutdown().
      await shutdownRuntime.gracefulShutdown({ exitProcess: false });

      expect(isAlive(agentPid)).toBe(false);
    } finally {
      if (previousManagedDir === undefined) delete process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
      else process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previousManagedDir;
      await new Promise((resolve) => server.close(resolve)).catch(() => {});
    }
  }, 60_000);
});
