import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { acpBackendEntrySchema, createAcpBackendRegistry } from '../registry.js';

const validEntry = (overrides = {}) => ({
  id: 'omp',
  label: 'omp',
  command: 'omp',
  args: ['acp'],
  enabled: true,
  ...overrides,
});

describe('registry schema', () => {
  it('accepts a full entry with env, helper and cache', () => {
    const parsed = acpBackendEntrySchema.parse(validEntry({
      env: { FOO: 'bar' },
      helper: { config: { model: 'haiku', effort: 'none' } },
      cache: { configOptions: [{ id: 'model' }], at: new Date().toISOString() },
    }));
    expect(parsed.helper.config.model).toBe('haiku');
    expect(parsed.cache.configOptions).toHaveLength(1);
  });

  it('defaults args to [] and enabled to true', () => {
    const parsed = acpBackendEntrySchema.parse({ id: 'x', label: 'x', command: 'x' });
    expect(parsed.args).toEqual([]);
    expect(parsed.enabled).toBe(true);
  });

  it('rejects malformed ids, unknown keys and bad cache timestamps', () => {
    expect(() => acpBackendEntrySchema.parse(validEntry({ id: 'OMP' }))).toThrow();
    expect(() => acpBackendEntrySchema.parse(validEntry({ id: '' }))).toThrow();
    expect(() => acpBackendEntrySchema.parse({ ...validEntry(), extra: 1 })).toThrow();
    expect(() => acpBackendEntrySchema.parse(validEntry({ cache: { configOptions: [], at: 'nope' } }))).toThrow();
    expect(() => acpBackendEntrySchema.parse(validEntry({ command: '' }))).toThrow();
  });
});

describe('registry persistence', () => {
  const tempDir = () => mkdtemp(join(tmpdir(), 'acp-registry-'));

  it('seeds only the backends whose command resolves, with opencode disabled', async () => {
    const registry = createAcpBackendRegistry({
      dataDir: await tempDir(),
      resolveCommand: (command) => (command === 'omp' ? 'C:\\tools\\omp.exe' : null),
    });
    const entries = await registry.list();
    expect(entries).toEqual([
      { id: 'omp', label: 'omp', command: 'omp', args: ['acp'], enabled: true },
    ]);
  });

  it('seeds opencode disabled when it resolves', async () => {
    const registry = createAcpBackendRegistry({
      dataDir: await tempDir(),
      resolveCommand: () => '/usr/bin/agent',
    });
    const entries = await registry.list();
    expect(entries.map((entry) => [entry.id, entry.args, entry.enabled])).toEqual([
      ['opencode', ['acp'], false],
      ['omp', ['acp'], true],
      ['pi-acp', [], true],
    ]);
  });

  it('seeds nothing when no command resolves', async () => {
    const registry = createAcpBackendRegistry({
      dataDir: await tempDir(),
      resolveCommand: () => null,
    });
    expect(await registry.list()).toEqual([]);
  });

  it('persists saves atomically and reads them back', async () => {
    const dataDir = await tempDir();
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await registry.list();
    const saved = await registry.save([validEntry({ id: 'custom', command: '/opt/agent' })]);
    expect(saved).toHaveLength(1);
    const raw = await readFile(join(dataDir, 'acp-backends.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 1, backends: saved });
    expect(await registry.get('custom')).toEqual(saved[0]);
    expect(await registry.get('missing')).toBeNull();
  });

  it('rejects duplicate ids and invalid entries without touching the file', async () => {
    const dataDir = await tempDir();
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await registry.save([validEntry()]);
    await expect(registry.save([validEntry(), validEntry()])).rejects.toMatchObject({
      code: 'ACP_REGISTRY_INVALID',
    });
    await expect(registry.save([{ id: 'BAD!' }])).rejects.toMatchObject({ code: 'ACP_REGISTRY_INVALID' });
    await expect(registry.save('nope')).rejects.toMatchObject({ code: 'ACP_REGISTRY_INVALID' });
    const raw = await readFile(join(dataDir, 'acp-backends.json'), 'utf8');
    expect(JSON.parse(raw).backends).toHaveLength(1);
  });

  it('reports corrupt files instead of seeding over them', async () => {
    const { writeFile } = await import('node:fs/promises');
    const dataDir = await tempDir();
    await writeFile(join(dataDir, 'acp-backends.json'), '{not json');
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => '/bin/x' });
    await expect(registry.list()).rejects.toMatchObject({ code: 'ACP_REGISTRY_CORRUPT' });
    await writeFile(join(dataDir, 'acp-backends.json'), JSON.stringify({ version: 1, backends: [{ id: 'BAD!' }] }));
    await expect(registry.list()).rejects.toMatchObject({ code: 'ACP_REGISTRY_CORRUPT' });
  });
});

describe('registry cache patch', () => {
  const tempDir = () => mkdtemp(join(tmpdir(), 'acp-reg-cache-'));

  it('patches one backend cache without disturbing concurrent PUT edits', async () => {
    const dataDir = await tempDir();
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await registry.save([validEntry(), validEntry({ id: 'second', label: 'second', command: 'second' })]);
    // Interleave a whole-registry PUT with a cache refresh: both must land.
    const [saved, patched] = await Promise.all([
      registry.save([
        validEntry({ label: 'USER EDIT', command: 'edited.exe' }),
        validEntry({ id: 'second', label: 'second', command: 'second' }),
      ]),
      registry.patchCache('omp', [{ id: 'model' }], new Date(1000).toISOString()),
    ]);
    expect(patched).toEqual({ id: 'omp', at: new Date(1000).toISOString() });
    expect(saved).toHaveLength(2);
    const entries = await registry.list();
    expect(entries.find((entry) => entry.id === 'omp')).toMatchObject({
      label: 'USER EDIT',
      command: 'edited.exe',
      cache: { configOptions: [{ id: 'model' }] },
    });
    expect(entries.find((entry) => entry.id === 'second').cache).toBeUndefined();
  });

  it('keeps a concurrent PUT when the backend was deleted mid-refresh', async () => {
    const dataDir = await tempDir();
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await registry.save([validEntry()]);
    const [saved, patched] = await Promise.all([
      registry.save([]),
      registry.patchCache('omp', [{ id: 'model' }], new Date(0).toISOString()),
    ]);
    expect(saved).toEqual([]);
    // The backend is gone: the patch is a no-op, never a resurrection.
    expect(patched).toBeNull();
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('returns null for missing backends and corrupt files', async () => {
    const { writeFile } = await import('node:fs/promises');
    const dataDir = await tempDir();
    const registry = createAcpBackendRegistry({ dataDir, resolveCommand: () => null });
    await registry.save([validEntry()]);
    await expect(registry.patchCache('missing', [], new Date(0).toISOString())).resolves.toBeNull();
    await writeFile(join(dataDir, 'acp-backends.json'), '{not json');
    await expect(registry.patchCache('omp', [], new Date(0).toISOString())).resolves.toBeNull();
    // The corrupt file is untouched (no seeding over it).
    await expect(registry.list()).rejects.toMatchObject({ code: 'ACP_REGISTRY_CORRUPT' });
  });
});
