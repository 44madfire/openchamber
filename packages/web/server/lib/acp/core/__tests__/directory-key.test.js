import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { canonicalDirectory, directoryKey, normalizeDirectory } from '../directory-key.js';

describe('acp canonical directory', () => {
  it('resolves dot segments and symlinks to one canonical path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-canon-'));
    const direct = await canonicalDirectory(root);
    expect(await canonicalDirectory(join(root, 'sub', '..'))).toBe(direct);
    expect(await canonicalDirectory(`${root}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(direct);
  });

  it('rejects relative, missing, non-directory and NUL inputs', async () => {
    await expect(canonicalDirectory('relative/project')).rejects.toMatchObject({ code: 'ACP_INVALID_DIRECTORY' });
    const missing = join(await mkdtemp(join(tmpdir(), 'acp-canon-')), 'nope');
    await expect(canonicalDirectory(missing)).rejects.toMatchObject({ code: 'ACP_INVALID_DIRECTORY' });
    const file = join(await mkdtemp(join(tmpdir(), 'acp-canon-')), 'f.txt');
    await writeFile(file, 'x');
    await expect(canonicalDirectory(file)).rejects.toMatchObject({ code: 'ACP_INVALID_DIRECTORY' });
    await expect(canonicalDirectory('/tmp\0evil')).rejects.toMatchObject({ code: 'ACP_INVALID_DIRECTORY' });
    await expect(canonicalDirectory('')).rejects.toMatchObject({ code: 'ACP_INVALID_DIRECTORY' });
  });

  it('keeps string normalization for comparison keys', () => {
    expect(normalizeDirectory('C:\\work\\')).toBe(process.platform === 'win32' ? 'C:\\work' : 'C:\\work\\');
    expect(directoryKey('a')).toBe(process.platform === 'win32' ? 'a' : 'a');
  });

  it.skipIf(process.platform !== 'win32')('rejects drive-relative and current-drive-rooted spellings', async () => {
    // `C:` must never rewrite to `C:\`; drive-relative, rooted, and
    // malformed-UNC spellings fail before normalization.
    for (const spelling of ['C:', 'C:relative', 'C:foo\\bar', '\\foo', '/foo', '\\\\server']) {
      expect(() => normalizeDirectory(spelling)).toThrowError(
        expect.objectContaining({ code: 'ACP_INVALID_DIRECTORY' }),
      );
      expect(() => directoryKey(spelling)).toThrowError(
        expect.objectContaining({ code: 'ACP_INVALID_DIRECTORY' }),
      );
      await expect(canonicalDirectory(spelling)).rejects.toMatchObject({ code: 'ACP_INVALID_DIRECTORY' });
    }
    // Fully qualified drive paths and valid UNC spellings still pass through.
    expect(normalizeDirectory('C:\\')).toBe('C:\\');
    expect(normalizeDirectory('C:\\work\\')).toBe('C:\\work');
    expect(normalizeDirectory('\\\\server\\share\\dir\\')).toBe('\\\\server\\share\\dir');
  });
});
