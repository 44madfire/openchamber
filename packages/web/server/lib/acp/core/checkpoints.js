// Git checkpoints per turn: a shadow git dir per project snapshots the working
// tree before and after each agent turn, so revert and turn diff work for any
// ACP agent, in git repos and in plain folders alike (ACP_PLAN.md D12/D13/D14).
//
// Design, measured against git 2.55 on Windows:
// - One shadow repo per project at `<dataDir>/checkpoints/<hash>.git`, with
//   `GIT_WORK_TREE=<cwd>` and a private `GIT_INDEX_FILE`. The user's own repo
//   (`.git` dir, index, HEAD, refs, hooks, config) is never read-modified:
//   every git call runs with `-c core.hooksPath=<empty dir>`,
//   `-c core.fsmonitor=`, `-c core.autocrlf=false`, `-c core.longpaths=true`,
//   and an env scrubbed of inherited `GIT_*` (including `GIT_CONFIG` and the
//   `GIT_CONFIG_*`/`GIT_TRACE*` families, case-insensitively on Windows),
//   following `server/lib/spaces/code-in.js` and `host-git.js`.
// - Byte-exact capture: `add`/`write-tree` run with `GIT_ATTR_SOURCE` pointed
//   at the empty tree (kills worktree `.gitattributes`) plus an empty
//   `core.attributesFile` (kills global/system attributes), so text/eol,
//   ident and clean/smudge filters such as LFS never rewrite bytes. What
//   `restore` writes back is then identical to what was snapshotted. Ignore
//   rules still apply; attributes do not. Git's attribute support is
//   feature-tested once per store; without it snapshots fail loudly instead
//   of capturing converted bytes.
// - Ignore rules honored: the project's `.gitignore` files, the effective
//   global excludes file (explicit `core.excludesFile` with `~` expansion,
//   else git's default `$XDG_CONFIG_HOME/git/ignore` or
//   `~/.config/git/ignore`), and — when the cwd is itself a git repo — the
//   project's own `$GIT_COMMON_DIR/info/exclude` (read-only, via a merged
//   temp excludes file, since `core.excludesFile` replaces rather than
//   augments the default; the common dir covers linked worktrees). The
//   project's `.git` dir itself is never staged.
// - The shared work index (`<shadow>.git/index`) stays warm across snapshots
//   of the same cwd, so unchanged files are re-hashed by stat info only:
//   ~150 ms on a 3.6k-file tree vs ~11 s cold. Each snapshot `add`s the full
//   work tree (honoring ignores), `write-tree`s, and records the tree id in
//   `refs/oc/<sessionKey>/<turn>/<phase>`.
// - `diff(from, to)` accepts two tree ids from any source and maps `git diff`
//   to the `FileDiffInfo` shape DiffView consumes (`file`, `patch`,
//   `additions`, `deletions`, `status`).
// - `restore({cwd, tree, current?})`: for every path in `tree`, write target
//   content; DELETE only paths that are members of the session's latest
//   snapshot — the `current` tree when given, else the warm work index
//   captured fresh via `write-tree` — and absent from `tree`. Anything that
//   is a member of neither tree is never deleted or overwritten. Restore
//   never traverses symlinks/junctions, never removes non-empty directories,
//   nested repos or ignored content: obstructed paths are refused and
//   reported in `skipped` instead of `restored`/`removed`.
// - Operations serialize per shadow repo through a process-wide promise
//   chain (shared by every store instance in this process) plus an
//   interprocess lock file, so concurrent turns on one project cannot
//   interleave index writes. Scratch files carry unique operation ids.
//
// Host-agnostic: no express/http/global-hub imports. NOT wired into any route
// or turn flow yet; a later phase does that.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class AcpCheckpointsError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AcpCheckpointsError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// Two scrub tiers. SHADOW calls (mutations inside the shadow repo) drop
// everything that could redirect them: repository location, object store,
// and ALL config overrides. CONFIG calls (read-only `git config --get` /
// `git rev-parse --git-dir` against the USER's project) drop only the
// repository-location vars, so the user's normal configuration — global
// files, XDG, includes/includeIf — resolves exactly as their own git sees
// it. `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` survive in config calls for
// the same reason (a caller that sets them wants that config); the
// single-file `GIT_CONFIG` override is dropped everywhere: it would
// silently replace the whole config stack.
const REMOVED_LOCATION_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_QUARANTINE_PATH',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);
const REMOVED_ENV_VARS = new Set([
  ...REMOVED_LOCATION_VARS,
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_ALLOW_PROTOCOL',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'GIT_PROTOCOL_FROM_USER',
  'GIT_ATTR_SOURCE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);
const REMOVED_ENV_PATTERN = /^(?:GIT_CONFIG_(?:KEY|VALUE)_\d+|GIT_TRACE.*)$/i;

// The empty tree: `GIT_ATTR_SOURCE` points here so worktree `.gitattributes`
// convert nothing, while ignore rules (which `add` reads from the work tree)
// still apply.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const TREE_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF_NAMESPACE = 'refs/oc/';
// Session keys are path-safe by the D6 codec; still, a ref segment must not
// escape the namespace, so anything outside this set is rejected.
const REF_SEGMENT = /^[A-Za-z0-9_.-]+$/;
// Lock waits: operations on one shadow repo are short (sub-second warm), so
// a bounded wait that reports contention beats hanging the caller forever.
const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 60_000;
// Stale reclamation is serialized by a second exclusive-create guard. A
// guard older than this is itself stale (its holder died mid-reclaim) and
// may be removed by anyone; the 30 s window where two contenders could both
// believe the guard stale is accepted (both then re-validate the SAME main
// lock identity, and only a still-stale identity is renamed).
const RECLAIM_GUARD_STALE_MS = 30_000;
// Shadow `*.lock` files (git's own, never the user's) are removed during
// reclamation only when older than this: a fresher lock may belong to a
// still-live git child of the dead owner, which server death alone cannot
// disprove. Younger locks fail the acquisition with ACP_CHECKPOINT_BUSY.
const GIT_LOCK_STALE_MS = 5 * 60_000;

// Process-wide chains: every store instance in this process serializes on
// the same per-shadow-repo chain. The interprocess lock file below covers
// other processes.
const processChains = new Map();

const snapshotEnv = (environment, removed = REMOVED_ENV_VARS) => {
  const kept = Object.entries(environment).filter(([name]) => {
    const key = name.toUpperCase();
    return !removed.has(key) && !REMOVED_ENV_PATTERN.test(name);
  });
  return {
    ...Object.fromEntries(kept),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_SOURCE: EMPTY_TREE,
  };
};

// Config-tier env: location vars dropped, user config (incl. includes)
// intact. Used ONLY for read-only `git config --get` / `rev-parse`
// against the user's project — never for shadow mutations.
const configEnv = (environment) => snapshotEnv(environment, REMOVED_LOCATION_VARS);

/**
 * Canonical filesystem path for `cwd`: absolute, symlinks/junctions and
 * `.`/`..` resolved, verified to exist and be a directory. All containment
 * checks and git work-tree bindings use this, never the caller's spelling.
 */
export async function canonicalCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') {
    throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_CWD', 'A checkpoints operation needs a working directory.');
  }
  let canonical;
  try {
    canonical = await fs.realpath(path.resolve(cwd));
  } catch (error) {
    throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_CWD', `Not a working directory: ${cwd}`, { cause: error });
  }
  let stats;
  try {
    stats = await fs.stat(canonical);
  } catch (error) {
    throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_CWD', `Not a working directory: ${cwd}`, { cause: error });
  }
  if (!stats.isDirectory()) {
    throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_CWD', `Not a working directory: ${cwd}`);
  }
  return canonical;
}

/**
 * Normalize `cwd` for hashing: canonical path, case folded on
 * case-insensitive filesystems, separators unified.
 */
export function normalizeCwd(cwd) {
  let resolved = path.resolve(cwd).replace(/[/\\]+$/, '');
  if (resolved === '') resolved = path.resolve(cwd);
  if (process.platform === 'win32' || process.platform === 'darwin') resolved = resolved.toLowerCase();
  return resolved.replace(/\\/g, '/');
}

export function shadowDirFor(dataDir, cwd) {
  const hash = crypto.createHash('sha256').update(normalizeCwd(cwd)).digest('hex').slice(0, 32);
  return path.join(dataDir, 'checkpoints', `${hash}.git`);
}

// `true` when `candidate` is `root` itself or lives under it. Case-aware on
// Windows/macOS, where the filesystem folds case.
const withinRoot = (root, candidate) => {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    root = root.toLowerCase();
    candidate = candidate.toLowerCase();
  }
  if (candidate === root) return true;
  return candidate.startsWith(`${root}${path.sep}`);
};

export function createCheckpointStore({ dataDir, git = 'git', environment = process.env, timeoutMs = 120_000 } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_DATA_DIR', 'A checkpoints store needs a data directory.');
  }
  const baseEnv = snapshotEnv(environment);
  const userConfigEnv = configEnv(environment);
  const emptyAttrs = { promise: undefined, path: undefined };
  // The empty hooks dir is created once per store (not per call) and shared
  // by every git invocation; its only job is to exist and stay empty.
  let hooksDirPromise;
  // Attribute support is feature-tested once per store (see `requireAttrSupport`).
  let attrSupportPromise;

  // In-flight operations, registered synchronously at call time so `dispose`
  // can await them before removing owned temps. `disposeStarted` closes
  // admission: new ops fail fast with ACP_CHECKPOINT_DISPOSED.
  const activeOps = new Set();
  let disposeStarted = false;
  let disposePromise = null;

  const disposedError = () => new AcpCheckpointsError(
    'ACP_CHECKPOINT_DISPOSED',
    'This checkpoints store is disposed.',
  );

  // Gate + track one store operation. The admission check and the `add`
  // both run synchronously (before the work's first await), so an op that
  // started pre-dispose is always awaited and cannot leak temps created
  // post-dispose. Refused ops return a rejection, like every other store
  // error, and are never tracked.
  const runOp = (work) => {
    if (disposeStarted) return Promise.reject(disposedError());
    const op = work();
    activeOps.add(op);
    op.then(
      () => activeOps.delete(op),
      () => activeOps.delete(op),
    );
    return op;
  };

  const hooksDir = () => {
    hooksDirPromise ??= fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-acp-no-hooks-'));
    return hooksDirPromise;
  };

  const emptyAttrsFile = async () => {
    if (emptyAttrs.path !== undefined) return emptyAttrs.path;
    emptyAttrs.promise ??= (async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-acp-no-attrs-'));
      const file = path.join(dir, 'attributes');
      await fs.writeFile(file, '');
      emptyAttrs.path = file;
      return file;
    })();
    return emptyAttrs.promise;
  };

  const gitArgs = async (args) => {
    const hooks = (await hooksDir()).replaceAll('\\', '/');
    const attrs = (await emptyAttrsFile()).replaceAll('\\', '/');
    return [
      '-c', `core.hooksPath=${hooks}`,
      '-c', 'core.fsmonitor=',
      '-c', 'core.autocrlf=false',
      '-c', 'core.quotepath=false',
      '-c', 'gc.auto=0',
      '-c', 'core.longpaths=true',
      '-c', `core.attributesFile=${attrs}`,
      ...args,
    ];
  };

  const runGit = ({ cwd, gitDir, indexFile, excludesFile, stdin, binary = false, maxOutputBytes = 64 * 1024 * 1024 }) => async (args) => {
    const fullArgs = await gitArgs(args);
    return new Promise((resolve, reject) => {
      const child = execFile(
        git,
        fullArgs,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          windowsHide: true,
          ...(binary ? { encoding: 'buffer' } : {}),
          env: {
            ...baseEnv,
            GIT_DIR: gitDir,
            GIT_WORK_TREE: cwd,
            GIT_INDEX_FILE: indexFile,
            ...(excludesFile
              ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludesFile }
              : {}),
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = binary
              ? (Buffer.isBuffer(stderr) ? stderr.toString('utf8', 0, 512) : String(stderr ?? ''))
              : String(stderr || '');
            reject(new AcpCheckpointsError(
              'ACP_CHECKPOINT_GIT_FAILED',
              `git ${args[0] ?? ''} failed: ${(detail || error.message).trim().slice(0, 2000)}`,
              { cause: error },
            ));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
      if (stdin !== undefined) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    });
  };

  // Git calls that must not see our location vars (`init`, `config`
  // writes during shadow setup): scrubbed base env only. `configFile`
  // targets one config file explicitly (`--file=`), so an inherited
  // `GIT_CONFIG*` could never redirect the write even if the scrub missed
  // it — and the read below proves the value landed where intended.
  const runPlainGit = (workDir, args, { configFile } = {}) => new Promise((resolve, reject) => {
    const finalArgs = configFile && args[0] === 'config' ? ['config', '--file', configFile, ...args.slice(1)] : args;
    execFile(git, finalArgs, {
      cwd: workDir, timeout: timeoutMs, windowsHide: true, env: { ...baseEnv },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new AcpCheckpointsError(
          'ACP_CHECKPOINT_GIT_FAILED',
          `git ${args[0] ?? ''} failed: ${(stderr || error.message).trim().slice(0, 2000)}`,
          { cause: error },
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  // Read-only lookups against the USER's project (`git config --get`,
  // `git rev-parse --git-dir`): config-tier env, so includes, includeIf,
  // XDG and global files resolve exactly as the user's own git sees them.
  // Sensitive to `cwd`: includeIf gitdir patterns match the project, so
  // every call runs with cwd set to the project root.
  const runUserGit = (workDir, args) => new Promise((resolve, reject) => {
    execFile(git, args, {
      cwd: workDir, timeout: timeoutMs, windowsHide: true, env: { ...userConfigEnv },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new AcpCheckpointsError(
          'ACP_CHECKPOINT_GIT_FAILED',
          `git ${args[0] ?? ''} failed: ${(stderr || error.message).trim().slice(0, 2000)}`,
          { cause: error },
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  // Feature-test once: `GIT_ATTR_SOURCE` must actually suppress worktree
  // attribute conversion on this git, else snapshots would silently capture
  // converted bytes. A git too old to know the variable fails here, loudly.
  const requireAttrSupport = () => {
    attrSupportPromise ??= (async () => {
      const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-acp-attr-probe-'));
      try {
        await runPlainGit(probe, ['init', '--quiet', '--template=', '.']);
        await fs.writeFile(path.join(probe, '.gitattributes'), '*.txt text eol=lf\n');
        await fs.writeFile(path.join(probe, 'p.txt'), Buffer.from('a\r\nb\r\n'));
        const added = await gitArgs(['add', '--', 'p.txt']);
        const blob = await new Promise((resolve, reject) => {
          execFile(git, added, {
            cwd: probe, timeout: timeoutMs, windowsHide: true,
            env: { ...baseEnv, GIT_DIR: path.join(probe, '.git') },
          }, (error, stdout, stderr) => (error
            ? reject(new AcpCheckpointsError('ACP_CHECKPOINT_GIT_FAILED', `git add failed: ${(stderr || error.message).trim().slice(0, 500)}`, { cause: error }))
            : resolve(stdout)));
        });
        void blob;
        const stored = await new Promise((resolve, reject) => {
          execFile(git, ['cat-file', '-p', ':p.txt'], {
            cwd: probe, timeout: timeoutMs, windowsHide: true, encoding: 'buffer',
            env: { ...baseEnv, GIT_DIR: path.join(probe, '.git') },
          }, (error, stdout, stderr) => (error ? reject(error) : resolve(stdout)));
        });
        if (!stored.equals(Buffer.from('a\r\nb\r\n'))) {
          throw new AcpCheckpointsError(
            'ACP_CHECKPOINT_ATTRS_UNSUPPORTED',
            'This git does not honor GIT_ATTR_SOURCE; snapshots would capture converted bytes instead of work-tree bytes.',
          );
        }
      } finally {
        await fs.rm(probe, { recursive: true, force: true });
      }
    })();
    return attrSupportPromise;
  };

  // Ensure the shadow repo exists and return its layout. `init` output goes
  // to a staging dir whose `.git` is moved into place, so two racing
  // processes cannot observe a half-written repo (the loser reuses the
  // winner's). The `core.bare` write targets the staging config file
  // explicitly and is read back to prove it landed there.
  const ensureShadow = async (cwd) => {
    const gitDir = shadowDirFor(dataDir, cwd);
    const headFile = path.join(gitDir, 'HEAD');
    try {
      await fs.stat(headFile);
      return { gitDir, indexFile: path.join(gitDir, 'index') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await requireAttrSupport();
    await fs.mkdir(path.join(dataDir, 'checkpoints'), { recursive: true });
    const staging = await fs.mkdtemp(path.join(dataDir, 'checkpoints', '.init-'));
    try {
      await runPlainGit(staging, ['init', '--quiet', '--template=', '.']);
      const stagingConfig = path.join(staging, '.git', 'config');
      // A non-bare repo with `core.bare=false` accepts `GIT_WORK_TREE` for
      // work-tree commands while keeping HEAD dangling (nothing commits).
      await runPlainGit(staging, ['config', 'core.bare', 'false'], { configFile: stagingConfig });
      const landed = await runPlainGit(staging, ['config', '--get', 'core.bare'], { configFile: stagingConfig });
      if (landed.stdout.trim() !== 'false') {
        throw new AcpCheckpointsError('ACP_CHECKPOINT_GIT_FAILED', 'Shadow repo init did not land core.bare=false in the staging config.');
      }
      try {
        await fs.rename(path.join(staging, '.git'), gitDir);
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
        // Lost the race: another process created it first.
        await fs.stat(headFile);
      }
      return { gitDir, indexFile: path.join(gitDir, 'index') };
    } finally {
      await fs.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  };

  // Interprocess ownership of one shadow repo: exclusive-create
  // `openchamber-acp.lock` holding `pid:operationId`. The fast path never
  // unlinks: the lock is removed only by its holder (claim text verified).
  //
  // Stale reclamation is serialized by a SECOND exclusive-create guard,
  // `openchamber-acp.reclaim`. Only the guard holder may re-read the main
  // lock, confirm it still holds the SAME stale identity (pid dead via
  // ESRCH only — EPERM means a live process we may not signal), rename it
  // aside, acquire fresh, sweep abandoned git locks, and remove the guard.
  // Because reclamation is single-holder, a delayed contender can never
  // rename another contender's freshly acquired live lock: it either waits
  // on the guard or finds a live claim where it expected the stale one.
  // A guard older than RECLAIM_GUARD_STALE_MS is itself stale (holder died
  // mid-reclaim) and may be removed by anyone; the tiny double-stale window
  // is accepted since both sides re-validate the same main-lock identity.
  const lockFileFor = (gitDir) => path.join(gitDir, 'openchamber-acp.lock');
  const guardFileFor = (gitDir) => path.join(gitDir, 'openchamber-acp.reclaim');

  const readLockOwner = async (lockFile) => {
    try {
      const text = (await fs.readFile(lockFile, 'utf8')).trim();
      const [pidText, op] = text.split(':');
      const pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 0 || !op) return { malformed: true, text };
      return { pid, op, text };
    } catch (error) {
      return error.code === 'ENOENT' ? null : { unreadable: true };
    }
  };

  // Demonstrably dead means ESRCH only: any other `kill` failure keeps the
  // owner alive.
  const isPidDead = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH';
    }
  };

  const lockClaimRelease = (lockFile, claim) => async () => {
    try {
      if ((await readLockOwner(lockFile))?.text === claim) await fs.rm(lockFile, { force: true });
    } catch { /* best effort */ }
  };

  // Abandoned git locks inside OUR shadow repo (never the user's): every
  // `*.lock` under the shadow dir — index, HEAD, packed-refs, objects, and
  // ALL ref namespaces including refs/oc/** — is removed only when older
  // than GIT_LOCK_STALE_MS. Server death does NOT prove its git children
  // died, so a younger lock fails with retryable ACP_CHECKPOINT_BUSY
  // instead of being unlinked under a live git. No symlink following;
  // our own ownership lock and reclaim guard are never matched.
  const clearAbandonedGitLocks = async (gitDir) => {
    const victims = [];
    const collect = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await collect(full);
        } else if (entry.isFile() && entry.name.endsWith('.lock')
          && !entry.name.startsWith('openchamber-acp.lock') && !entry.name.startsWith('openchamber-acp.reclaim')) {
          victims.push(full);
        }
      }
    };
    await collect(gitDir);
    const now = Date.now();
    const young = [];
    for (const file of victims) {
      let age;
      try {
        age = now - (await fs.stat(file)).mtimeMs;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (age < GIT_LOCK_STALE_MS) {
        young.push(file);
        continue;
      }
      await fs.rm(file, { force: true });
    }
    if (young.length > 0) {
      throw new AcpCheckpointsError(
        'ACP_CHECKPOINT_BUSY',
        `Shadow git locks are held by a live process (${young.length} fresh lock${young.length === 1 ? '' : 's'}); retry the operation.`,
      );
    }
  };

  // Acquire the reclaim guard (exclusive create), removing it first only
  // when it is older than RECLAIM_GUARD_STALE_MS. Returns the guard release,
  // or null when another contender holds a fresh guard.
  const acquireReclaimGuard = async (gitDir, opId) => {
    const guardFile = guardFileFor(gitDir);
    const guardClaim = `${process.pid}:${opId}`;
    for (;;) {
      try {
        const handle = await fs.open(guardFile, 'wx', 0o600);
        await handle.writeFile(guardClaim);
        await handle.close();
        return async () => {
          try {
            if ((await readLockOwner(guardFile))?.text === guardClaim) await fs.rm(guardFile, { force: true });
          } catch { /* best effort */ }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let age;
      try {
        age = Date.now() - (await fs.stat(guardFile)).mtimeMs;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (age < RECLAIM_GUARD_STALE_MS) return null;
      try {
        await fs.rm(guardFile);
      } catch {
        return null; // lost the race to clear it; treat as held
      }
    }
  };

  const acquireInterprocess = async (gitDir, opId) => {
    const lockFile = lockFileFor(gitDir);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const claim = `${process.pid}:${opId}`;
    const release = lockClaimRelease(lockFile, claim);
    for (;;) {
      try {
        const handle = await fs.open(lockFile, 'wx', 0o600);
        await handle.writeFile(claim);
        await handle.close();
        return { release };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const owner = await readLockOwner(lockFile);
      const stale = owner && !owner.unreadable
        && (owner.malformed || isPidDead(owner.pid));
      if (stale) {
        // Only the guard holder may reclaim. Anyone else waits for the
        // guard holder's fresh claim (or the guard's release) below.
        const releaseGuard = await acquireReclaimGuard(gitDir, opId);
        if (releaseGuard) {
          try {
            const held = await reclaimUnderGuard({ gitDir, lockFile, claim, expected: owner.text });
            if (held) return { release: held };
            // Identity changed under the guard: someone else finished a
            // reclaim cycle; fall through to normal acquisition.
          } finally {
            await releaseGuard();
          }
        }
      }
      if (Date.now() >= deadline) {
        throw new AcpCheckpointsError(
          'ACP_CHECKPOINT_LOCK_TIMEOUT',
          `Timed out waiting for the checkpoints lock on ${gitDir}.`,
        );
      }
      await new Promise((resolve) => { setTimeout(resolve, LOCK_POLL_MS); });
    }
  };

  // Guard-held reclamation: re-read the main lock and confirm it STILL
  // holds the same stale identity; rename it aside; acquire fresh;
  // sweep old git locks; return the fresh release. Any failure after the
  // fresh acquisition releases the fresh claim AND restores the renamed
  // stale lock, so a retry reclaims again instead of fast-path acquiring
  // past unswept git locks. Returns null when the identity changed
  // (another cycle completed).
  const reclaimUnderGuard = async ({ gitDir, lockFile, claim, expected }) => {
    const again = await readLockOwner(lockFile);
    const staleNow = again && !again.unreadable && again.text === expected
      && (again.malformed || isPidDead(again.pid));
    if (!staleNow) return null;
    const staleName = `${lockFile}.stale-${process.pid}-${claim.split(':')[1]}`;
    await fs.rename(lockFile, staleName);
    const release = lockClaimRelease(lockFile, claim);
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(claim);
      await handle.close();
    } catch (error) {
      // Someone created a claim between our rename and create: a fast-path
      // contender that won the window — back off and let the outer loop
      // wait on it. Restore the stale lock first so the reclamation
      // opportunity is not lost (its claim is valid and stays).
      await release();
      await fs.rename(staleName, `${lockFile}.stale-orphan-${process.pid}-${claim.split(':')[1]}`).catch(() => {});
      if (error.code === 'EEXIST') return null;
      throw error;
    }
    try {
      await clearAbandonedGitLocks(gitDir);
    } catch (error) {
      // Sweep failed (fresh git locks → BUSY): give up the fresh claim
      // and restore the stale lock so the next attempt reclaims again.
      await release();
      try {
        await fs.rename(staleName, lockFile);
      } catch {
        // A fast-path contender claimed the window; leave our stale file
        // for the lazy sweep and let the outer loop wait on their claim.
      }
      throw error;
    }
    await fs.rm(staleName, { force: true });
    // Opportunistically sweep older stale files (capped).
    try {
      const entries = await fs.readdir(gitDir);
      await Promise.all(entries
        .filter((name) => name.startsWith('openchamber-acp.lock.stale-'))
        .slice(0, 8)
        .map((name) => fs.rm(path.join(gitDir, name), { force: true })));
    } catch { /* best effort */ }
    return release;
  };

  // Serialize on one shadow repo: process-wide chain first (cheap, covers
  // every store instance here), then the interprocess lock file.
  const withLock = (gitDir, work) => {
    const previous = processChains.get(gitDir) ?? Promise.resolve();
    let release;
    const next = previous.then(async () => {
      const opId = crypto.randomBytes(8).toString('hex');
      ({ release } = await acquireInterprocess(gitDir, opId));
      try {
        return await work(opId);
      } finally {
        await release();
      }
    });
    const settled = next.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    processChains.set(gitDir, settled.then(() => {}));
    return next;
  };

  // The user's effective global excludes file, resolved BY GIT ITSELF
  // (`config --path --get`, `--path` expands `~` exactly as git would), run
  // in the project with the config-tier env: global files, XDG, includes
  // and includeIf all resolve exactly as the user's own git sees them.
  // Unset → git's default `$XDG_CONFIG_HOME/git/ignore` (else
  // `~/.config/git/ignore`) from the store environment.
  const globalExcludesPath = async (cwd) => {
    let configured = '';
    try {
      configured = (await runUserGit(cwd, ['config', '--path', '--get', 'core.excludesFile'])).stdout.trim();
    } catch {
      configured = '';
    }
    if (configured !== '') return configured;
    const homeDir = (environment.HOME ?? '').trim() || os.homedir();
    const xdgHome = (environment.XDG_CONFIG_HOME ?? '').trim() || path.join(homeDir, '.config');
    return path.join(xdgHome, 'git', 'ignore');
  };

  // The repo-local excludes file that applies to `cwd`, read-only: git
  // reads `$GIT_COMMON_DIR/info/exclude`, which covers plain repos and
  // linked worktrees alike (a linked worktree's per-worktree gitdir has no
  // `info/exclude` of its own; the common dir's applies). Plain folders
  // yield null.
  const localExcludesPath = async (cwd) => {
    let commonDir;
    try {
      commonDir = (await runUserGit(cwd, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    } catch {
      return null;
    }
    if (commonDir === '') return null;
    // `--absolute-git-dir` prints the per-worktree gitdir for linked
    // worktrees; the excludes live in the COMMON dir. `commondir` names it.
    let resolved = commonDir;
    try {
      const pointer = (await fs.readFile(path.join(commonDir, 'commondir'), 'utf8')).trim();
      if (pointer !== '') resolved = path.resolve(commonDir, pointer);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    return path.join(resolved, 'info', 'exclude');
  };

  // Extra excludes for one operation: the repo-local and global excludes
  // merged into a temp file (read-only; the user's files are never written).
  // `core.excludesFile` replaces the default lookup, so without the merge a
  // repo-local exclude would silently drop the global ignores.
  const withExcludes = async (cwd, work) => {
    const [localPath, globalPath] = await Promise.all([localExcludesPath(cwd), globalExcludesPath(cwd)]);
    let local = '';
    if (localPath) {
      try {
        local = await fs.readFile(localPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
    let global = '';
    try {
      global = await fs.readFile(globalPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (local === '' && global === '') return work(undefined);
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-acp-excludes-'));
    const merged = path.join(staging, 'excludes');
    try {
      const terminated = (text) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);
      await fs.writeFile(merged, `${terminated(global)}${terminated(local)}`);
      return await work(merged);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  };

  // Untracked dirs that are git repos of their own must not be snapshotted:
  // `add` would record each as a gitlink whose content the shadow repo can
  // never restore. Listed from an empty temp index (so the warm work index
  // is untouched), then excluded from the snapshot's `add` by literal
  // pathspec — the same rule `spaces/code-in.js` applies.
  const nestedRepos = async ({ cwd, gitDir, excludesFile, opId }) => {
    const emptyIndex = path.join(gitDir, `empty-${process.pid}-${opId}.idx`);
    await fs.rm(emptyIndex, { force: true });
    try {
      const git = runGit({ cwd, gitDir, indexFile: emptyIndex, excludesFile });
      const { stdout } = await git(['ls-files', '-z', '--others', '--exclude-standard', '--', '.', ':(exclude).git']);
      const nested = [];
      for (const entry of stdout.split('\0')) {
        if (!entry.endsWith('/') || entry === '/') continue;
        const dirPath = entry.slice(0, -1);
        // A trailing slash alone also marks plain dirs when depth limits
        // apply; only a dir holding a `.git` entry is a nested repo.
        try {
          await fs.stat(path.join(cwd, dirPath, '.git'));
          nested.push(dirPath);
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        }
      }
      return nested;
    } finally {
      await fs.rm(emptyIndex, { force: true });
    }
  };

  const requireRef = (sessionKey, turn, phase) => {
    if (typeof sessionKey !== 'string' || !REF_SEGMENT.test(sessionKey)) {
      throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_SESSION_KEY', `Not a checkpoint session key: ${JSON.stringify(sessionKey)}`);
    }
    if (!Number.isInteger(turn) || turn < 0) {
      throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_TURN', `Not a checkpoint turn: ${JSON.stringify(turn)}`);
    }
    if (phase !== 'start' && phase !== 'end') {
      throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_PHASE', `Not a checkpoint phase: ${JSON.stringify(phase)}`);
    }
    return `${REF_NAMESPACE}${sessionKey}/${turn}/${phase}`;
  };

  const requireTree = (value, what) => {
    if (typeof value !== 'string' || !TREE_ID.test(value)) {
      throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_TREE', `Not a checkpoint tree id for ${what}: ${JSON.stringify(value)}`);
    }
    return value;
  };

  const snapshot = ({ cwd, sessionKey, turn, phase }) => runOp(async () => {
    const root = await canonicalCwd(cwd);
    const ref = requireRef(sessionKey, turn, phase);
    await requireAttrSupport();
    const { gitDir, indexFile } = await ensureShadow(root);
    return withLock(gitDir, async (opId) => withExcludes(root, async (excludesFile) => {
      const git = runGit({ cwd: root, gitDir, indexFile, excludesFile });
      const nested = await nestedRepos({ cwd: root, gitDir, excludesFile, opId });
      const pathspecs = ['.', ':(exclude).git', ...nested.map((dir) => `:(exclude,literal)${dir}`)];
      await git(['add', '-A', '--', ...pathspecs]);
      const tree = (await git(['write-tree'])).stdout.trim();
      requireTree(tree, 'snapshot');
      await git(['update-ref', ref, tree]);
      return { tree };
    }));
  });

  // Split one `git diff` run into per-file patches keyed by path. Rename
  // detection stays OFF (`--no-renames`), so the `a/` and `b/` paths are
  // always identical and the boundary between them is unambiguous — even
  // for paths with spaces, which git does not quote with quotepath=false.
  const splitPatches = (patchText) => {
    const patches = new Map();
    const starts = [...patchText.matchAll(/^diff --git a\/(.*) b\/\1\r?$/gm)];
    // Fallback for quoted paths (should not happen with quotepath=false,
    // but a `core.quotePath=true` user config must not silently drop patches).
    const fallback = starts.length === 0
      ? [...patchText.matchAll(/^diff --git "a\/(.+)" "b\/(.+)"\r?$/gm)]
      : [];
    const all = starts.length > 0 ? starts : fallback;
    for (let i = 0; i < all.length; i += 1) {
      const match = all[i];
      const file = starts.length > 0 ? (match[1] ?? '') : (match[2] ?? match[1] ?? '');
      const begin = match.index ?? 0;
      const end = i + 1 < all.length ? (all[i + 1].index ?? patchText.length) : patchText.length;
      // A quoted path may carry C escapes; unquote the common ones so the
      // key matches the `-z` name-status path it is joined with.
      const key = starts.length > 0 ? file : file.replace(/\\([\\"])/g, '$1');
      patches.set(key, patchText.slice(begin, end));
    }
    return patches;
  };

  const diff = ({ cwd, from, to }) => runOp(async () => {
    const root = await canonicalCwd(cwd);
    requireTree(from, 'diff from');
    requireTree(to, 'diff to');
    const { gitDir } = await ensureShadow(root);
    return withLock(gitDir, async (opId) => withExcludes(root, async (excludesFile) => {
      // Tree-to-tree: no index involved, so a scratch path that never exists.
      const git = runGit({ cwd: root, gitDir, indexFile: path.join(gitDir, `diff-${process.pid}-${opId}.idx`), excludesFile });
      const [status, counts, patch] = await Promise.all([
        git(['diff', '--no-renames', '--name-status', '-z', from, to]),
        git(['diff', '--no-renames', '--numstat', '-z', from, to]),
        git(['diff', '--no-color', '--no-ext-diff', '-U3', '--src-prefix=a/', '--dst-prefix=b/', '--no-renames', from, to, '--', '.']),
      ]);
      const kinds = new Map();
      const statusFields = status.stdout.split('\0').filter(Boolean);
      for (let i = 0; i + 1 < statusFields.length; i += 2) {
        kinds.set(statusFields[i + 1], statusFields[i]);
      }
      const numbers = new Map();
      for (const entry of counts.stdout.split('\0').filter(Boolean)) {
        const [added, deleted, file] = entry.split('\t');
        if (file !== undefined) numbers.set(file, { additions: added === '-' ? 0 : Number(added), deletions: deleted === '-' ? 0 : Number(deleted) });
      }
      const patches = splitPatches(patch.stdout);
      return [...kinds.entries()].map(([file, kind]) => ({
        file,
        patch: patches.get(file) ?? '',
        additions: numbers.get(file)?.additions ?? 0,
        deletions: numbers.get(file)?.deletions ?? 0,
        status: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified',
      })).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    }));
  });

  // Full membership of one tree: path → { mode, sha }. `ls-tree -r` lists
  // blobs (and the commit entries for gitlinks, which restore refuses).
  const treeEntries = async (git, tree) => {
    let stdout;
    try {
      ({ stdout } = await git(['ls-tree', '-r', '-z', tree]));
    } catch (error) {
      throw new AcpCheckpointsError('ACP_CHECKPOINT_UNKNOWN_TREE', `No checkpoint tree ${tree} for this project.`, { cause: error });
    }
    const entries = new Map();
    for (const record of stdout.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const [meta, file] = [record.slice(0, tab), record.slice(tab + 1)];
      const [mode, type, sha] = meta.split(' ');
      if (!mode || !type || !sha || file === '') continue;
      entries.set(file, { mode, type, sha });
    }
    return entries;
  };

  // Stream `cat-file --batch` for many blobs with O(largest blob) memory:
  // each blob is written to its own temp file as its bytes arrive, so no
  // maxBuffer caps the restorable size. Framing is validated strictly
  // (`<sha> blob <size>\n<size bytes>\n`, in request order); any skew
  // aborts the restore. Resolves sha → temp-file path.
  const streamBlobsToFiles = async ({ cwd, gitDir, indexFile, excludesFile, stagingDir, shas }) => {
    const outputs = new Map();
    if (shas.length === 0) return outputs;
    const fullArgs = await gitArgs(['cat-file', '--batch']);
    const env = {
      ...baseEnv,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: cwd,
      GIT_INDEX_FILE: indexFile,
      ...(excludesFile
        ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludesFile }
        : {}),
    };
    await new Promise((resolve, reject) => {
      const child = spawn(git, fullArgs, { cwd, windowsHide: true, env });
      // Chunk-list accumulator: appending is O(1) per chunk (a per-chunk
      // Buffer.concat would be O(n²) in blob size — 65 MiB × 1k chunks
      // OOMed a 4 GiB heap). Bytes are consumed via a cursor; a blob's
      // chunks are concatenated exactly once, when complete.
      let bufs = [];
      let buflen = 0;
      let failed = false;
      const fail = (error) => {
        if (failed) return;
        failed = true;
        try { child.kill(); } catch { /* already gone */ }
        reject(error);
      };
      const failGit = (message) => fail(new AcpCheckpointsError('ACP_CHECKPOINT_GIT_FAILED', `git cat-file --batch ${message}.`));
      const failUnknown = (sha) => fail(new AcpCheckpointsError('ACP_CHECKPOINT_UNKNOWN_TREE', `Checkpoint object ${sha} is missing from this project.`));
      // The writer chain serializes blob file writes in batch order.
      let chain = Promise.resolve();
      let index = 0;
      let current = null;
      let stderrTail = '';
      const timer = setTimeout(() => failGit(`timed out after ${timeoutMs} ms`), timeoutMs);
      // Consume exactly `n` buffered bytes (n ≤ buflen) as one Buffer.
      const take = (n) => {
        const parts = [];
        let left = n;
        while (left > 0) {
          const head = bufs[0];
          if (head.length <= left) {
            parts.push(head);
            bufs = bufs.slice(1);
            left -= head.length;
          } else {
            parts.push(head.subarray(0, left));
            bufs[0] = head.subarray(left);
            left = 0;
          }
        }
        buflen -= n;
        return parts.length === 1 ? parts[0] : Buffer.concat(parts);
      };
      // Offset of the next `\n` in the buffer, or -1. Headers are one
      // short line; scan chunk by chunk without concatenating.
      const indexOfNewline = () => {
        let base = 0;
        for (const buf of bufs) {
          const at = buf.indexOf(0x0a);
          if (at !== -1) return base + at;
          base += buf.length;
        }
        return -1;
      };
      const pump = () => {
        for (;;) {
          if (!current) {
            const endOfHeader = indexOfNewline();
            if (endOfHeader === -1) return;
            const header = take(endOfHeader).toString('utf8');
            take(1); // the newline itself
            const [sha, type, sizeText] = header.split(' ');
            const size = Number(sizeText);
            if (type === 'missing') return void failUnknown(sha);
            if (sha !== shas[index] || type !== 'blob' || !Number.isInteger(size) || size < 0) {
              return void failGit('answered out of order');
            }
            index += 1;
            current = { sha, size, chunks: [], got: 0 };
          }
          // Content bytes plus the trailing newline delimiter.
          const need = current.size - current.got + 1;
          if (buflen < need) {
            current.chunks.push(...bufs);
            current.got += buflen;
            bufs = [];
            buflen = 0;
            return;
          }
          if (need > 1) current.chunks.push(take(need - 1));
          if (take(1)[0] !== 0x0a) return void failGit('has a framing error');
          const done = current;
          current = null;
          chain = chain.then(async () => {
            const temp = path.join(stagingDir, `blob-${done.sha}`);
            await fs.writeFile(temp, done.chunks.length === 1 ? done.chunks[0] : Buffer.concat(done.chunks));
            outputs.set(done.sha, temp);
          }).catch(fail);
        }
      };
      child.stdout.on('data', (chunk) => {
        if (failed) return;
        bufs.push(chunk);
        buflen += chunk.length;
        pump();
      });
      child.stderr.on('data', (chunk) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-512);
      });
      child.on('error', (error) => failGit(`failed to start: ${error.message}`));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failed) return;
        chain.then(() => {
          if (code !== 0 || index !== shas.length || current) {
            failGit(`exited ${code ?? 'unknown'}${stderrTail ? `: ${stderrTail.trim().slice(0, 300)}` : ''}`);
            return;
          }
          resolve();
        }, fail);
      });
      child.stdin.on('error', () => { /* git may exit before reading; close carries the outcome */ });
      child.stdin.write(`${shas.join('\n')}\n`);
      child.stdin.end();
    });
    return outputs;
  };

  const restore = ({ cwd, tree, current }) => runOp(async () => {
    const root = await canonicalCwd(cwd);
    requireTree(tree, 'restore');
    if (current !== undefined) requireTree(current, 'restore current');
    const { gitDir, indexFile } = await ensureShadow(root);
    return withLock(gitDir, async (opId) => withExcludes(root, async (excludesFile) => {
      const scratchIndex = path.join(gitDir, `restore-${process.pid}-${opId}.idx`);
      const opts = { cwd: root, gitDir, indexFile: scratchIndex, excludesFile };
      const git = runGit(opts);
      try {
        return await restoreInner({ root, gitDir, indexFile, opts, git, excludesFile, opId, tree, current });
      } finally {
        await fs.rm(scratchIndex, { force: true });
      }
    }));
  });

  const restoreInner = async ({ root, gitDir, indexFile, opts, git, excludesFile, opId, tree, current }) => {
      // Membership first, work tree second. The target tree decides what is
      // written; the CURRENT tree (explicit, else the warm work index
      // captured fresh) decides what may be deleted: members of current
      // absent from target. Members of neither tree are never touched.
      const [target, currentEntries] = await Promise.all([
        treeEntries(git, tree),
        current !== undefined
          ? treeEntries(git, current)
          : (async () => {
            const work = runGit({ cwd: root, gitDir, indexFile, excludesFile });
            const currentTree = (await work(['write-tree'])).stdout.trim();
            requireTree(currentTree, 'restore current');
            return treeEntries(git, currentTree);
          })(),
      ]);
      // Ignored paths are never written or deleted (`--no-index`: the
      // scratch index holds the target tree, which would otherwise suppress
      // matches for tracked paths). This covers target members hidden by a
      // newly added ignore rule as well as deletion candidates.
      const deletionCandidates = [...currentEntries.keys()].filter((file) => !target.has(file));
      // Fast path: git's stat engine (racy-aware) names the target members
      // whose work-tree bytes may differ — reading every file to compare
      // bytes costs ~14 s on a 3.6k-file tree. The scratch index is seeded
      // from the target tree, so this diff reports exactly modified,
      // deleted and type-changed target members. Membership still comes
      // from the trees above; this only narrows the write set.
      await git(['read-tree', tree]);
      const { stdout: changedOut } = await git(['diff', '--no-renames', '--name-only', '-z', tree, '--', '.', ':(exclude).git']);
      const changed = new Set(changedOut.split('\0').filter(Boolean));
      const writeCandidates = [...target.keys()].filter((file) => changed.has(file));
      const ignored = await checkIgnored(opts, [...new Set([...deletionCandidates, ...writeCandidates])]);

      // Ancestor validation, run IMMEDIATELY before each mutation (not only
      // in a batch preflight): every ancestor must still be a real directory
      // — no symlink/junction, no nested repo (a `.git` dir or gitfile marks
      // a boundary restore must not cross). `allowCreate` (writes only)
      // creates missing ancestors; deletion inspects read-only and refuses
      // absent ancestors without mutating.
      //
      // Residual race (documented, accepted): Node has no handle-relative
      // filesystem API, so a hostile local actor racing the microseconds
      // between this lstat and the mutation could still swap a parent.
      // Threat model is a single-user tool restoring while the turn is idle;
      // full confinement would need a platform helper holding verified
      // directory handles across the mutation.
      const checkAncestors = async (file, { allowCreate }) => {
        const parts = file.split('/');
        let at = root;
        for (const part of parts.slice(0, -1)) {
          at = path.join(at, part);
          let stats;
          try {
            stats = await fs.lstat(at);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (!allowCreate) return 'absent-ancestor';
            try {
              await fs.mkdir(at);
            } catch (mkdirError) {
              if (mkdirError.code === 'EEXIST') return 'obstructed-ancestor';
              throw mkdirError;
            }
            continue;
          }
          if (stats.isSymbolicLink() || !stats.isDirectory()) return 'obstructed-ancestor';
          // A directory that became a repository boundary since the snapshot
          // (or always was one above a captured path) is refused: restore
          // never writes into or deletes from a nested repo.
          try {
            const dotGit = await fs.lstat(path.join(at, '.git'));
            if (!dotGit.isSymbolicLink()) return 'nested-repo';
            return 'obstructed-ancestor';
          } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
          }
        }
        return null;
      };

      const restored = [];
      const removed = [];
      const skipped = [];
      const skip = (file, reason) => skipped.push({ file, reason });

      // Write target members. Refusals, never force:
      // - ignored members (a new ignore rule since the snapshot hides them);
      // - gitlinks and non-blobs: content we cannot reproduce;
      // - `.git` members (a snapshot must never contain them, but refuse anyway);
      // - an obstructing symlink/junction, non-directory or nested-repo ancestor;
      // - an obstructing symlink, non-empty directory or nested repo at the path.
      const writable = [];
      for (const [file, entry] of target) {
        // Unchanged per git's stat engine: bytes already match, nothing to do.
        if (!changed.has(file)) continue;
        if (ignored.has(file)) {
          skip(file, 'ignored');
          continue;
        }
        if (file === '.git' || file.startsWith('.git/')) {
          skip(file, 'protected');
          continue;
        }
        if (entry.type !== 'blob') {
          skip(file, entry.type === 'commit' ? 'gitlink' : 'non-blob');
          continue;
        }
        const absolute = path.join(root, file);
        if (!withinRoot(root, absolute)) {
          skip(file, 'outside-root');
          continue;
        }
        let ancestorRefusal;
        try {
          ancestorRefusal = await checkAncestors(file, { allowCreate: true });
        } catch (error) {
          throw new AcpCheckpointsError('ACP_CHECKPOINT_RESTORE_FAILED', `Could not prepare ${file}: ${error.message}`, { cause: error });
        }
        if (ancestorRefusal) {
          skip(file, ancestorRefusal);
          continue;
        }
        let stats;
        try {
          stats = await fs.lstat(absolute);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          writable.push({ file, absolute, entry });
          continue;
        }
        if (stats.isSymbolicLink()) {
          skip(file, 'would-replace-symlink');
          continue;
        }
        if (stats.isDirectory()) {
          let entries;
          try {
            entries = await fs.readdir(absolute);
          } catch (error) {
            if (error.code === 'ENOENT') {
              writable.push({ file, absolute, entry });
              continue;
            }
            throw error;
          }
          if (entries.length > 0) {
            skip(file, entries.includes('.git') ? 'nested-repo' : 'non-empty-dir');
            continue;
          }
          writable.push({ file, absolute, entry, removeEmptyDir: true });
          continue;
        }
        writable.push({ file, absolute, entry });
      }

      const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-acp-blobs-'));
      try {
        const blobFiles = await streamBlobsToFiles({
          cwd: root, gitDir, indexFile: opts.indexFile, excludesFile, stagingDir,
          shas: [...new Set(writable.map((w) => w.entry.sha))],
        });
        for (const { file, absolute, entry, removeEmptyDir } of writable) {
          // Revalidate ancestors immediately before the mutation: a parent
          // swapped (junction, repo init, replacement) after the preflight
          // above must refuse, not write through.
          let ancestorRefusal;
          try {
            ancestorRefusal = await checkAncestors(file, { allowCreate: true });
          } catch (error) {
            throw new AcpCheckpointsError('ACP_CHECKPOINT_RESTORE_FAILED', `Could not prepare ${file}: ${error.message}`, { cause: error });
          }
          if (ancestorRefusal) {
            skip(file, ancestorRefusal);
            continue;
          }
          const blobFile = blobFiles.get(entry.sha);
          if (blobFile === undefined) {
            throw new AcpCheckpointsError('ACP_CHECKPOINT_UNKNOWN_TREE', `Checkpoint object ${entry.sha} is missing from this project.`);
          }
          try {
            if (removeEmptyDir) {
              // The dir was empty at preflight; refuse if it gained content.
              const now = await fs.readdir(absolute).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
              if (now === null) {
                // vanished — proceed to write the file
              } else if (now.length > 0) {
                skip(file, now.includes('.git') ? 'nested-repo' : 'non-empty-dir');
                continue;
              } else {
                await fs.rmdir(absolute);
              }
            }
            // Only files whose bytes or mode actually change are listed as
            // restored; identical files are left alone (and unreported).
            // Size first: a size mismatch proves a change without reading.
            let changedBytes = false;
            let existingStats;
            try {
              existingStats = await fs.lstat(absolute);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
            if (!existingStats) {
              changedBytes = true;
            } else if (existingStats.isSymbolicLink() || existingStats.isDirectory()) {
              skip(file, existingStats.isSymbolicLink() ? 'would-replace-symlink' : 'non-empty-dir');
              continue;
            } else if (existingStats.size !== (await fs.stat(blobFile)).size) {
              changedBytes = true;
            } else {
              const [existing, content] = await Promise.all([fs.readFile(absolute), fs.readFile(blobFile)]);
              changedBytes = !existing.equals(content);
            }
            let mutated = removeEmptyDir === true;
            if (changedBytes) {
              // Atomic rename lands the bytes; copyFile streams blob→temp
              // without holding the whole file in JS memory twice.
              const temp = path.join(path.dirname(absolute), `.openchamber-restore-${process.pid}-${opId}.tmp`);
              await fs.copyFile(blobFile, temp);
              await fs.rename(temp, absolute);
              mutated = true;
            }
            const wantMode = entry.mode === '100755' ? 0o755 : entry.mode === '100644' ? 0o644 : null;
            if (wantMode !== null && process.platform !== 'win32') {
              const currentMode = (await fs.stat(absolute)).mode & 0o777;
              if (currentMode !== wantMode) {
                await fs.chmod(absolute, wantMode);
                mutated = true;
              }
            }
            if (mutated) restored.push(file);
          } catch (error) {
            if (error instanceof AcpCheckpointsError) throw error;
            throw new AcpCheckpointsError('ACP_CHECKPOINT_RESTORE_FAILED', `Could not restore ${file}: ${error.message}`, { cause: error });
          }
        }
      } finally {
        await fs.rm(stagingDir, { recursive: true, force: true });
      }

      // Delete current-members absent from target. Refusals, never force:
      // - ignored paths (a new ignore rule since the snapshot hides them);
      // - `.git` members; paths outside the root (defensive);
      // - symlinks/junctions (never traverse or unlink reparse points);
      // - non-empty directories, nested repos (at the path or any ancestor).
      for (const file of deletionCandidates) {
        if (ignored.has(file)) {
          skip(file, 'ignored');
          continue;
        }
        if (file === '.git' || file.startsWith('.git/')) {
          skip(file, 'protected');
          continue;
        }
        const absolute = path.join(root, file);
        if (!withinRoot(root, absolute)) {
          skip(file, 'outside-root');
          continue;
        }
        // Read-only inspection: absent ancestors stop the deletion without
        // recreating anything; revalidated immediately before the unlink.
        const inspectAncestors = async () => {
          try {
            return await checkAncestors(file, { allowCreate: false });
          } catch (error) {
            throw new AcpCheckpointsError('ACP_CHECKPOINT_RESTORE_FAILED', `Could not inspect ${file}: ${error.message}`, { cause: error });
          }
        };
        const preflight = await inspectAncestors();
        if (preflight) {
          if (preflight !== 'absent-ancestor') skip(file, preflight);
          continue;
        }
        let stats;
        try {
          stats = await fs.lstat(absolute);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (stats.isSymbolicLink()) {
          skip(file, 'symlink');
          continue;
        }
        if (stats.isDirectory()) {
          let entries;
          try {
            entries = await fs.readdir(absolute);
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          if (entries.length > 0) {
            skip(file, entries.includes('.git') ? 'nested-repo' : 'non-empty-dir');
            continue;
          }
          const refusal = await inspectAncestors();
          if (refusal) {
            if (refusal !== 'absent-ancestor') skip(file, refusal);
            continue;
          }
          const now = await fs.readdir(absolute).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
          if (now === null) continue;
          if (now.length > 0) {
            skip(file, now.includes('.git') ? 'nested-repo' : 'non-empty-dir');
            continue;
          }
          await fs.rmdir(absolute);
          removed.push(file);
          continue;
        }
        // Revalidate immediately before the unlink.
        const refusal = await inspectAncestors();
        if (refusal) {
          if (refusal !== 'absent-ancestor') skip(file, refusal);
          continue;
        }
        const current = await fs.lstat(absolute).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
        if (current === null) continue;
        if (current.isSymbolicLink() || current.isDirectory()) {
          skip(file, current.isSymbolicLink() ? 'symlink' : 'non-empty-dir');
          continue;
        }
        await fs.rm(absolute, { force: true });
        removed.push(file);
      }
      return { restored, removed, skipped };
  };

  // `check-ignore` exits 1 when none of its inputs is ignored: that is the
  // common case, not a failure. `--no-index` evaluates ignore rules only,
  // ignoring scratch-index membership (which would otherwise suppress
  // matches for tracked paths).
  const checkIgnored = async (opts, files) => {
    const ignored = new Set();
    if (files.length === 0) return ignored;
    const stdin = `${files.join('\0')}\0`;
    const check = runGit({ ...opts, stdin });
    let stdout = '';
    try {
      ({ stdout } = await check(['check-ignore', '--no-index', '-z', '--stdin']));
    } catch (error) {
      if (error.cause?.code !== 1) throw error;
      stdout = error.cause?.stdout ?? '';
    }
    for (const file of String(stdout).split('\0').filter(Boolean)) ignored.add(file);
    return ignored;
  };

  const gcOneRepo = async (gitDir, sessionKey) => withLock(gitDir, async (opId) => {
    // Ref I/O only, no work tree. `cwd` still points at the data dir so
    // a relative `gitDir` could never resolve against the server cwd.
    const git = runGit({ cwd: dataDir, gitDir, indexFile: path.join(gitDir, 'index') });
    const prefix = `${REF_NAMESPACE}${sessionKey}/`;
    let refs;
    try {
      refs = await git(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
    } catch (error) {
      if (/not a git repository|bad revision/i.test(error.message)) return 0;
      throw error;
    }
    const lines = refs.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return 0;
    const stdin = `${lines.map((line) => `delete ${line}`).join('\n')}\n`;
    const batch = runGit({ cwd: dataDir, gitDir, indexFile: path.join(gitDir, 'index'), stdin });
    await batch(['update-ref', '--stdin']);
    // The warm work index pins its blobs (gc roots); run the prune with
    // a scratch index so what the deleted refs released is collected.
    // The repo lock is held throughout, so no other store can write
    // objects between the ref deletion and the prune.
    const emptyIndex = path.join(gitDir, `gc-${process.pid}-${opId}.idx`);
    await fs.rm(emptyIndex, { force: true });
    try {
      const pristine = runGit({ cwd: dataDir, gitDir, indexFile: emptyIndex });
      await pristine(['gc', '--prune=now', '--quiet']);
    } finally {
      await fs.rm(emptyIndex, { force: true });
    }
    return lines.length;
  });

  const gc = ({ sessionKey, cwd } = {}) => runOp(async () => {
    if (typeof sessionKey !== 'string' || !REF_SEGMENT.test(sessionKey)) {
      throw new AcpCheckpointsError('ACP_CHECKPOINT_INVALID_SESSION_KEY', `Not a checkpoint session key: ${JSON.stringify(sessionKey)}`);
    }
    // Targeted when the session's project is known: one repo, no sweep.
    // A project that never snapshotted has no shadow repo: no-op, like an
    // unknown session — checked before the lock, which needs the dir.
    if (cwd !== undefined) {
      const root = await canonicalCwd(cwd);
      const gitDir = shadowDirFor(dataDir, root);
      try {
        await fs.stat(path.join(gitDir, 'HEAD'));
      } catch (error) {
        if (error.code === 'ENOENT') return { deletedRefs: 0 };
        throw error;
      }
      return { deletedRefs: await gcOneRepo(gitDir, sessionKey) };
    }
    // Recovery sweep only: ref deletion plus a prune of newly unreachable
    // objects across shadow repos. The session→cwd mapping lives in the
    // sidecar index (a later phase), which will call with `cwd`.
    let entries;
    try {
      entries = await fs.readdir(path.join(dataDir, 'checkpoints'), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return { deletedRefs: 0 };
      throw error;
    }
    let deletedRefs = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
      deletedRefs += await gcOneRepo(path.join(dataDir, 'checkpoints', entry.name), sessionKey);
    }
    return { deletedRefs };
  });

  /**
   * Release store-owned temp resources (the no-hooks dir and the
   * no-attributes dir). Closes admission first — new ops fail with
   * ACP_CHECKPOINT_DISPOSED — then awaits in-flight operations before
   * awaiting the in-flight creations and removing the dirs. Ops register
   * synchronously at call time, so a snapshot that started pre-dispose is
   * always awaited and cannot leak dirs created post-dispose. Idempotent
   * and safe when temps were never created.
   */
  const dispose = () => {
    if (!disposePromise) {
      disposeStarted = true;
      disposePromise = (async () => {
        await Promise.allSettled([...activeOps]);
        const [hooks, attrs] = await Promise.all([
          hooksDirPromise?.catch(() => null),
          emptyAttrs.promise?.catch(() => null),
        ]);
        await Promise.all([
          hooks ? fs.rm(hooks, { recursive: true, force: true }).catch(() => {}) : null,
          emptyAttrs.path ? fs.rm(path.dirname(emptyAttrs.path), { recursive: true, force: true }).catch(() => {}) : null,
          attrs && attrs !== emptyAttrs.path
            ? fs.rm(path.dirname(attrs), { recursive: true, force: true }).catch(() => {})
            : null,
        ]);
      })();
    }
    return disposePromise;
  };

  // Testing hook: the exact temp dirs this store owns (the no-hooks dir
  // and the no-attributes dir), so dispose tests assert on this store's
  // own paths instead of scanning the process-global temp dir. Empty when
  // temps were never created; still listed after dispose (now removed).
  const __testOnly = {
    ownedTempDirs: async () => {
      const [hooks, attrs] = await Promise.all([
        hooksDirPromise?.catch(() => null),
        emptyAttrs.promise?.catch(() => null),
      ]);
      const dirs = [];
      if (hooks) dirs.push(hooks);
      const attrsFile = emptyAttrs.path ?? attrs;
      if (attrsFile) dirs.push(path.dirname(attrsFile));
      if (attrs && attrs !== emptyAttrs.path) dirs.push(path.dirname(attrs));
      return [...new Set(dirs)];
    },
  };

  return { snapshot, diff, restore, gc, dispose, __testOnly };
}
