/**
 * Spawning an ACP agent child process.
 *
 * Windows cannot spawn `.cmd`/`.bat` shims with `shell: false` (a bare name
 * fails with ENOENT, an absolute path with a synchronous EINVAL), so those
 * need special handling:
 *
 * 1. Standard npm `.cmd` shims (the `"%dp0%\node_modules\..." %*` /
 *    `"%_prog%" "..." %*` forms) are resolved to their underlying target and
 *    spawned directly — argv then round-trips byte-exact through CreateProcess
 *    with no shell parsing at all.
 * 2. Any other batch file goes through `cmd.exe /d /s /c` with strict
 *    escaping. cmd's parser makes `%` and newline impossible to pass through
 *    losslessly (`%NAME%` always expands, even inside quotes), so arguments
 *    containing `%`, carriage returns or line feeds are refused with
 *    `ACP_SPAWN_UNSAFE_ARG` rather than silently corrupted or, worse,
 *    executed. Everything else (`&|<>()^;!,"` and whitespace) is neutralized
 *    by always quoting plus caret-escaping the metacharacters that stay
 *    active inside quotes.
 *
 * Everything else spawns directly with piped stdio.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { overlayEnvironment } from '../../environment/variables.js';
import {
  readProcessStartTimeMs,
  registerManagedProcess,
  unregisterManagedProcess,
} from '../../opencode/managed-process-registry.js';
import { findExecutableOnPath } from '../../tunnels/executable-search.js';

/** Bytes of stderr kept per child; the tail surfaces in backend status. */
export const STDERR_RING_BYTES = 64 * 1024;

export class AcpSpawnError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AcpSpawnError';
    if (code !== undefined) this.code = code;
  }
}

/**
 * Resolve `command` to something spawnable: an absolute path when it names a
 * file (with PATHEXT probing on Windows), else a PATH lookup. Returns null
 * when nothing resolves.
 */
export const resolveAcpCommand = (command, { env = process.env, platform = process.platform, fsLike = fs } = {}) => {
  if (typeof command !== 'string' || !command.trim()) return null;
  const trimmed = command.trim();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const looksLikePath = trimmed.includes('/') || trimmed.includes('\\')
    || (platform === 'win32' && /^[a-zA-Z]:/.test(trimmed));

  if (looksLikePath) {
    const candidates = [trimmed];
    if (platform === 'win32' && !pathApi.extname(trimmed)) {
      const pathext = env.PATHEXT || env.PathExt || env.pathext || '.COM;.EXE;.BAT;.CMD';
      for (const ext of pathext.split(';')) {
        const normalized = ext.trim();
        if (normalized) candidates.push(`${trimmed}${normalized.startsWith('.') ? normalized : `.${normalized}`}`);
      }
    }
    for (const candidate of candidates) {
      try {
        if (fsLike.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep probing
      }
    }
    return null;
  }

  return findExecutableOnPath(trimmed, { env, platform, fsLike });
};

const isBatchFile = (resolvedPath) => {
  const ext = path.win32.extname(resolvedPath).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
};

// npm's cmd-shim generates exactly two templates (https://github.com/npm/cmd-shim).
// Direct (native binary target):
//   @ECHO off
//   GOTO start
//   :find_dp0
//   SET dp0=%~dp0
//   EXIT /b
//   :start
//   SETLOCAL
//   CALL :find_dp0
//   "%dp0%\<target>"   %*
// Node (script target behind the standard `_prog` launcher selection):
//   @ECHO off
//   GOTO start
//   :find_dp0
//   SET dp0=%~dp0
//   EXIT /b
//   :start
//   SETLOCAL
//   CALL :find_dp0
//
//   IF EXIST "%dp0%\node.exe" (
//     SET "_prog=%dp0%\node.exe"
//   ) ELSE (
//     SET "_prog=node"
//     SET PATHEXT=%PATHEXT:;.JS;=;%
//   )
//
//   endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\<script>" %*
// Recognition requires the WHOLE file to be one of these templates (modulo
// blank lines and CRLF): a custom wrapper that merely contains a similar
// invocation line — env setup, a non-node `_prog`, trailing commands —
// would run with different semantics if its target were spawned directly,
// so it keeps the cmd fallback below.
const SHIM_HEADER = '@echo off|goto start|:find_dp0|set dp0=%~dp0|exit /b|:start|setlocal|call :find_dp0';
const SHIM_PROG_BLOCK = 'if exist "%dp0%\\node.exe" (|set "_prog=%dp0%\\node.exe"|) else (|set "_prog=node"|set pathext=%pathext:;.js;=;%|)';
const SHIM_PROG_TAIL = 'endlocal & goto #_undefined_# 2>nul || title %comspec% & "%_prog%"';

const MAX_SHIM_BYTES = 64 * 1024;

const shimLines = (text) => text
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('REM ') && !line.startsWith('::'));

/**
 * Match the full npm cmd-shim grammar. Returns `{ target, node }` where
 * `target` is the `%dp0%`-relative target and `node` is true for the
 * `_prog` template, or null for anything else — including near-misses
 * with extra setup, a different launcher, or trailing commands.
 */
const matchNpmShimTemplate = (text) => {
  const lines = shimLines(text);
  const lower = lines.map((line) => line.toLowerCase());
  const header = SHIM_HEADER.split('|');
  if (lower.length < header.length + 1) return null;
  for (let i = 0; i < header.length; i++) {
    if (lower[i] !== header[i]) return null;
  }
  const rest = lines.slice(header.length);
  const restLower = lower.slice(header.length);
  // Direct template: exactly one invocation line after the header.
  if (rest.length === 1) {
    const direct = rest[0].match(/^"(%dp0%\\[^"\r\n]+)"\s+%+\*\s*$/i);
    if (!direct) return null;
    return { target: direct[1], node: false };
  }
  // Node template: the exact _prog block, then exactly the tail line.
  const progBlock = SHIM_PROG_BLOCK.split('|');
  if (restLower.length !== progBlock.length + 1) return null;
  for (let i = 0; i < progBlock.length; i++) {
    if (restLower[i] !== progBlock[i]) return null;
  }
  const tail = rest[progBlock.length];
  if (!tail.toLowerCase().startsWith(SHIM_PROG_TAIL)) return null;
  const invocation = tail.slice(SHIM_PROG_TAIL.length).trim();
  const script = invocation.match(/^"(%dp0%\\[^"\r\n]+)"\s+%+\*\s*$/i);
  if (!script) return null;
  return { target: script[1], node: true };
};

/**
 * Resolve a standard npm `.cmd` shim to its underlying target so it can be
 * spawned directly with no shell. Returns `{ file, prefixArgs }` (`prefixArgs`
 * is `[script]` when the target needs a `node` launcher, else `[]`), or null
 * when the file is not exactly a standard npm template.
 */
export const resolveNpmCmdShim = (shimPath, { fsLike = fs } = {}) => {
  let text;
  try {
    const stat = fsLike.statSync(shimPath);
    if (!stat.isFile() || stat.size > MAX_SHIM_BYTES) return null;
    text = fsLike.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const match = matchNpmShimTemplate(text);
  if (!match) return null;
  const shimDir = path.win32.dirname(shimPath);
  // `%dp0%` is the shim's own directory with a trailing backslash.
  const target = path.win32.normalize(match.target.replace(/%dp0%/gi, `${shimDir}\\`));
  try {
    if (!fsLike.statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  if (!match.node) {
    // A native binary (or anything directly executable): no launcher.
    if (isBatchFile(target)) return null;
    return { file: target, prefixArgs: [] };
  }
  // The standard template launches `%_prog%`: the shim dir's bundled
  // node.exe when present, else `node` from PATH. Mirror exactly that
  // selection (plus the current runtime as a last resort, which the shim
  // would resolve through PATH anyway).
  const bundledNode = path.win32.join(shimDir, 'node.exe');
  try {
    if (fsLike.statSync(bundledNode).isFile()) return { file: bundledNode, prefixArgs: [target] };
  } catch {
    // fall through
  }
  const pathNode = findExecutableOnPath('node', { fsLike });
  if (pathNode) return { file: pathNode, prefixArgs: [target] };
  return { file: process.execPath, prefixArgs: [target] };
};

// Arguments that can never survive cmd's parser:
// - `%` always risks variable expansion (even inside quotes, even doubled —
//   doubling survives one parse level but `%*` forwarding re-parses);
// - CR/LF split commands;
// - a trailing backslash escapes the closing quote at the final CreateProcess
//   parse (no doubling survives both cmd levels — verified empirically).
// Refuse them rather than corrupt or execute them. LIMIT (accepted): a
// non-npm batch agent whose own path or required args contain `%` or end in
// `\` cannot be launched through cmd at all — point the registry entry at
// the underlying .exe or `node <script>` instead, which spawns directly.
const UNSAFE_CMD_ARG = /[%\r\n]/;
const TRAILING_BACKSLASH = /\\$/;

// Inside a double-quoted span quotes neutralize `&|<>()^;`, but `%` (refused
// above) and `"` itself need care: an embedded `"` doubles as `""`. Carets
// pass through untouched — doubling them would corrupt args for the common
// `%*`-forwarding shim, where the re-parse does not collapse `^^`.
const quoteForCmd = (value) => {
  if (UNSAFE_CMD_ARG.test(value) || TRAILING_BACKSLASH.test(value)) {
    throw new AcpSpawnError(
      `Cannot pass through cmd.exe: ${JSON.stringify(value.slice(0, 80))} (contains %, CR, LF, or a trailing backslash, which cmd always corrupts).`
      + ' Point the registry entry at the underlying .exe or `node <script>` instead of the batch wrapper.',
      { code: 'ACP_SPAWN_UNSAFE_ARG' },
    );
  }
  return `"${value.replace(/"/g, '""')}"`;
};

/**
 * Build the spawn target. On Windows a resolved batch file is first offered
 * npm-shim resolution (direct spawn, no shell); otherwise it becomes
 * `cmd.exe /d /s /c "<quoted command line>"` spawned with
 * `windowsVerbatimArguments`, because Node's default argv quoting escapes the
 * wrapping quotes and cmd then fails to recognize the command. Otherwise the
 * resolved path (or the bare command, letting the OS search PATH) spawns
 * directly.
 */
export const buildSpawnTarget = (command, args = [], { resolvedPath = null, platform = process.platform, fsLike = fs } = {}) => {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (platform === 'win32' && typeof resolvedPath === 'string' && isBatchFile(resolvedPath)) {
    const shim = resolveNpmCmdShim(resolvedPath, { fsLike });
    if (shim) {
      return { file: shim.file, argv: [...shim.prefixArgs, ...argv] };
    }
    // The executable path goes through the same strict quoting: it is
    // attacker-influenced (registry command) and equally parsed by cmd.
    const commandLine = [resolvedPath, ...argv].map(quoteForCmd).join(' ');
    return { file: 'cmd.exe', argv: ['/d', '/s', '/c', `"${commandLine}"`], windowsVerbatimArguments: true };
  }
  return { file: resolvedPath ?? command, argv };
};

const appendRing = (state, chunk) => {
  state.stderrTail += chunk;
  if (state.stderrTail.length > STDERR_RING_BYTES) {
    state.stderrTail = state.stderrTail.slice(-STDERR_RING_BYTES);
  }
};

const waitForClose = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve();
    return;
  }
  const timer = setTimeout(() => {
    child.removeListener('close', onClose);
    resolve();
  }, timeoutMs);
  const onClose = () => {
    clearTimeout(timer);
    resolve();
  };
  child.once('close', onClose);
});

/**
 * Kill the whole process tree: `taskkill /t /f` on Windows (child.kill only
 * ends the parent), process-group SIGTERM then SIGKILL after 2.5 s on POSIX.
 * Mirrors `lib/opencode/lifecycle.js` `terminateChildProcess`.
 */
export const killAcpProcessTree = async (child, { spawnSync = nodeSpawnSync, platform = process.platform } = {}) => {
  if (!child) return;
  const pid = child.pid;
  if (!Number.isInteger(pid)) {
    await waitForClose(child, 250);
    return;
  }
  if (platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // The process may already be gone; close-wait below settles it.
    }
    await waitForClose(child, 3000);
    return;
  }
  const signalTree = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Not our group (reparented) or already gone.
    }
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch {
      // Already gone.
    }
  };
  signalTree('SIGTERM');
  await waitForClose(child, 2500);
  signalTree('SIGKILL');
  await waitForClose(child, 1000);
};

/**
 * Spawn an ACP agent. Resolves the command, overlays `env` on
 * `process.env`, wraps batch files, and registers the child in the managed
 * process registry so a crash orphan gets reaped on next startup.
 *
 * Returns `{ child, resolvedPath, pid, getStderrTail(), kill() }`. `kill()`
 * takes the tree down and unregisters the pid.
 */
export const spawnAcpAgent = ({
  command,
  args = [],
  env,
  cwd,
  spawnImpl = nodeSpawn,
  registerProcess = registerManagedProcess,
  unregisterProcess = unregisterManagedProcess,
  readStartTime = readProcessStartTimeMs,
  envForResolve = process.env,
  platform = process.platform,
} = {}) => {
  if (typeof command !== 'string' || !command.trim()) {
    throw new AcpSpawnError('ACP backend command must be a non-empty string', { code: 'ACP_SPAWN_INVALID_COMMAND' });
  }
  const resolvedPath = resolveAcpCommand(command, { env: envForResolve, platform });
  if (!resolvedPath) {
    throw new AcpSpawnError(`ACP backend command not found on PATH: ${command}`, { code: 'ACP_COMMAND_NOT_FOUND' });
  }
  const { file, argv, windowsVerbatimArguments } = buildSpawnTarget(command, args, { resolvedPath, platform });
  const childEnv = env && typeof env === 'object'
    ? overlayEnvironment(process.env, env, platform === 'win32' ? ';' : ':')
    : process.env;

  let child;
  try {
    child = spawnImpl(file, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: lead a process group so the tree kill reaches grandchildren.
      // Windows has no process groups; `detached` there would detach the
      // console instead and break stdio teardown.
      ...(platform === 'win32' ? {} : { detached: true }),
      ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
      env: childEnv,
    });
  } catch (error) {
    // Synchronous spawn failures (Windows EINVAL on batch files spawned
    // directly, EMFILE, ...) throw instead of emitting 'error'.
    throw new AcpSpawnError(`Failed to spawn ACP agent ${command}: ${error?.message ?? error}`, {
      code: error?.code ?? 'ACP_SPAWN_FAILED',
      cause: error,
    });
  }

  const state = { stderrTail: '' };
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => appendRing(state, String(chunk)));

  const pid = child.pid;
  if (Number.isInteger(pid)) {
    // Identity for the orphan reaper: the actual spawn target (after shim
    // resolution) plus the full invocation, and the child's REAL OS
    // creation stamp — captured from the OS, never Date.now(), so a
    // recycled pid can never match. Fire-and-forget: registration must
    // never break or slow down the spawn.
    const spawnTargetForRegistry = platform === 'win32' && file === 'cmd.exe' ? resolvedPath : file;
    const invocationForRegistry = [file, ...argv].join(' ');
    Promise.resolve()
      .then(() => readStartTime(pid))
      .then((startTimeMs) => registerProcess({
        pid,
        ownerPid: process.pid,
        kind: 'acp',
        startTimeMs,
        command: spawnTargetForRegistry,
        invocation: invocationForRegistry,
      }))
      .catch(() => {});
  }

  let killed = false;
  const kill = async () => {
    if (killed) return;
    killed = true;
    try {
      await killAcpProcessTree(child, { platform });
    } finally {
      if (Number.isInteger(pid) && (child.exitCode !== null || child.signalCode !== null)) {
        await Promise.resolve(unregisterProcess(pid)).catch(() => {});
      }
    }
  };

  return {
    child,
    resolvedPath,
    pid,
    getStderrTail: () => state.stderrTail,
    kill,
  };
};

export const __testOnly = { quoteForCmd };
