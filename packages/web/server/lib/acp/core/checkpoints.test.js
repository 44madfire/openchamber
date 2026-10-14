import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AcpCheckpointsError, canonicalCwd, createCheckpointStore, normalizeCwd, shadowDirFor } from './checkpoints.js';

let root;
let dataDir;
let home;
let store;
// Isolated process env for every git call and store in this suite: nothing
// here may read or write the developer's real global git configuration.
let isolatedEnv;

const userGit = (cwd, args, env = isolatedEnv) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env });

const makeRepo = async (name = 'repo') => {
  const cwd = path.join(root, name);
  await fs.mkdir(cwd, { recursive: true });
  userGit(cwd, ['init', '--quiet', '.']);
  userGit(cwd, ['config', 'user.email', 'checkpoints@example.invalid']);
  userGit(cwd, ['config', 'user.name', 'Checkpoints']);
  userGit(cwd, ['config', 'commit.gpgsign', 'false']);
  return cwd;
};

const makePlain = async (name = 'plain') => {
  const cwd = path.join(root, name);
  await fs.mkdir(cwd, { recursive: true });
  return cwd;
};

const writeBytes = (cwd, file, bytes) => fs.writeFile(path.join(cwd, file), bytes);
const readBytes = (cwd, file) => fs.readFile(path.join(cwd, file));
const fwd = (p) => p.replace(/\\/g, '/');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-checkpoints-'));
  dataDir = path.join(root, 'data');
  home = path.join(root, 'home');
  await fs.mkdir(path.join(home, '.config', 'git'), { recursive: true });
  await fs.writeFile(path.join(home, 'global-gitconfig'), '');
  isolatedEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'global-gitconfig'),
    GIT_CONFIG_SYSTEM: path.join(home, 'system-gitconfig'),
  };
  store = createCheckpointStore({ dataDir, environment: isolatedEnv });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('normalizeCwd / shadowDirFor / canonicalCwd', () => {
  it('hashes the normalized cwd stably', () => {
    const dir = path.join(root, 'proj');
    expect(shadowDirFor(dataDir, dir)).toBe(shadowDirFor(dataDir, `${dir}${path.sep}`));
    expect(shadowDirFor(dataDir, dir)).not.toBe(shadowDirFor(dataDir, `${dir}-other`));
    expect(shadowDirFor(dataDir, dir).endsWith('.git')).toBe(true);
  });

  it('folds case on case-insensitive platforms', () => {
    const lower = normalizeCwd(path.join(root, 'proj'));
    const upper = normalizeCwd(path.join(root, 'PROJ'));
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(lower).toBe(upper);
    } else {
      expect(lower).not.toBe(upper);
    }
  });

  it('canonicalizes slash variants, trailing separators and case to one path', async () => {
    const cwd = await makePlain();
    const variants = [
      cwd,
      `${cwd}${path.sep}`,
      cwd.replaceAll(path.sep, path.posix.sep),
      path.join(cwd, 'subdir', '..'),
    ];
    if (process.platform === 'win32' || process.platform === 'darwin') {
      variants.push(cwd.toUpperCase());
    }
    const canonical = await Promise.all(variants.map((v) => canonicalCwd(v)));
    for (const c of canonical) expect(c).toBe(canonical[0]);
  });

  it('rejects missing paths and files', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'f.txt', 'x\n');
    await expect(canonicalCwd(path.join(cwd, 'nope'))).rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_CWD' });
    await expect(canonicalCwd(path.join(cwd, 'f.txt'))).rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_CWD' });
    await expect(canonicalCwd('')).rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_CWD' });
  });

  it('treats slash-variant cwd spellings as one project end to end', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'v1\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_slash', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'a.txt', 'v2\n');
    await writeBytes(cwd, 'added.txt', 'new\n');
    const s2 = await store.snapshot({ cwd: cwd.replaceAll(path.sep, path.posix.sep), sessionKey: 'ses_slash', turn: 1, phase: 'end' });
    expect(s2.tree).not.toBe(s1.tree);
    // Restore through a forward-slash spelling still removes the added file.
    const result = await store.restore({ cwd: `${cwd.replaceAll(path.sep, path.posix.sep)}/`, tree: s1.tree });
    expect(result.removed.map(fwd)).toContain('added.txt');
    await expect(fs.stat(path.join(cwd, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('snapshot', () => {
  it('captures a tree and records the ref', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'hello\n');
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_one', turn: 1, phase: 'start' });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    const gitDir = shadowDirFor(dataDir, cwd);
    const ref = (await fs.readFile(path.join(gitDir, 'refs', 'oc', 'ses_one', '1', 'start'), 'utf8')).trim();
    expect(ref).toBe(tree);
  });

  it('is empty-tree for an empty directory', async () => {
    const cwd = await makePlain();
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_empty', turn: 1, phase: 'start' });
    expect(tree).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });

  it('rejects invalid inputs without touching git', async () => {
    const cwd = await makePlain();
    await expect(store.snapshot({ cwd: '', sessionKey: 's', turn: 1, phase: 'start' }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_CWD' });
    await expect(store.snapshot({ cwd, sessionKey: '../escape', turn: 1, phase: 'start' }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_SESSION_KEY' });
    await expect(store.snapshot({ cwd, sessionKey: 's', turn: -1, phase: 'start' }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_TURN' });
    await expect(store.snapshot({ cwd, sessionKey: 's', turn: 1, phase: 'middle' }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_PHASE' });
    expect(store.snapshot).toBeTypeOf('function');
  });

  it('throws AcpCheckpointsError with a code', async () => {
    const cwd = await makePlain();
    const error = await store.snapshot({ cwd, sessionKey: 's', turn: 1, phase: 'nope' }).catch((e) => e);
    expect(error).toBeInstanceOf(AcpCheckpointsError);
    expect(error).toBeInstanceOf(Error);
  });

  it('captures a 348-char relative path and restores it exactly', async () => {
    const cwd = await makePlain();
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}/${'g'.repeat(60)}/${'h'.repeat(100)}.txt`;
    expect(deep.length).toBeGreaterThan(300);
    await fs.mkdir(path.dirname(path.join(cwd, deep)), { recursive: true });
    await writeBytes(cwd, deep, 'deep-bytes\n');
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_long', turn: 1, phase: 'start' });
    // The reviewer caught a silent empty tree here when long paths are off.
    expect(tree).not.toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    await fs.rm(path.join(cwd, deep));
    const result = await store.restore({ cwd, tree });
    expect(result.restored.map(fwd)).toContain(deep);
    expect(await readBytes(cwd, deep)).toEqual(Buffer.from('deep-bytes\n'));
  });
});

// Three snapshots across edits, adds, deletes and a rename — in a git repo
// with uncommitted changes and in a plain folder — then diff and restore.
describe.each([
  ['git repo', makeRepo],
  ['plain folder', makePlain],
])('three turns in a %s', (_label, makeCwd) => {
  it('diffs each turn and restores turn 1 byte-exactly', async () => {
    const cwd = await makeCwd();
    const key = 'ses_turns';
    const binV1 = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const crlfV1 = Buffer.from('alpha\r\nbeta\r\n', 'utf8');

    // Turn 1 start: baseline with text, CRLF, binary, a subdir file, and a
    // path with spaces (per-file patch splitting must survive it).
    await writeBytes(cwd, 'edit.txt', 'line1\nline2\nline3\n');
    await writeBytes(cwd, 'crlf.txt', crlfV1);
    await writeBytes(cwd, 'blob.bin', binV1);
    await fs.mkdir(path.join(cwd, 'sub'), { recursive: true });
    await writeBytes(cwd, path.join('sub', 'keep.txt'), 'keep\n');
    await writeBytes(cwd, 'file one.txt', 'a\n');
    const t1 = await store.snapshot({ cwd, sessionKey: key, turn: 1, phase: 'start' });

    // Turn 1 end: edit, add, delete.
    await writeBytes(cwd, 'edit.txt', 'line1\nline2 changed\nline3\nline4\n');
    await writeBytes(cwd, 'added.txt', 'brand new\n');
    await writeBytes(cwd, 'file one.txt', 'a\nb\n');
    await fs.rm(path.join(cwd, 'sub', 'keep.txt'));
    const t2 = await store.snapshot({ cwd, sessionKey: key, turn: 1, phase: 'end' });

    // Turn 2 end: rename, CRLF edit, binary edit.
    await fs.rename(path.join(cwd, 'edit.txt'), path.join(cwd, 'renamed.txt'));
    await writeBytes(cwd, 'crlf.txt', Buffer.from('alpha\r\nbeta CHANGED\r\ngamma\r\n', 'utf8'));
    const binV2 = Buffer.concat([binV1, Buffer.from([9, 9, 9])]);
    await writeBytes(cwd, 'blob.bin', binV2);
    const t3 = await store.snapshot({ cwd, sessionKey: key, turn: 2, phase: 'end' });

    // Turn 1 diff: modified + added + deleted, with exact counts.
    const d1 = await store.diff({ cwd, from: t1.tree, to: t2.tree });
    expect(d1.map((e) => [e.file, e.status, e.additions, e.deletions])).toEqual([
      ['added.txt', 'added', 1, 0],
      ['edit.txt', 'modified', 2, 1],
      ['file one.txt', 'modified', 1, 0],
      ['sub/keep.txt', 'deleted', 0, 1],
    ]);
    const editPatch = d1.find((e) => e.file === 'edit.txt').patch;
    expect(editPatch).toContain('diff --git a/edit.txt b/edit.txt');
    expect(editPatch).toContain('-line2\n+line2 changed\n');
    expect(editPatch).toContain('+line4\n');
    expect(d1.find((e) => e.file === 'added.txt').patch).toContain('new file mode');
    expect(d1.find((e) => e.file === 'sub/keep.txt').patch).toContain('deleted file mode');
    // Every patch starts with `diff --git `: that is the shape
    // `createTextDiffDataFromPatch` in DiffView.tsx parses per file.
    for (const entry of d1) expect(entry.patch.startsWith('diff --git ')).toBe(true);
    // Turn 2 diff: rename surfaces as delete + add (no rename status: the
    // UI shape has added/deleted/modified only), binary counts as 0/0.
    const d2 = await store.diff({ cwd, from: t2.tree, to: t3.tree });
    const byFile = new Map(d2.map((e) => [e.file, e]));
    expect([...byFile.keys()].sort()).toEqual(['blob.bin', 'crlf.txt', 'edit.txt', 'renamed.txt']);
    expect(byFile.get('edit.txt').status).toBe('deleted');
    expect(byFile.get('renamed.txt').status).toBe('added');
    expect(byFile.get('blob.bin').status).toBe('modified');
    expect([byFile.get('blob.bin').additions, byFile.get('blob.bin').deletions]).toEqual([0, 0]);
    expect(byFile.get('blob.bin').patch).toMatch(/^Binary files .+ differ$/m);
    expect(byFile.get('crlf.txt').status).toBe('modified');

    // Restore to turn 1 start: bytes exact, added files gone. `current`
    // defaults to the latest snapshot state, so added.txt (in t3's state)
    // and renamed.txt are members to delete.
    const result = await store.restore({ cwd, tree: t1.tree });
    expect(new Set(result.restored)).toEqual(
      new Set(['blob.bin', 'crlf.txt', 'edit.txt', 'file one.txt', 'sub/keep.txt']),
    );
    expect(new Set(result.removed)).toEqual(new Set(['added.txt', 'renamed.txt']));
    expect(result.skipped).toEqual([]);
    expect(await readBytes(cwd, 'edit.txt')).toEqual(Buffer.from('line1\nline2\nline3\n'));
    expect(await readBytes(cwd, 'file one.txt')).toEqual(Buffer.from('a\n'));
    expect(await readBytes(cwd, 'crlf.txt')).toEqual(crlfV1);
    expect(await readBytes(cwd, 'blob.bin')).toEqual(binV1);
    expect(await readBytes(cwd, path.join('sub', 'keep.txt'))).toEqual(Buffer.from('keep\n'));
    await expect(fs.stat(path.join(cwd, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(cwd, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Restored state snapshots to the identical tree.
    const again = await store.snapshot({ cwd, sessionKey: key, turn: 9, phase: 'start' });
    expect(again.tree).toBe(t1.tree);
    expect(await store.diff({ cwd, from: t1.tree, to: t1.tree })).toEqual([]);
  });
});

describe('ignores', () => {
  it('never stages .gitignore matches, info/exclude matches, or .git itself', async () => {
    const cwd = await makeRepo();
    await writeBytes(cwd, '.gitignore', '*.tmp\nbuild/\n');
    await fs.appendFile(path.join(cwd, '.git', 'info', 'exclude'), 'via-exclude.txt\n');
    await writeBytes(cwd, 'tracked.txt', 'tracked\n');
    await writeBytes(cwd, 'skip.tmp', 'v1\n');
    await writeBytes(cwd, 'via-exclude.txt', 'v1\n');
    await fs.mkdir(path.join(cwd, 'build'), { recursive: true });
    await writeBytes(cwd, path.join('build', 'out.js'), 'v1\n');
    const before = await store.snapshot({ cwd, sessionKey: 'ses_ign', turn: 1, phase: 'start' });

    await writeBytes(cwd, 'skip.tmp', 'MUTATED\n');
    await writeBytes(cwd, 'via-exclude.txt', 'MUTATED\n');
    await writeBytes(cwd, path.join('build', 'out.js'), 'MUTATED\n');
    await writeBytes(cwd, 'tracked.txt', 'changed\n');
    const after = await store.snapshot({ cwd, sessionKey: 'ses_ign', turn: 1, phase: 'end' });

    const d = await store.diff({ cwd, from: before.tree, to: after.tree });
    expect(d.map((e) => e.file)).toEqual(['tracked.txt']);

    const result = await store.restore({ cwd, tree: before.tree });
    expect(result.restored).toEqual(['tracked.txt']);
    // Ignored files are untouched by the restore.
    expect(await readBytes(cwd, 'skip.tmp')).toEqual(Buffer.from('MUTATED\n'));
    expect(await readBytes(cwd, 'via-exclude.txt')).toEqual(Buffer.from('MUTATED\n'));
    expect(await readBytes(cwd, path.join('build', 'out.js'))).toEqual(Buffer.from('MUTATED\n'));
    expect(await readBytes(cwd, 'tracked.txt')).toEqual(Buffer.from('tracked\n'));
  });

  it('honors the default XDG global ignore even when info/exclude exists', async () => {
    const cwd = await makeRepo();
    await fs.writeFile(path.join(home, '.config', 'git', 'ignore'), 'secret.txt\n');
    await fs.appendFile(path.join(cwd, '.git', 'info', 'exclude'), 'local-excluded.txt\n');
    await writeBytes(cwd, 'secret.txt', 'v1\n');
    await writeBytes(cwd, 'local-excluded.txt', 'v1\n');
    await writeBytes(cwd, 'kept.txt', 'v1\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_xdg', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'secret.txt', 'MUTATED\n');
    await writeBytes(cwd, 'local-excluded.txt', 'MUTATED\n');
    await writeBytes(cwd, 'kept.txt', 'MUTATED\n');
    const s2 = await store.snapshot({ cwd, sessionKey: 'ses_xdg', turn: 1, phase: 'end' });
    // Only the kept file appears: default-global and repo-local both applied.
    expect((await store.diff({ cwd, from: s1.tree, to: s2.tree })).map((e) => e.file)).toEqual(['kept.txt']);
  });

  it('honors a configured ~/ excludesFile with tilde expansion', async () => {
    const cwd = await makeRepo();
    await writeBytes(home, 'my-global-ignore', 'global-*.xyz\n');
    userGit(cwd, ['config', '--global', 'core.excludesFile', '~/my-global-ignore']);
    await fs.appendFile(path.join(cwd, '.git', 'info', 'exclude'), 'local-excluded.txt\n');
    await writeBytes(cwd, 'global-1.xyz', 'x\n');
    await writeBytes(cwd, 'local-excluded.txt', 'x\n');
    await writeBytes(cwd, 'kept.txt', 'x\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_tilde', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'global-1.xyz', 'MUTATED\n');
    await writeBytes(cwd, 'local-excluded.txt', 'MUTATED\n');
    const s2 = await store.snapshot({ cwd, sessionKey: 'ses_tilde', turn: 1, phase: 'end' });
    expect(await store.diff({ cwd, from: s1.tree, to: s2.tree })).toEqual([]);
  });

  it('honors the common info/exclude inside a linked worktree', async () => {
    const repo = await makeRepo('main');
    await writeBytes(repo, 'f.txt', 'x\n');
    userGit(repo, ['add', '-A']);
    userGit(repo, ['commit', '--quiet', '-m', 'init']);
    await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), 'wt-excluded.txt\n');
    const wt = path.join(root, 'wt');
    userGit(repo, ['worktree', 'add', wt]);
    await writeBytes(wt, 'wt-excluded.txt', 'v1\n');
    await writeBytes(wt, 'wt-kept.txt', 'v1\n');
    const s1 = await store.snapshot({ cwd: wt, sessionKey: 'ses_wt', turn: 1, phase: 'start' });
    await writeBytes(wt, 'wt-excluded.txt', 'MUTATED\n');
    await writeBytes(wt, 'wt-kept.txt', 'MUTATED\n');
    const s2 = await store.snapshot({ cwd: wt, sessionKey: 'ses_wt', turn: 1, phase: 'end' });
    expect((await store.diff({ cwd: wt, from: s1.tree, to: s2.tree })).map((e) => e.file)).toEqual(['wt-kept.txt']);
  });

  it('honors excludesFile set through a global [include]', async () => {
    const cwd = await makePlain('include');
    await writeBytes(home, 'inc-ignores', 'via-include.txt\n');
    await writeBytes(home, 'inc.conf', '[core]\n\texcludesFile = ~/inc-ignores\n');
    await fs.writeFile(path.join(home, 'global-gitconfig'), '[include]\n\tpath = inc.conf\n');
    await writeBytes(cwd, 'via-include.txt', 'v1\n');
    await writeBytes(cwd, 'kept.txt', 'v1\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_inc', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'via-include.txt', 'MUTATED\n');
    await writeBytes(cwd, 'kept.txt', 'MUTATED\n');
    const s2 = await store.snapshot({ cwd, sessionKey: 'ses_inc', turn: 1, phase: 'end' });
    expect((await store.diff({ cwd, from: s1.tree, to: s2.tree })).map((e) => e.file)).toEqual(['kept.txt']);
  });

  it('honors excludesFile set through includeIf for matching projects only', async () => {
    const inRepo = path.join(home, 'work', 'inrepo');
    await fs.mkdir(inRepo, { recursive: true });
    userGit(inRepo, ['init', '--quiet', '.']);
    const outRepo = await makeRepo('outrepo');
    await writeBytes(home, 'inc-ignores', 'via-includeif.txt\n');
    await writeBytes(home, 'inc.conf', '[core]\n\texcludesFile = ~/inc-ignores\n');
    await fs.writeFile(path.join(home, 'global-gitconfig'), '[includeIf "gitdir:~/work/"]\n\tpath = inc.conf\n');
    for (const cwd of [inRepo, outRepo]) {
      await writeBytes(cwd, 'via-includeif.txt', 'v1\n');
      await writeBytes(cwd, 'kept.txt', 'v1\n');
    }
    const s1in = await store.snapshot({ cwd: inRepo, sessionKey: 'ses_if_in', turn: 1, phase: 'start' });
    const s1out = await store.snapshot({ cwd: outRepo, sessionKey: 'ses_if_out', turn: 1, phase: 'start' });
    for (const cwd of [inRepo, outRepo]) {
      await writeBytes(cwd, 'via-includeif.txt', 'MUTATED\n');
      await writeBytes(cwd, 'kept.txt', 'MUTATED\n');
    }
    const s2in = await store.snapshot({ cwd: inRepo, sessionKey: 'ses_if_in', turn: 1, phase: 'end' });
    const s2out = await store.snapshot({ cwd: outRepo, sessionKey: 'ses_if_out', turn: 1, phase: 'end' });
    expect((await store.diff({ cwd: inRepo, from: s1in.tree, to: s2in.tree })).map((e) => e.file)).toEqual(['kept.txt']);
    expect((await store.diff({ cwd: outRepo, from: s1out.tree, to: s2out.tree })).map((e) => e.file).sort())
      .toEqual(['kept.txt', 'via-includeif.txt']);
  });

  it('lets GIT_CONFIG_GLOBAL replacement win over ~/.gitconfig', async () => {
    const cwd = await makePlain('globalvar');
    await writeBytes(home, 'dot-ignores', 'from-dotconfig.txt\n');
    await writeBytes(home, 'var-ignores', 'from-globalvar.txt\n');
    await fs.writeFile(path.join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/dot-ignores\n');
    await fs.writeFile(path.join(home, 'global-gitconfig'), '[core]\n\texcludesFile = ~/var-ignores\n');
    await writeBytes(cwd, 'from-dotconfig.txt', 'v1\n');
    await writeBytes(cwd, 'from-globalvar.txt', 'v1\n');
    await writeBytes(cwd, 'kept.txt', 'v1\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_gv', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'from-dotconfig.txt', 'MUTATED\n');
    await writeBytes(cwd, 'from-globalvar.txt', 'MUTATED\n');
    await writeBytes(cwd, 'kept.txt', 'MUTATED\n');
    const s2 = await store.snapshot({ cwd, sessionKey: 'ses_gv', turn: 1, phase: 'end' });
    // GIT_CONFIG_GLOBAL replaces ~/.gitconfig: only its rule applies.
    expect((await store.diff({ cwd, from: s1.tree, to: s2.tree })).map((e) => e.file).sort())
      .toEqual(['from-dotconfig.txt', 'kept.txt']);
  });
});
describe('attributes', () => {
  it('captures work-tree bytes exactly despite worktree and global attributes', async () => {
    const cwd = await makePlain('attrs');
    await writeBytes(home, 'global-attrs', '*.txt text eol=lf\n');
    userGit(cwd, ['config', '--global', 'core.attributesFile', path.join(home, 'global-attrs')]);
    await writeBytes(cwd, '.gitattributes', '*.bin text eol=lf\n*.md ident\n');
    const crlf = Buffer.from('alpha\r\nbeta\r\n', 'utf8');
    const bin = Buffer.from([0, 1, 2, 250, 13, 10, 255]);
    await writeBytes(cwd, 'crlf.txt', crlf);
    await writeBytes(cwd, 'data.bin', bin);
    await writeBytes(cwd, 'doc.md', 'v $Id$\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_attr', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'crlf.txt', 'MUT\n');
    await writeBytes(cwd, 'data.bin', 'MUT\n');
    await writeBytes(cwd, 'doc.md', 'MUT\n');
    const result = await store.restore({ cwd, tree: s1.tree });
    expect(new Set(result.restored)).toEqual(new Set(['crlf.txt', 'data.bin', 'doc.md']));
    expect(await readBytes(cwd, 'crlf.txt')).toEqual(crlf);
    expect(await readBytes(cwd, 'data.bin')).toEqual(bin);
    expect(await readBytes(cwd, 'doc.md')).toEqual(Buffer.from('v $Id$\n'));
  });
});

describe('user repo isolation', () => {
  it('leaves git status, index, HEAD, refs, config and hooks untouched', async () => {
    const cwd = await makeRepo();
    await writeBytes(cwd, 'f.txt', 'v1\n');
    userGit(cwd, ['add', '-A']);
    userGit(cwd, ['commit', '--quiet', '-m', 'init']);
    await writeBytes(cwd, 'f.txt', 'v2 uncommitted\n');
    await writeBytes(cwd, 'new.txt', 'untracked\n');

    const marker = path.join(cwd, '.git', 'hook-ran-marker');
    const markerShell = fwd(marker);

    // Baseline reads first: `git status` refreshes the index, which would
    // fire the hooks planted below (that is the control at the end: the
    // hooks do run for ordinary git once planted).
    const headBefore = userGit(cwd, ['rev-parse', 'HEAD']).trim();
    const statusBefore = userGit(cwd, ['status', '--porcelain']);
    const refsBefore = userGit(cwd, ['for-each-ref']);
    const configBefore = await readBytes(path.join(cwd, '.git'), 'config');
    const configMtimeBefore = (await fs.stat(path.join(cwd, '.git', 'config'))).mtimeMs;
    const indexBefore = await readBytes(path.join(cwd, '.git'), 'index');
    const indexMtimeBefore = (await fs.stat(path.join(cwd, '.git', 'index'))).mtimeMs;

    // A repo-level hooksPath must not redirect our isolation either.
    const evilHooks = path.join(root, 'evil-hooks');
    await fs.mkdir(evilHooks, { recursive: true });
    await writeBytes(evilHooks, 'post-index-change', `#!/bin/sh\necho FIRED > "${markerShell}"\n`);
    await fs.chmod(path.join(evilHooks, 'post-index-change'), 0o755);
    userGit(cwd, ['config', 'core.hooksPath', evilHooks]);
    const configWithHooks = await readBytes(path.join(cwd, '.git'), 'config');

    // Hooks that write a marker if they ever fire.
    for (const hook of ['post-index-change', 'reference-transaction', 'post-checkout', 'pre-commit']) {
      const file = path.join(cwd, '.git', 'hooks', hook);
      await writeBytes(path.join(cwd, '.git', 'hooks'), hook, `#!/bin/sh\necho FIRED > "${markerShell}"\n`);
      await fs.chmod(file, 0o755);
    }

    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_iso', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'f.txt', 'v3\n');
    await writeBytes(cwd, 'added-after.txt', 'x\n');
    const s2 = await store.snapshot({ cwd, sessionKey: 'ses_iso', turn: 1, phase: 'end' });
    expect((await store.diff({ cwd, from: s1.tree, to: s2.tree })).length).toBeGreaterThan(0);
    await store.restore({ cwd, tree: s1.tree });
    await store.gc({ sessionKey: 'ses_iso', cwd });

    // Marker first: the `git status` below refreshes the index itself, which fires
    // post-index-change through the planted hooks (see the control at the end).
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(userGit(cwd, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(userGit(cwd, ['for-each-ref'])).toBe(refsBefore);
    expect(await readBytes(path.join(cwd, '.git'), 'config')).toEqual(configWithHooks);
    expect(configBefore.equals(configWithHooks)).toBe(false);
    expect(await readBytes(path.join(cwd, '.git'), 'index')).toEqual(indexBefore);
    expect((await fs.stat(path.join(cwd, '.git', 'index'))).mtimeMs).toBe(indexMtimeBefore);
    // Status shows the restore's work-tree effect only: v2 back, added file gone.
    expect(userGit(cwd, ['status', '--porcelain'])).toBe(statusBefore);
    await expect(fs.stat(path.join(cwd, '.git', 'config.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Control: the hooks are live — an ordinary index write through the
    // evil hooksPath fires post-index-change deterministically (no
    // stat-cache timing involved).
    await writeBytes(cwd, 'f.txt', 'control touch\n');
    userGit(cwd, ['add', '--', 'f.txt']);
    expect(await fs.readFile(marker, 'utf8')).toBe('FIRED\n');
  });

  it('scrubs inherited GIT_* vars that would redirect our git', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'x\n');
    const decoy = path.join(root, 'decoy');
    await fs.mkdir(decoy, { recursive: true });
    const userRepo = await makeRepo('config-victim');
    const userConfig = path.join(userRepo, '.git', 'config');
    const configBefore = await readBytes(path.join(userRepo, '.git'), 'config');
    const configMtimeBefore = (await fs.stat(userConfig)).mtimeMs;
    const poisoned = createCheckpointStore({
      dataDir,
      environment: {
        ...isolatedEnv,
        GIT_DIR: decoy,
        GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: path.join(decoy, 'index'),
        GIT_CEILING_DIRECTORIES: path.dirname(cwd),
        GIT_CONFIG: userConfig,
        git_config_global: path.join(decoy, 'global'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.bare',
        GIT_CONFIG_VALUE_0: 'true',
      },
    });
    const { tree } = await poisoned.snapshot({ cwd, sessionKey: 'ses_env', turn: 1, phase: 'start' });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(await fs.stat(decoy).then((s) => s.isDirectory())).toBe(true);
    expect(await fs.readdir(decoy)).toEqual([]);
    // The victim config is byte- and mtime-identical; no lock left behind.
    expect(await readBytes(path.join(userRepo, '.git'), 'config')).toEqual(configBefore);
    expect((await fs.stat(userConfig)).mtimeMs).toBe(configMtimeBefore);
    await expect(fs.stat(`${userConfig}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('restore', () => {
  it('rejects unknown and malformed trees', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'x\n');
    await expect(store.restore({ cwd, tree: '0'.repeat(40) }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_UNKNOWN_TREE' });
    await expect(store.restore({ cwd, tree: 'not-a-tree' }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_TREE' });
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_cur', turn: 1, phase: 'start' });
    await expect(store.restore({ cwd, tree: s1.tree, current: 'zzz' }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_TREE' });
  });

  it('restores deleted directories and removes added files', async () => {
    const cwd = await makePlain();
    await fs.mkdir(path.join(cwd, 'gone', 'deep'), { recursive: true });
    await writeBytes(cwd, path.join('gone', 'deep', 'a.txt'), 'g1\n');
    await writeBytes(cwd, path.join('gone', 'b.txt'), 'g2\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_dirs', turn: 1, phase: 'start' });
    await fs.rm(path.join(cwd, 'gone'), { recursive: true });
    await fs.mkdir(path.join(cwd, 'newdir'), { recursive: true });
    await writeBytes(cwd, path.join('newdir', 'n.txt'), 'added\n');
    // Latest-snapshot membership comes from an explicit snapshot of the
    // changed state (the turn-end snapshot in real use).
    const s2 = await store.snapshot({ cwd, sessionKey: 'ses_dirs', turn: 1, phase: 'end' });
    const result = await store.restore({ cwd, tree: s1.tree, current: s2.tree });
    expect(new Set(result.restored)).toEqual(new Set([fwd(path.join('gone', 'b.txt')), fwd(path.join('gone', 'deep', 'a.txt'))]));
    expect(result.removed.map(fwd)).toContain('newdir/n.txt');
    expect(await readBytes(cwd, path.join('gone', 'deep', 'a.txt'))).toEqual(Buffer.from('g1\n'));
    // The added file is gone; its now-empty parent dir remains, as with git.
    await expect(fs.stat(path.join(cwd, 'newdir', 'n.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never deletes files that were never snapshotted', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'v1\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_never', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'a.txt', 'v2\n');
    await writeBytes(cwd, 'user-never-snapshotted.txt', 'mine\n');
    // Restore without a new snapshot: the never-member file survives.
    const result = await store.restore({ cwd, tree: s1.tree });
    expect(result.removed).toEqual([]);
    expect(await readBytes(cwd, 'user-never-snapshotted.txt')).toEqual(Buffer.from('mine\n'));
    expect(await readBytes(cwd, 'a.txt')).toEqual(Buffer.from('v1\n'));
  });

  it('refuses to delete a current member hidden by a new ignore rule', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'keep.txt', 'k\n');
    const t1 = await store.snapshot({ cwd, sessionKey: 'ses_hide', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'added.txt', 'added\n');
    const t2 = await store.snapshot({ cwd, sessionKey: 'ses_hide', turn: 1, phase: 'end' });
    await writeBytes(cwd, '.gitignore', 'added.txt\n');
    const result = await store.restore({ cwd, tree: t1.tree, current: t2.tree });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ file: 'added.txt', reason: 'ignored' }]);
    expect(await readBytes(cwd, 'added.txt')).toEqual(Buffer.from('added\n'));
    // The never-member .gitignore itself is kept too.
    expect(await readBytes(cwd, '.gitignore')).toEqual(Buffer.from('added.txt\n'));
  });

  it('refuses to overwrite a target member hidden by a new ignore rule', async () => {
    const cwd = await makePlain('hide-target');
    await writeBytes(cwd, 'a.txt', 'original\n');
    const t1 = await store.snapshot({ cwd, sessionKey: 'ses_hide_t', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'a.txt', 'precious newly ignored\n');
    await writeBytes(cwd, '.gitignore', 'a.txt\n');
    const result = await store.restore({ cwd, tree: t1.tree });
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ file: 'a.txt', reason: 'ignored' }]);
    expect(await readBytes(cwd, 'a.txt')).toEqual(Buffer.from('precious newly ignored\n'));
  });

  it('does not delete a newly-appeared nested repo', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'x\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_nested', turn: 1, phase: 'start' });
    const nested = path.join(cwd, 'fresh-repo');
    await fs.mkdir(nested, { recursive: true });
    userGit(nested, ['init', '--quiet', '.']);
    await writeBytes(nested, 'inner.txt', 'inner\n');
    const s2 = await store.snapshot({ cwd, sessionKey: 'ses_nested', turn: 1, phase: 'end' });
    const result = await store.restore({ cwd, tree: s1.tree, current: s2.tree });
    // The nested repo survives the restore untouched.
    expect(await readBytes(nested, 'inner.txt')).toEqual(Buffer.from('inner\n'));
    expect(result.removed.map(fwd)).not.toContain('fresh-repo/inner.txt');
  });

  it('refuses to restore through a junction parent and leaves outside files alone', async () => {
    if (process.platform !== 'win32') return;
    const cwd = await makePlain('junction');
    await fs.mkdir(path.join(cwd, 'd'), { recursive: true });
    await writeBytes(cwd, path.join('d', 'f.txt'), 'original\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_junction', turn: 1, phase: 'start' });
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await writeBytes(outside, 'f.txt', 'outside precious\n');
    await fs.rm(path.join(cwd, 'd'), { recursive: true });
    const { execSync } = await import('node:child_process');
    execSync(`mklink /J ${JSON.stringify(path.join(cwd, 'd'))} ${JSON.stringify(outside)}`);
    const result = await store.restore({ cwd, tree: s1.tree });
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ file: 'd/f.txt', reason: 'obstructed-ancestor' }]);
    expect(await readBytes(outside, 'f.txt')).toEqual(Buffer.from('outside precious\n'));
  });

  it('refuses to restore through a symlink parent and leaves outside files alone', async () => {
    if (process.platform === 'win32') return;
    const cwd = await makePlain('symlink-parent');
    await fs.mkdir(path.join(cwd, 'd'), { recursive: true });
    await writeBytes(cwd, path.join('d', 'f.txt'), 'original\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_symlink', turn: 1, phase: 'start' });
    const outside = path.join(root, 'outside-posix');
    await fs.mkdir(outside, { recursive: true });
    await writeBytes(outside, 'f.txt', 'outside precious\n');
    await fs.rm(path.join(cwd, 'd'), { recursive: true });
    await fs.symlink(outside, path.join(cwd, 'd'), 'dir');
    const result = await store.restore({ cwd, tree: s1.tree });
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ file: 'd/f.txt', reason: 'obstructed-ancestor' }]);
    expect(await readBytes(outside, 'f.txt')).toEqual(Buffer.from('outside precious\n'));
  });

  it('refuses to replace a directory holding a nested repo or unknown files', async () => {
    const cwd = await makePlain('obstruct');
    await writeBytes(cwd, 'a.txt', 'scalar\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_obstruct', turn: 1, phase: 'start' });
    await fs.rm(path.join(cwd, 'a.txt'));
    await fs.mkdir(path.join(cwd, 'a.txt'), { recursive: true });
    userGit(path.join(cwd, 'a.txt'), ['init', '--quiet', '.']);
    await writeBytes(path.join(cwd, 'a.txt'), 'precious.txt', 'never snapshotted\n');
    const result = await store.restore({ cwd, tree: s1.tree });
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ file: 'a.txt', reason: 'nested-repo' }]);
    expect(await fs.stat(path.join(cwd, 'a.txt', '.git')).then(() => true)).toBe(true);
    expect(await readBytes(path.join(cwd, 'a.txt'), 'precious.txt')).toEqual(Buffer.from('never snapshotted\n'));
  });

  it('refuses writes and deletes under a newly-initialized nested repo ancestor', async () => {
    const cwd = await makePlain('nested-ancestor');
    await fs.mkdir(path.join(cwd, 'd'), { recursive: true });
    await writeBytes(cwd, path.join('d', 'f.txt'), 'original\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_nanc', turn: 1, phase: 'start' });
    await writeBytes(cwd, path.join('d', 'added.txt'), 'added\n');
    const s2 = await store.snapshot({ cwd, sessionKey: 'ses_nanc', turn: 1, phase: 'end' });
    userGit(path.join(cwd, 'd'), ['init', '--quiet', '.']);
    await writeBytes(cwd, path.join('d', 'f.txt'), 'nested repo precious\n');
    const result = await store.restore({ cwd, tree: s1.tree, current: s2.tree });
    expect(result.restored).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(new Set(result.skipped.map((s) => `${s.file}:${s.reason}`))).toEqual(new Set([
      'd/f.txt:nested-repo',
      'd/added.txt:nested-repo',
    ]));
    expect(await readBytes(cwd, path.join('d', 'f.txt'))).toEqual(Buffer.from('nested repo precious\n'));
    expect(await readBytes(cwd, path.join('d', 'added.txt'))).toEqual(Buffer.from('added\n'));
  });

  it('serializes concurrent snapshots on one project', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'x\n');
    const results = await Promise.all([
      store.snapshot({ cwd, sessionKey: 'ses_race', turn: 1, phase: 'start' }),
      store.snapshot({ cwd, sessionKey: 'ses_race', turn: 2, phase: 'start' }),
      store.snapshot({ cwd, sessionKey: 'ses_race', turn: 3, phase: 'start' }),
    ]);
    expect(new Set(results.map((r) => r.tree)).size).toBe(1);
    const gitDir = shadowDirFor(dataDir, cwd);
    for (const turn of [1, 2, 3]) {
      const ref = (await fs.readFile(path.join(gitDir, 'refs', 'oc', 'ses_race', String(turn), 'start'), 'utf8')).trim();
      expect(ref).toBe(results[0].tree);
    }
  });

  it('serializes concurrent snapshots across two store instances', async () => {
    const cwd = await makePlain('twostore');
    await fs.mkdir(path.join(cwd, 'many'), { recursive: true });
    for (let i = 0; i < 200; i += 1) {
      await writeBytes(cwd, path.join('many', `f${i}.txt`), `v1-${i}\n`);
    }
    const other = createCheckpointStore({ dataDir, environment: isolatedEnv });
    await store.snapshot({ cwd, sessionKey: 'ses_two', turn: 1, phase: 'start' });
    for (let i = 0; i < 200; i += 1) {
      await writeBytes(cwd, path.join('many', `f${i}.txt`), `v2-${i}\n`);
    }
    // Mutate between the two racing snapshots to force real index work.
    const [r1, r2] = await Promise.all([
      store.snapshot({ cwd, sessionKey: 'ses_two', turn: 2, phase: 'start' }),
      other.snapshot({ cwd, sessionKey: 'ses_two', turn: 3, phase: 'start' }),
    ]);
    expect(r1.tree).toBe(r2.tree);
    expect(r1.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('recovers a lock left by a dead owner', async () => {
    const cwd = await makePlain('deadlock');
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_dead', turn: 1, phase: 'start' });
    const gitDir = shadowDirFor(dataDir, cwd);
    // A lock from a genuinely dead owner: spawn a child and use its pid
    // after it exits (pid reuse within the test is negligible, and the
    // recheck guards it anyway).
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    expect(probe.status).toBe(0);
    const deadPid = probe.pid;
    await fs.writeFile(path.join(gitDir, 'openchamber-acp.lock'), `${deadPid}:dead-op`);
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_dead', turn: 2, phase: 'start' });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.stat(path.join(gitDir, 'openchamber-acp.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a malformed lock file', async () => {
    const cwd = await makePlain('badlock');
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_bad', turn: 1, phase: 'start' });
    const gitDir = shadowDirFor(dataDir, cwd);
    await fs.writeFile(path.join(gitDir, 'openchamber-acp.lock'), 'not-a-pid:???');
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_bad', turn: 2, phase: 'start' });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('recovers a dead owner plus its abandoned index.lock', async () => {
    const cwd = await makePlain('crashlock');
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_crash', turn: 1, phase: 'start' });
    const gitDir = shadowDirFor(dataDir, cwd);
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    expect(probe.status).toBe(0);
    // A crash mid-`git add`: stale ownership lock plus the index.lock the
    // interrupted git left behind, aged past the live-git window. Both
    // must clear for snapshots to resume.
    await fs.writeFile(path.join(gitDir, 'openchamber-acp.lock'), `${probe.pid}:crashed-op`);
    const indexLock = path.join(gitDir, 'index.lock');
    await fs.writeFile(indexLock, 'stale');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(indexLock, old, old);
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_crash', turn: 2, phase: 'start' });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.stat(indexLock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers an interrupted checkpoint ref lock deep under refs/oc', async () => {
    const cwd = await makePlain('refcrash');
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_ref', turn: 1, phase: 'start' });
    const gitDir = shadowDirFor(dataDir, cwd);
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    await fs.writeFile(path.join(gitDir, 'openchamber-acp.lock'), `${probe.pid}:crashed-op`);
    const refLock = path.join(gitDir, 'refs', 'oc', 'ses_ref', '2', 'start.lock');
    await fs.mkdir(path.dirname(refLock), { recursive: true });
    await fs.writeFile(refLock, 'stale');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(refLock, old, old);
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_ref', turn: 2, phase: 'start' });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.stat(refLock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails retryable BUSY on fresh git locks and retries after they age', async () => {
    const cwd = await makePlain('busylock');
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_busy', turn: 1, phase: 'start' });
    const gitDir = shadowDirFor(dataDir, cwd);
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    await fs.writeFile(path.join(gitDir, 'openchamber-acp.lock'), `${probe.pid}:crashed-op`);
    const indexLock = path.join(gitDir, 'index.lock');
    await fs.writeFile(indexLock, 'fresh — a git child may still live');
    // Fresh lock: BUSY, and no live ownership leaks (the stale identity is
    // restored so a later retry reclaims).
    await expect(store.snapshot({ cwd, sessionKey: 'ses_busy', turn: 2, phase: 'start' }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_BUSY' });
    expect(await fs.readFile(path.join(gitDir, 'openchamber-acp.lock'), 'utf8')).toBe(`${probe.pid}:crashed-op`);
    await expect(fs.stat(indexLock)).resolves.toBeTruthy();
    // Aged past the window: the retry reclaims and succeeds.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(indexLock, old, old);
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_busy', turn: 2, phase: 'start' });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('keeps two processes from owning one repo during simultaneous recovery', async () => {
    const cwd = await makePlain('twoproc');
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_2p', turn: 1, phase: 'start' });
    const gitDir = shadowDirFor(dataDir, cwd);
    const { spawnSync, spawn } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    await fs.writeFile(path.join(gitDir, 'openchamber-acp.lock'), `${probe.pid}:dead-op`);
    // Two separate processes race to reclaim the same stale lock. Both
    // must succeed (serialized) — verified by both snapshots landing
    // distinct refs, which is impossible under dual ownership (the warm
    // index write would collide with index.lock).
    const worker = (turn) => new Promise((resolve, reject) => {
      const script = [
        'const { createCheckpointStore } = await import(String(process.argv[1]));',
        'const store = createCheckpointStore({ dataDir: String(process.argv[2]) });',
        `const r = await store.snapshot({ cwd: ${JSON.stringify(cwd)}, sessionKey: 'ses_2p', turn: ${turn}, phase: 'start' });`,
        'console.log(r.tree);',
      ].join('\n');
      const child = spawn(process.execPath, ['--input-type=module', '-e', script,
        new URL('./checkpoints.js', import.meta.url).pathname, dataDir],
        { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`worker ${turn} exited ${code}: ${err.slice(0, 400)}`))));
    });
    const [t2, t3] = await Promise.all([worker(2), worker(3)]);
    expect(t2).toMatch(/^[0-9a-f]{40}$/);
    expect(t3).toMatch(/^[0-9a-f]{40}$/);
    const refs = await Promise.all([2, 3].map(async (turn) => {
      try {
        return (await fs.readFile(path.join(gitDir, 'refs', 'oc', 'ses_2p', String(turn), 'start'), 'utf8')).trim();
      } catch {
        return null;
      }
    }));
    expect(refs).toEqual([t2, t3]);
  });

  it('serializes reclamation behind the guard: no rename without it', async () => {
    const cwd = await makePlain('guardrace');
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_guard', turn: 1, phase: 'start' });
    const gitDir = shadowDirFor(dataDir, cwd);
    const { spawnSync, spawn } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    const staleText = `${probe.pid}:dead-op`;
    const lockFile = path.join(gitDir, 'openchamber-acp.lock');
    const guardFile = path.join(gitDir, 'openchamber-acp.reclaim');
    await fs.writeFile(lockFile, staleText);
    // Occupy the guard externally with a fresh claim: while it is held,
    // two racing reclaimers must both wait — neither may rename the stale
    // main lock aside (it still holds the exact stale identity) and no
    // snapshot may complete.
    await fs.writeFile(guardFile, `${process.pid}:test-guard`);
    const worker = (turn) => new Promise((resolve) => {
      const script = [
        'const { createCheckpointStore } = await import(String(process.argv[1]));',
        'const store = createCheckpointStore({ dataDir: String(process.argv[2]) });',
        `const r = await store.snapshot({ cwd: ${JSON.stringify(cwd)}, sessionKey: 'ses_guard', turn: ${turn}, phase: 'start' });`,
        'console.log(r.tree);',
      ].join('\n');
      const child = spawn(process.execPath, ['--input-type=module', '-e', script,
        new URL('./checkpoints.js', import.meta.url).pathname, dataDir],
        { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, tree: out.trim() }));
    });
    const pending = [worker(2), worker(3)];
    await new Promise((r) => setTimeout(r, 1500));
    // Still waiting: stale identity untouched, no refs, no stale-aside files.
    expect(await fs.readFile(lockFile, 'utf8')).toBe(staleText);
    expect((await fs.readdir(gitDir)).filter((n) => n.includes('.stale-'))).toEqual([]);
    await expect(fs.stat(path.join(gitDir, 'refs', 'oc', 'ses_guard', '2', 'start')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    // Release the guard: exactly one reclaims, both complete serialized.
    await fs.rm(guardFile);
    const [r2, r3] = await Promise.all(pending);
    expect(r2.code).toBe(0);
    expect(r3.code).toBe(0);
    expect(r2.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(r3.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it('clears a guard left stale by a dead reclaimer', async () => {
    const cwd = await makePlain('stale-guard');
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_sg', turn: 1, phase: 'start' });
    const gitDir = shadowDirFor(dataDir, cwd);
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    await fs.writeFile(path.join(gitDir, 'openchamber-acp.lock'), `${probe.pid}:dead-op`);
    const guardFile = path.join(gitDir, 'openchamber-acp.reclaim');
    await fs.writeFile(guardFile, `${probe.pid}:dead-guard`);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(guardFile, old, old);
    const { tree } = await store.snapshot({ cwd, sessionKey: 'ses_sg', turn: 2, phase: 'start' });
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.stat(guardFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('gc', () => {
  it('removes only that session refs and prunes unreachable objects', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'v1 unique-bytes-AAA\n');
    const keep = await store.snapshot({ cwd, sessionKey: 'ses_keep', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'a.txt', 'v2 unique-bytes-BBB\n');
    const drop = await store.snapshot({ cwd, sessionKey: 'ses_drop', turn: 1, phase: 'start' });
    expect(drop.tree).not.toBe(keep.tree);

    const result = await store.gc({ sessionKey: 'ses_drop', cwd });
    expect(result.deletedRefs).toBe(1);
    const gitDir = shadowDirFor(dataDir, cwd);
    // Resolve through git: `gc` packs refs, so loose files may be gone.
    const probe = (args) => execFileSync('git', ['-c', 'core.hooksPath=', ...args], {
      cwd, encoding: 'utf8', windowsHide: true,
      env: { ...isolatedEnv, GIT_DIR: gitDir, GIT_WORK_TREE: cwd, GIT_INDEX_FILE: path.join(gitDir, 'gc-probe.idx') },
    });
    expect(probe(['for-each-ref', '--format=%(refname)', 'refs/oc/']).trim().split('\n')).toEqual(['refs/oc/ses_keep/1/start']);
    expect(probe(['rev-parse', 'refs/oc/ses_keep/1/start^{tree}']).trim()).toBe(keep.tree);
    // The dropped tree's objects are pruned; the kept tree still resolves.
    expect(() => probe(['cat-file', '-t', drop.tree])).toThrow();
    expect(probe(['cat-file', '-t', keep.tree]).trim()).toBe('tree');
  });

  it('is a no-op for unknown sessions and missing data', async () => {
    const cwd = await makePlain();
    await writeBytes(cwd, 'a.txt', 'x\n');
    await store.snapshot({ cwd, sessionKey: 'ses_x', turn: 1, phase: 'start' });
    expect(await store.gc({ sessionKey: 'ses_nothing' })).toEqual({ deletedRefs: 0 });
    expect(await store.gc({ sessionKey: 'ses_nothing', cwd })).toEqual({ deletedRefs: 0 });
    const empty = createCheckpointStore({ dataDir: path.join(root, 'no-such-data'), environment: isolatedEnv });
    expect(await empty.gc({ sessionKey: 'ses_nothing' })).toEqual({ deletedRefs: 0 });
    await expect(store.gc({ sessionKey: '../escape' }))
      .rejects.toMatchObject({ code: 'ACP_CHECKPOINT_INVALID_SESSION_KEY' });
  });

  it('is a no-op for targeted gc on a project that never snapshotted', async () => {
    const cwd = await makePlain('fresh-proj');
    await writeBytes(cwd, 'a.txt', 'x\n');
    expect(await store.gc({ sessionKey: 'ses_fresh', cwd })).toEqual({ deletedRefs: 0 });
  });
});

describe('restore robustness', () => {
  it('leaves no scratch indexes after successful, no-op and failed restores', async () => {
    const cwd = await makePlain('scratch');
    await writeBytes(cwd, 'a.txt', 'v1\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_scratch', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'a.txt', 'v2\n');
    await store.restore({ cwd, tree: s1.tree });
    await store.restore({ cwd, tree: s1.tree });
    await expect(store.restore({ cwd, tree: '0'.repeat(40) })).rejects.toMatchObject({ code: 'ACP_CHECKPOINT_UNKNOWN_TREE' });
    const leftovers = (await fs.readdir(shadowDirFor(dataDir, cwd))).filter((name) => name.startsWith('restore-'));
    expect(leftovers).toEqual([]);
  });

  it('does not recreate absent ancestor dirs for already-gone deletion candidates', async () => {
    const cwd = await makePlain('absent-anc');
    await writeBytes(cwd, 'keep.txt', 'k\n');
    const t0 = await store.snapshot({ cwd, sessionKey: 'ses_abs', turn: 1, phase: 'start' });
    await fs.mkdir(path.join(cwd, 'gone', 'deep'), { recursive: true });
    await writeBytes(cwd, path.join('gone', 'deep', 'f.txt'), 'g\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_abs', turn: 1, phase: 'end' });
    // Whole subtree already gone on disk; restoring the earlier tree deletes
    // nothing (candidate already absent) and must NOT recreate gone/deep.
    await fs.rm(path.join(cwd, 'gone'), { recursive: true });
    const result = await store.restore({ cwd, tree: t0.tree, current: s1.tree });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    await expect(fs.stat(path.join(cwd, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readBytes(cwd, 'keep.txt')).toEqual(Buffer.from('k\n'));
  });

  it('restores a single 65 MiB blob past the old maxBuffer limit', async () => {
    const cwd = await makePlain('bigblob');
    const bytes = Buffer.alloc(65 * 1024 * 1024, 0x3c);
    await writeBytes(cwd, 'big.bin', bytes);
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_big', turn: 1, phase: 'start' });
    await writeBytes(cwd, 'big.bin', 'mutated\n');
    const result = await store.restore({ cwd, tree: s1.tree });
    expect(result.restored).toEqual(['big.bin']);
    // Manual compare: vitest's toEqual pretty-printing can OOM on 65 MiB.
    const back = await readBytes(cwd, 'big.bin');
    expect(back.length).toBe(bytes.length);
    expect(back.equals(bytes)).toBe(true);
  }, 120_000);

  it('restores an aggregate batch past 64 MiB', async () => {
    const cwd = await makePlain('bigbatch');
    // Distinct contents per file: identical buffers would share one blob
    // id and the batch would not actually exceed 64 MiB.
    const expected = [];
    for (let i = 0; i < 9; i += 1) {
      const bytes = Buffer.alloc(8 * 1024 * 1024, 0x51);
      bytes.writeUInt32BE(i, 0);
      bytes.writeUInt32BE((0xdeadbeef ^ i) >>> 0, bytes.length - 4);
      expected.push(bytes);
      await writeBytes(cwd, `f${i}.bin`, bytes);
    }
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_batch', turn: 1, phase: 'start' });
    for (let i = 0; i < 9; i += 1) {
      await writeBytes(cwd, `f${i}.bin`, 'mutated\n');
    }
    const result = await store.restore({ cwd, tree: s1.tree });
    expect(result.restored.sort()).toEqual(Array.from({ length: 9 }, (_, i) => `f${i}.bin`));
    for (let i = 0; i < 9; i += 1) {
      const back = await readBytes(cwd, `f${i}.bin`);
      expect(back.length).toBe(expected[i].length);
      expect(back.equals(expected[i])).toBe(true);
    }
  }, 180_000);

  it('refuses a path whose parent is swapped between preflight and write', async () => {
    const cwd = await makePlain('swaprace');
    await fs.mkdir(path.join(cwd, 'd'), { recursive: true });
    await writeBytes(cwd, path.join('d', 'f.txt'), 'original\n');
    await writeBytes(cwd, path.join('d', 'g.txt'), 'g-original\n');
    const s1 = await store.snapshot({ cwd, sessionKey: 'ses_swap', turn: 1, phase: 'start' });
    await writeBytes(cwd, path.join('d', 'f.txt'), 'mutated-f\n');
    await writeBytes(cwd, path.join('d', 'g.txt'), 'mutated-g\n');
    const outside = path.join(root, 'swap-outside');
    await fs.mkdir(outside, { recursive: true });
    await writeBytes(outside, 'f.txt', 'outside precious\n');
    await writeBytes(outside, 'g.txt', 'outside precious\n');
    // Swap the parent to a junction after the batch preflight but before
    // the per-file writes: arm on the second lstat of the same parent.
    const { execSync } = await import('node:child_process');
    const realLstat = fs.lstat;
    let parentStats = 0;
    let swapped = false;
    const junctionTarget = path.join(cwd, 'd');
    fs.lstat = (async (...args) => {
      const result = await realLstat(...args);
      const inspected = String(args[0]);
      if (!swapped && inspected === junctionTarget && result.isDirectory() && !result.isSymbolicLink()) {
        parentStats += 1;
        if (parentStats === 2) {
          swapped = true;
          await fs.rm(junctionTarget, { recursive: true });
          if (process.platform === 'win32') {
            execSync(`mklink /J ${JSON.stringify(junctionTarget)} ${JSON.stringify(outside)}`);
          } else {
            await fs.symlink(outside, junctionTarget, 'dir');
          }
        }
      }
      return result;
    });
    try {
      const result = await store.restore({ cwd, tree: s1.tree });
      // At least the file written after the swap must refuse; nothing may
      // write through the junction.
      expect(result.skipped.length).toBeGreaterThan(0);
      expect(result.skipped.every((s) => s.reason === 'obstructed-ancestor')).toBe(true);
      expect(await readBytes(outside, 'f.txt')).toEqual(Buffer.from('outside precious\n'));
      expect(await readBytes(outside, 'g.txt')).toEqual(Buffer.from('outside precious\n'));
    } finally {
      fs.lstat = realLstat;
    }
  });
});
