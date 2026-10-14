import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createAcpSessionIndex, displayTitle } from '../session-index.js';

const entry = (overrides = {}) => ({
  key: 'ses_acp-omp_rnative-1',
  backendId: 'omp',
  nativeId: 'native-1',
  cwd: 'C:\\repo',
  title: '',
  created: 1000,
  updated: 1000,
  ...overrides,
});

const tempDir = () => mkdtemp(path.join(tmpdir(), 'acp-index-'));

describe('acp session index', () => {
  it('starts empty and persists entries atomically', async () => {
    const dir = await tempDir();
    const index = createAcpSessionIndex({ dataDir: dir });
    await expect(index.listAll()).resolves.toEqual([]);
    await expect(index.get('ses_acp-omp_rnative-1')).resolves.toBeNull();

    const stored = await index.upsert('ses_acp-omp_rnative-1', entry({ title: 'hello' }));
    expect(stored.title).toBe('hello');
    await expect(index.get('ses_acp-omp_rnative-1')).resolves.toMatchObject({ title: 'hello' });

    const raw = JSON.parse(await readFile(index.filePath, 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.sessions).toHaveLength(1);
    // No temp files left behind: enumerate the directory for real.
    const files = await readdir(dir);
    expect(files).toEqual(['acp-sessions.json']);
  });

  it('keeps the previous store when the write fails mid-save', async () => {
    const dir = await tempDir();
    const real = await import('node:fs/promises');
    const healthy = createAcpSessionIndex({ dataDir: dir });
    await healthy.upsert('k', entry({ key: 'k', title: 'before' }));
    // Fail the temp write: the committed file must stay intact.
    const failingWrite = createAcpSessionIndex({
      dataDir: dir,
      fsPromises: {
        ...real,
        writeFile: async (target, ...rest) => {
          if (String(target).includes('.tmp-')) throw new Error('disk full');
          return real.writeFile(target, ...rest);
        },
      },
    });
    await expect(failingWrite.upsert('k', { title: 'after' })).rejects.toThrow('disk full');
    await expect(healthy.get('k')).resolves.toMatchObject({ title: 'before' });
    // Fail the rename: same guarantee.
    const failingRename = createAcpSessionIndex({
      dataDir: dir,
      fsPromises: { ...real, rename: async () => { throw new Error('no rename'); } },
    });
    await expect(failingRename.upsert('k', { title: 'after' })).rejects.toThrow('no rename');
    await expect(healthy.get('k')).resolves.toMatchObject({ title: 'before' });
  });

  it('merges patches over the stored entry', async () => {
    const index = createAcpSessionIndex({ dataDir: await tempDir() });
    await index.upsert('k', entry({ key: 'k', title: 'agent title', updated: 1 }));
    const merged = await index.upsert('k', { title: 'newer agent title', updated: 2 });
    expect(merged).toMatchObject({ key: 'k', backendId: 'omp', title: 'newer agent title', updated: 2 });
  });

  it('matches directories case-insensitively on Windows, exactly elsewhere', async () => {
    const index = createAcpSessionIndex({ dataDir: await tempDir() });
    await index.upsert('k', entry({ key: 'k', cwd: 'C:\\Work' }));
    const rows = await index.listByDirectory('c:\\work');
    if (process.platform === 'win32') {
      expect(rows.map((row) => row.key)).toEqual(['k']);
    } else {
      expect(rows).toEqual([]);
    }
  });

  it('lists sorted by id and filters by directory', async () => {
    const index = createAcpSessionIndex({ dataDir: await tempDir() });
    await index.upsert('ses_acp-omp_rb', entry({ key: 'ses_acp-omp_rb', nativeId: 'b', cwd: 'C:\\a' }));
    await index.upsert('ses_acp-omp_ra', entry({ key: 'ses_acp-omp_ra', nativeId: 'a', cwd: 'C:\\b' }));
    await index.upsert('ses_acp-pi-acp_rc', entry({
      key: 'ses_acp-pi-acp_rc', backendId: 'pi-acp', nativeId: 'c', cwd: 'C:\\a',
    }));
    await expect(index.listAll().then((rows) => rows.map((row) => row.key))).resolves.toEqual([
      'ses_acp-omp_ra',
      'ses_acp-omp_rb',
      'ses_acp-pi-acp_rc',
    ]);
    await expect(index.listByDirectory('C:\\a').then((rows) => rows.map((row) => row.key))).resolves.toEqual([
      'ses_acp-omp_rb',
      'ses_acp-pi-acp_rc',
    ]);
  });

  it('prefers the user title for display', () => {
    expect(displayTitle(entry({ title: 'agent', userTitle: 'mine' }))).toBe('mine');
    expect(displayTitle(entry({ title: 'agent' }))).toBe('agent');
    expect(displayTitle(null)).toBe('');
  });

  it('removes entries', async () => {
    const index = createAcpSessionIndex({ dataDir: await tempDir() });
    await index.upsert('k', entry({ key: 'k' }));
    await expect(index.remove('k')).resolves.toBe(true);
    await expect(index.remove('k')).resolves.toBe(false);
    await expect(index.listAll()).resolves.toEqual([]);
  });

  it('rejects invalid entries without writing', async () => {
    const dataDir = await tempDir();
    const index = createAcpSessionIndex({ dataDir });
    await expect(index.upsert('k', { backendId: 'NOT VALID', nativeId: 'x' })).rejects.toMatchObject({
      code: 'ACP_INDEX_INVALID',
    });
    await expect(index.listAll()).resolves.toEqual([]);
  });

  it('reports a corrupt file instead of wedging', async () => {
    const dataDir = await tempDir();
    await writeFile(path.join(dataDir, 'acp-sessions.json'), '{nope');
    const index = createAcpSessionIndex({ dataDir });
    await expect(index.listAll()).rejects.toMatchObject({ code: 'ACP_INDEX_CORRUPT' });
  });

  it('serializes concurrent mutations without losing entries', async () => {
    const index = createAcpSessionIndex({ dataDir: await tempDir() });
    await Promise.all(Array.from({ length: 10 }, (_, n) =>
      index.upsert(`k${n}`, entry({ key: `k${n}`, nativeId: `n${n}` }))));
    await expect(index.listAll().then((rows) => rows.length)).resolves.toBe(10);
  });
});
