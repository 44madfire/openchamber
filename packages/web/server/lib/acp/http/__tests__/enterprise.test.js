import express from 'express';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAcpBackendRegistry } from '../../core/registry.js';
import { createFeatureRoutesRuntime } from '../../../opencode/feature-routes-runtime.js';

const FAKE_AGENT = fileURLToPath(new URL('../../core/__tests__/fake-agent.mjs', import.meta.url));

// Enterprise enforcement for ACP, through production wiring: the real
// Express app + feature runtime. `readEnterprisePolicy` reads live state
// from the fixed machine-policy path (plus env), and the route/manager
// call it bare — so allowlist tests answer just that path from memory
// (see `withAllowlistPolicy`), while fail-closed tests set
// OPENCHAMBER_ENTERPRISE_MODE=1 with no policy file at all. The decision
// matrix below covers `enterpriseDecisionForBackend` directly.
describe('acp enterprise enforcement', () => {
  const previousEnterprise = process.env.OPENCHAMBER_ENTERPRISE_MODE;

  afterEach(() => {
    if (previousEnterprise === undefined) delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    else process.env.OPENCHAMBER_ENTERPRISE_MODE = previousEnterprise;
    vi.restoreAllMocks();
  });

  const bootProductionApp = async (dataDir) => {
    const featureRuntime = createFeatureRoutesRuntime({ clientReloadDelayMs: 0 });
    const app = express();
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
      crypto: null,
      getOpenCodeResolutionSnapshot: () => { throw new Error('unreachable in this test'); },
    }).catch((error) => {
      if (!/unreachable in this test|must not be called|cannot read|undefined/i.test(error?.message ?? '')) throw error;
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      base,
      manager: featureRuntime.getAcpBackendManager(),
      close: async () => {
        await featureRuntime.shutdownAcpBackends().catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      },
    };
  };

  // Steer the production policy reader — the route and the manager call
  // it bare, with no readFile hook — by answering just the
  // machine-policy path from memory; every other read goes to disk.
  const withAllowlistPolicy = async (acpBackends, fn) => {
    const { policyFilePaths } = await import('../../../enterprise-mode.js');
    const policyPaths = policyFilePaths();
    const text = JSON.stringify({ enterpriseMode: true, acpBackends });
    const realReadFileSync = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...rest) => {
      if (policyPaths.includes(String(filePath))) return text;
      return realReadFileSync(filePath, ...rest);
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
  };

  it('refuses registry PUT in enterprise mode without an allowlist (403, nothing saved)', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const dataDir = await mkdtemp(join(tmpdir(), 'acp-ent-put-'));
    const { base, close } = await bootProductionApp(dataDir);
    try {
      const res = await fetch(`${base}/api/acp/backends`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ id: 'evil', label: 'evil', command: 'node', args: ['x.js'], env: { EXTERNAL_PROVIDER_KEY: 's3cret' }, enabled: true }]),
      });
      expect(res.status).toBe(403);
      const payload = await res.json();
      expect(payload.code).toBe('ACP_ENTERPRISE_BLOCKED');
      const seed = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
      expect(await seed.list().then((entries) => entries.map((e) => e.id))).not.toContain('evil');
    } finally {
      await close();
    }
  });

  it('refuses launch of a pre-existing registry entry in enterprise mode', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const dataDir = await mkdtemp(join(tmpdir(), 'acp-ent-launch-'));
    const seed = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await seed.save([{ id: 'fake', label: 'fake', command: process.execPath, args: [FAKE_AGENT], enabled: true }]);
    const { base, manager, close } = await bootProductionApp(dataDir);
    try {
      await expect(manager.ensureReady('fake')).rejects.toMatchObject({ code: 'ACP_ENTERPRISE_BLOCKED' });
      // …and through HTTP: restart must fail the same way.
      const res = await fetch(`${base}/api/acp/backends/fake/restart`, { method: 'POST' });
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });

  it('allowlist match is enforced at PUT and at launch (unit: decision matrix)', async () => {
    const { enterpriseDecisionForBackend } = await import('../../core/enterprise.js');
    const policy = (acpBackends) => ({ enterpriseMode: true, acpBackends });
    // Not enterprise-gated: everything passes through with user env intact.
    expect(enterpriseDecisionForBackend(
      { id: 'a', command: 'x', env: { K: 'v' } },
      { policy: { enterpriseMode: false, acpBackends: null } },
    )).toEqual({ allowed: true, env: { K: 'v' } });
    // No allowlist at all: blocked.
    expect(enterpriseDecisionForBackend({ id: 'a', command: 'x' }, { policy: policy(null) }).allowed).toBe(false);
    // Wrong id / command / args: blocked.
    const allow = [{ id: 'omp', command: '/usr/bin/omp', args: ['acp'] }];
    expect(enterpriseDecisionForBackend({ id: 'nope', command: '/usr/bin/omp', args: ['acp'] }, { policy: policy(allow) }).allowed).toBe(false);
    expect(enterpriseDecisionForBackend({ id: 'omp', command: '/bin/evil', args: ['acp'] }, { policy: policy(allow) }).allowed).toBe(false);
    expect(enterpriseDecisionForBackend({ id: 'omp', command: '/usr/bin/omp', args: ['other'] }, { policy: policy(allow) }).allowed).toBe(false);
    // Exact match: allowed, user env dropped.
    expect(enterpriseDecisionForBackend(
      { id: 'omp', command: '/usr/bin/omp', args: ['acp'], env: { EXTERNAL_PROVIDER_KEY: 's3cret' } },
      { policy: policy(allow) },
    )).toEqual({ allowed: true, env: {} });
    // A pinned row against a missing entry argv: blocked — missing
    // counts as `[]`, which differs from the pinned argv.
    expect(enterpriseDecisionForBackend(
      { id: 'omp', command: '/usr/bin/omp' },
      { policy: policy(allow) },
    ).allowed).toBe(false);
    // Args omitted in the row pins the EMPTY argv: a missing or empty
    // entry argv matches (user env still dropped), anything else is
    // blocked — an allowlisted interpreter must not gain `-e`/script
    // arguments the administrator never pinned.
    const omitted = [{ id: 'omp', command: '/usr/bin/omp' }];
    expect(enterpriseDecisionForBackend(
      { id: 'omp', command: '/usr/bin/omp', env: { A: 'b' } },
      { policy: policy(omitted) },
    )).toEqual({ allowed: true, env: {} });
    expect(enterpriseDecisionForBackend(
      { id: 'omp', command: '/usr/bin/omp', args: [], env: { A: 'b' } },
      { policy: policy(omitted) },
    )).toEqual({ allowed: true, env: {} });
    expect(enterpriseDecisionForBackend(
      { id: 'omp', command: '/usr/bin/omp', args: ['whatever'], env: { A: 'b' } },
      { policy: policy(omitted) },
    ).allowed).toBe(false);
    expect(enterpriseDecisionForBackend(
      { id: 'omp', command: '/usr/bin/omp', args: ['-e', 'arbitrary user program'] },
      { policy: policy(omitted) },
    ).allowed).toBe(false);
  });

  it('parses acpBackends from the policy file', async () => {
    const enterprise = await import('../../../enterprise-mode.js');
    const policy = enterprise.readEnterprisePolicy({
      env: {},
      platform: 'linux',
      readFile: (p) => {
        if (p !== '/etc/openchamber/policy.json') throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return JSON.stringify({ enterpriseMode: true, acpBackends: [{ id: 'omp', command: '/usr/bin/omp', args: ['acp'] }] });
      },
    });
    expect(policy.enterpriseMode).toBe(true);
    expect(policy.acpBackends).toEqual([{ id: 'omp', command: '/usr/bin/omp', args: ['acp'] }]);
  });

  it('pins the empty argv when the allowlist row omits args (production PUT)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'acp-ent-omitted-put-'));
    const { base, manager, close } = await bootProductionApp(dataDir);
    const launches = [];
    manager.events.on('backend-ready', (event) => launches.push(event));
    manager.events.on('backend-error', (event) => launches.push(event));
    const allowlist = [
      { id: 'node', command: process.execPath },
      { id: 'pinned', command: '/usr/bin/omp', args: ['acp'] },
    ];
    try {
      await withAllowlistPolicy(allowlist, async () => {
        const put = (backends) => fetch(`${base}/api/acp/backends`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backends),
        });
        // An interpreter `-e` program smuggled in as argv against an
        // allowlisted executable: blocked, and nothing is saved.
        const evil = await put([{ id: 'node', label: 'node', command: process.execPath, args: ['-e', 'arbitrary user program'], enabled: true }]);
        expect(evil.status).toBe(403);
        expect(await evil.json()).toMatchObject({ code: 'ACP_ENTERPRISE_BLOCKED' });
        const seed = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
        expect(await seed.list().then((entries) => entries.map((entry) => entry.id))).not.toContain('node');
        // Any other argv against the omitted row: blocked. So is argv
        // mismatching a pinned row.
        const other = await put([{ id: 'node', label: 'node', command: process.execPath, args: ['acp'], enabled: true }]);
        expect(other.status).toBe(403);
        expect(await other.json()).toMatchObject({ code: 'ACP_ENTERPRISE_BLOCKED' });
        const mismatched = await put([{ id: 'pinned', label: 'pinned', command: '/usr/bin/omp', args: ['other'], enabled: true }]);
        expect(mismatched.status).toBe(403);
        expect(await mismatched.json()).toMatchObject({ code: 'ACP_ENTERPRISE_BLOCKED' });
        // Missing or empty argv matches the pinned-empty row: saved.
        const missing = await put([{ id: 'node', label: 'node', command: process.execPath, enabled: true }]);
        expect(missing.status).toBe(200);
        const empty = await put([{ id: 'node', label: 'node', command: process.execPath, args: [], enabled: true }]);
        expect(empty.status).toBe(200);
        expect(await empty.json()).toMatchObject({ backends: [{ id: 'node' }] });
        expect(await seed.list()).toEqual([
          expect.objectContaining({ id: 'node', command: process.execPath, args: [] }),
        ]);
        // PUT only writes the registry; the backend never started.
        expect(launches).toEqual([]);
        expect((await manager.status('node')).state).toBe('idle');
      });
    } finally {
      await close();
    }
  });

  it('refuses launch when a pre-existing entry carries argv the allowlist row omits (production launch)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'acp-ent-omitted-launch-'));
    const seed = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await seed.save([{ id: 'node', label: 'node', command: process.execPath, args: ['-e', 'arbitrary user program'], enabled: true }]);
    const { base, manager, close } = await bootProductionApp(dataDir);
    const launches = [];
    manager.events.on('backend-ready', (event) => launches.push(event));
    manager.events.on('backend-error', (event) => launches.push(event));
    try {
      await withAllowlistPolicy([{ id: 'node', command: process.execPath }], async () => {
        await expect(manager.ensureReady('node')).rejects.toMatchObject({ code: 'ACP_ENTERPRISE_BLOCKED' });
        // …and through HTTP: restart refuses the same way.
        const res = await fetch(`${base}/api/acp/backends/node/restart`, { method: 'POST' });
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'ACP_ENTERPRISE_BLOCKED' });
      });
      // Refused before spawn: no process started, failed, or left a mark.
      expect(launches).toEqual([]);
      expect((await manager.status('node')).state).toBe('idle');
    } finally {
      await close();
    }
  });
});
