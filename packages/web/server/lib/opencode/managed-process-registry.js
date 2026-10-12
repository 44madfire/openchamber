// Managed OpenCode process registry + orphan reaper.
//
// OpenChamber spawns the OpenCode server as an EXTERNAL child binary (on Unix
// with `detached: true`, so it leads its own process group). That binary can
// therefore outlive its parent if the parent is hard-killed/crashes/`Ctrl+C`ed
// before graceful teardown runs — leaving an orphaned `opencode serve` that
// then contends on the shared SQLite DB and slows everything down.
//
// We cannot tie an arbitrary external binary to the parent's death portably
// (Electron's `utilityProcess` would, but it only runs JS entrypoints, not a
// standalone binary). So we use the same pattern OpenCode's own CLI daemon uses
// for its detached server: an on-disk record of the pids WE spawned, plus a
// startup reaper that kills ONLY our own, verified, genuinely-orphaned
// processes — never a process a live instance (another desktop window, a VS
// Code host, the user's standalone `opencode`) is actively using.
//
// Storage: ONE FILE PER SPAWNED PROCESS in a registry directory, named
// `<childPid>.json`. Multiple runtimes (web/desktop/VS Code) and multiple
// windows all run concurrently; a single shared JSON file would be corrupted by
// the read-modify-write race (last writer wins, clobbering another instance's
// entry). Per-process files mean every instance only ever writes/deletes its
// OWN file, so there is no write contention at all.
//
// Safety model (why this never kills the wrong thing):
//   1. The reaper only ever considers pids THIS product recorded. The user's
//      standalone CLI server, the official desktop app, and the TUI are never
//      recorded, so they are never even candidates.
//   2. Before killing, it re-verifies the live pid is still an `opencode serve`
//      matching the recorded port (guards against the OS recycling a dead pid
//      onto an unrelated process).
//   3. It kills only when the spawning owner is provably gone — the child has
//      been reparented to init/pid 1, or the recorded owner pid is dead. A
//      child still owned by a live instance is left untouched.
//
// All filesystem and child-process operations here are ASYNCHRONOUS. The web
// server runs in-process inside the Electron main event loop (and other hosts),
// so any `spawnSync`/`*Sync` FS call blocks the single event loop — which also
// serves UI asset requests and realtime SSE traffic. The startup reaper can
// iterate several registry entries and, on Windows, each one spawns `tasklist`
// (100-500ms) and possibly `taskkill`; doing that synchronously stalls the
// whole process and is what caused the 1.13.3 `openchamber-ui://` lag
// regression (#1841). `execFile`/`fsp.*` keep the event loop responsive while
// the reaper waits on the kernel.
//
// The VS Code extension cannot import this module (it does not bundle the web
// package); it carries a parity implementation that reads/writes the SAME dir.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const defaultExecFileAsync = promisify(execFile);

const resolveRegistryDir = () => {
  const override = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.config', 'openchamber', 'managed-opencode');
};

const entryFilePath = (pid) => path.join(resolveRegistryDir(), `${pid}.json`);

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = process exists but we lack permission to signal it → still alive.
    return error?.code === 'EPERM';
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const commandIdentifiesOurServer = (command, entry) => {
  if (typeof command !== 'string') return false;
  const lower = command.toLowerCase();
  if (!lower.includes('opencode') || !lower.includes('serve')) return false;
  // Tie to the exact server we registered when we know its port, so a recycled
  // pid running a *different* opencode server is never mistaken for ours.
  if (Number.isInteger(entry.port) && !command.includes(String(entry.port))) return false;
  return true;
};

/**
 * Build the registry API over injectable filesystem and child-process
 * dependencies. Production callers use the default instance exported below;
 * tests pass their own `fs`/`execFileAsync` instead of mocking node builtins.
 */
export const createManagedProcessRegistry = ({ fs = fsp, execFileAsync = defaultExecFileAsync } = {}) => {
  const writeEntryFile = async (entry) => {
    const dir = resolveRegistryDir();
    try {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${entry.pid}.json`);
      const tmp = `${filePath}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(entry, null, 2));
      await fs.rename(tmp, filePath);
    } catch {
      // Best-effort: a failed registry write must never break spawn/shutdown.
    }
  };

  const readAllEntries = async () => {
    const dir = resolveRegistryDir();
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      const filePath = path.join(dir, name);
      try {
        const entry = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (entry && Number.isInteger(entry.pid)) {
          out.push({ entry, filePath });
        } else {
          await fs.rm(filePath, { force: true });
        }
      } catch {
        // Corrupt/partial file — drop it.
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          // ignore
        }
      }
    }
    return out;
  };

  /**
   * Record a process WE spawned so a future run can reap it if orphaned.
   * `kind` is `'opencode'` (default, legacy behavior) or `'acp'`; ACP
   * entries additionally record `startTimeMs` (OS-captured process creation
   * stamp — never wall-clock time), `command` (the resolved spawn target)
   * and `invocation` (the full spawn command line) so the reaper can verify
   * identity without trusting the pid alone.
   */
  const registerManagedProcess = async ({ pid, ownerPid, port, binary, runtime, kind, startTimeMs, command, invocation } = {}) => {
    if (!Number.isInteger(pid)) return;
    await writeEntryFile({
      pid,
      ownerPid: Number.isInteger(ownerPid) ? ownerPid : process.pid,
      port: Number.isInteger(port) ? port : null,
      binary: typeof binary === 'string' ? binary : null,
      runtime: typeof runtime === 'string' ? runtime : 'web',
      startedAt: new Date().toISOString(),
      ...(kind === 'acp'
        ? {
          kind: 'acp',
          startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : null,
          command: typeof command === 'string' ? command : null,
          invocation: typeof invocation === 'string' ? invocation : null,
        }
        : {}),
    });
  };

  /** Drop a pid from the registry (after we have killed/closed it ourselves). */
  const unregisterManagedProcess = async (pid) => {
    if (!Number.isInteger(pid)) return;
    try {
      await fs.rm(entryFilePath(pid), { force: true });
    } catch {
      // Best-effort: dropping a missing file is not an error.
    }
  };

  // Returns { ppid, command } for a live pid on Unix, or null if it can't be read.
  const readUnixProcInfo = async (pid) => {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const line = (stdout || '').trim();
      if (!line) return null;
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!match) return null;
      return { ppid: Number.parseInt(match[1], 10), command: match[2] };
    } catch {
      return null;
    }
  };

  // Windows image name for a pid (e.g. "opencode.exe"), or null.
  const readWindowsImageName = async (pid) => {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      return (stdout || '').trim() || null;
    } catch {
      return null;
    }
  };

  // Windows process identity for a pid: executable path + creation time +
  // full command line. `tasklist` reports none of these reliably; CIM does.
  // Returns null when unreadable. The creation time is the pid-recycling
  // guard: it is captured from the OS at registration (not Date.now()), so
  // a reused pid never matches.
  const readWindowsProcessIdentity = async (pid) => {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`
        + ' | Select-Object ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress',
      ], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(stdout || 'null');
      if (!parsed || typeof parsed !== 'object') return null;
      const creationMatch = typeof parsed.CreationDate === 'string'
        && parsed.CreationDate.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
      return {
        executablePath: typeof parsed.ExecutablePath === 'string' ? parsed.ExecutablePath : null,
        commandLine: typeof parsed.CommandLine === 'string' ? parsed.CommandLine : null,
        creationMs: creationMatch ? Number(creationMatch[1]) : null,
      };
    } catch {
      return null;
    }
  };

  /**
   * Capture the OS creation time of a live pid (Windows CIM, ms since
   * epoch), or null when unreadable. Called at registration so the reaper
   * later compares OS identity against OS identity — never wall-clock
   * guesses. Exported for the ACP spawn path; OpenCode entries do not use
   * it (legacy entries keep their existing checks).
   */
  const readProcessStartTimeMs = async (pid) => {
    if (!Number.isInteger(pid)) return null;
    if (process.platform === 'win32') {
      const identity = await readWindowsProcessIdentity(pid);
      return Number.isFinite(identity?.creationMs) ? identity.creationMs : null;
    }
    // POSIX: /proc/<pid>/stat field 22 (starttime, clock ticks since boot).
    // Combined with the boot time this is an absolute timestamp; but the
    // reaper only needs stability, so the raw tick count is compared
    // directly (see readPosixStartTicks).
    const ticks = await readPosixStartTicks(pid);
    return ticks;
  };

  // POSIX starttime ticks for a pid, or null. Prefers /proc (Linux); falls
  // back to `ps -o lstart=` (macOS/BSD: second resolution).
  const readPosixStartTicks = async (pid) => {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      // comm (field 2) may contain spaces/parens; starttime is field 22,
      // i.e. the 20th whitespace-separated field after the last ')'.
      const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const ticks = Number(afterComm[19]);
      if (Number.isFinite(ticks) && ticks > 0) return ticks;
      return null;
    } catch {
      // No /proc (macOS): fall back to lstart (second precision).
    }
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const ms = Date.parse((stdout || '').trim());
      // Tag fallback values so exact comparison still applies (seconds
      // collapse to the same number only for the same second).
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  };

  const killOrphan = async (pid) => {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 5000,
          windowsHide: true,
        });
      } catch {
        // Best-effort: a failed kill is not fatal (startup reaper is a backstop).
      }
      return;
    }

    const signalTree = (signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
        // process group may already be gone
      }
      try {
        process.kill(pid, signal);
      } catch {
        // pid may already be gone
      }
    };

    signalTree('SIGTERM');
    for (let waited = 0; waited < 1500 && isPidAlive(pid); waited += 150) {
      await sleep(150);
    }
    if (isPidAlive(pid)) {
      signalTree('SIGKILL');
      await sleep(300);
    }
  };

  // Exact start-time comparison. Both sides are OS-captured creation stamps
  // in the same unit, so equality is exact; the only slack is ±50 ms for
  // clock/tick resolution (CIM reports whole ms). Anything else — a
  // recycled pid, a different boot — differs by far more. Fail closed.
  const START_TIME_TOLERANCE_MS = 50;
  const startTimeMatches = (recorded, live) => {
    if (!Number.isFinite(recorded) || !Number.isFinite(live)) return false;
    return Math.abs(live - recorded) <= START_TIME_TOLERANCE_MS;
  };

  // Unix identity for an ACP entry: the live command line must be the
  // recorded full invocation (launcher + script + marker args), not a
  // substring — a recycled pid running `node unrelated-service` shares the
  // launcher path but never the full command. Comparison is on the exact
  // recorded string; the spawn side records argv-joined invocation.
  const acpCommandMatches = (command, entry) => {
    if (typeof command !== 'string' || !command) return false;
    if (typeof entry.invocation === 'string' && entry.invocation) {
      return command === entry.invocation || command.startsWith(`${entry.invocation} `);
    }
    // Legacy ACP entries without an invocation: require the recorded target
    // to be the command's argv[0] (prefix), never a substring anywhere.
    if (typeof entry.command !== 'string' || !entry.command) return false;
    return command === entry.command || command.startsWith(`${entry.command} `);
  };

  // Windows identity for an ACP entry. The recorded `command` is the
  // resolved spawn target; the live executable path must match it
  // (case-insensitive, separator-normalized), except for batch shims, whose
  // live image is `cmd.exe` by design — those match on image + the shim
  // path inside the live command line + creation time. The creation time
  // must match exactly (±50 ms resolution slack).
  const acpWindowsIdentityMatches = (identity, image, entry) => {
    if (!identity) return false;
    if (!startTimeMatches(entry.startTimeMs, identity.creationMs)) return false;
    const normalize = (value) => value.replace(/\//g, '\\');
    const recorded = typeof entry.command === 'string' ? normalize(entry.command.toLowerCase()) : '';
    const live = typeof identity.executablePath === 'string' ? normalize(identity.executablePath.toLowerCase()) : '';
    if (recorded.endsWith('.cmd') || recorded.endsWith('.bat')) {
      if (typeof image !== 'string' || !image.toLowerCase().includes('cmd.exe')) return false;
      // The live cmd.exe command line must name our shim (not just any
      // batch file a recycled pid happens to run).
      const liveCmd = typeof identity.commandLine === 'string' ? normalize(identity.commandLine.toLowerCase()) : '';
      return Boolean(recorded) && liveCmd.includes(recorded);
    }
    if (!recorded || !live) return false;
    if (live !== recorded) return false;
    // Full-invocation check: the live command line must be the recorded
    // invocation (launcher + script + args as spawned). The OS quotes the
    // launcher when it contains spaces, so strip one wrapping quote pair
    // around argv[0] before comparing.
    if (typeof entry.invocation === 'string' && entry.invocation) {
      const liveCmd = typeof identity.commandLine === 'string' ? identity.commandLine : '';
      const stripLauncherQuotes = (cmd) => cmd.replace(/^"([^"]+)"(?=\s|$)/, '$1');
      const liveNorm = stripLauncherQuotes(liveCmd);
      const recordedNorm = stripLauncherQuotes(entry.invocation);
      if (liveNorm !== recordedNorm && !liveNorm.startsWith(`${recordedNorm} `)) return false;
    }
    return true;
  };

  // Decide+act on a single registry entry. Returns true if it was reaped.
  const processEntry = async (entry, { log }) => {
    // Dead pid → nothing to do (caller drops the file).
    if (!isPidAlive(entry.pid)) return false;

    const ownerGone = Number.isInteger(entry.ownerPid) && !isPidAlive(entry.ownerPid);
    if (entry.kind === 'acp') return processAcpEntry(entry, { log, ownerGone });
    return processOpencodeEntry(entry, { log, ownerGone });
  };

  const processOpencodeEntry = async (entry, { log, ownerGone }) => {
    if (process.platform === 'win32') {
      const image = await readWindowsImageName(entry.pid);
      const looksLikeOpencode = typeof image === 'string' && image.toLowerCase().includes('opencode');
      // Windows lacks reliable reparent-to-1 semantics (job objects usually kill
      // children with the parent), so we reap only when the owner is provably dead
      // AND the image still looks like opencode.
      if (looksLikeOpencode && ownerGone) {
        await killOrphan(entry.pid);
        log?.(`[lifecycle] reaped orphaned OpenCode pid ${entry.pid} (owner ${entry.ownerPid} gone)`);
        return true;
      }
      return false;
    }

    const info = await readUnixProcInfo(entry.pid);
    // Can't verify identity (or it's not our server) → leave it alone.
    if (!info || !commandIdentifiesOurServer(info.command, entry)) return false;

    const orphaned = info.ppid === 1 || ownerGone;
    if (!orphaned) return false; // still owned by a live instance

    await killOrphan(entry.pid);
    log?.(`[lifecycle] reaped orphaned OpenCode pid ${entry.pid} (reparented/owner gone)`);
    return true;
  };

  const processAcpEntry = async (entry, { log, ownerGone }) => {
    // The owner-dead gate is the same on every platform: a child still
    // owned by a live instance is left untouched, always.
    if (!ownerGone) return false;

    if (process.platform === 'win32') {
      const image = await readWindowsImageName(entry.pid);
      if (typeof image !== 'string' || !image) return false;
      const identity = await readWindowsProcessIdentity(entry.pid);
      if (!acpWindowsIdentityMatches(identity, image, entry)) return false;
      await killOrphan(entry.pid);
      log?.(`[lifecycle] reaped orphaned ACP pid ${entry.pid} (owner ${entry.ownerPid} gone)`);
      return true;
    }

    const info = await readUnixProcInfo(entry.pid);
    // Can't verify identity (or it's not our agent) → leave it alone.
    if (!info || !acpCommandMatches(info.command, entry)) return false;
    // Start-time check: the live starttime must equal the recorded one.
    // POSIX starttimes are boot-relative ticks (or ms on macOS fallback);
    // both sides use the same capture function, so compare exactly.
    if (Number.isFinite(entry.startTimeMs)) {
      const live = await readPosixStartTicks(entry.pid);
      if (!startTimeMatches(entry.startTimeMs, live)) return false;
    } else {
      // No recorded start time: fail closed.
      return false;
    }
    const orphaned = info.ppid === 1 || ownerGone;
    if (!orphaned) return false;
    await killOrphan(entry.pid);
    log?.(`[lifecycle] reaped orphaned ACP pid ${entry.pid} (reparented/owner gone)`);
    return true;
  };

  /**
   * Kill any genuinely-orphaned OpenCode processes WE previously spawned, and
   * prune their registry files. Safe to call at startup before spawning a new
   * server. Returns { inspected, reaped }.
   */
  const reapOrphanedProcesses = async ({ log } = {}) => {
    const records = await readAllEntries();
    if (records.length === 0) return { inspected: 0, reaped: 0 };

    let reaped = 0;
    for (const { entry, filePath } of records) {
      let drop = false;
      try {
        const wasReaped = await processEntry(entry, { log });
        if (wasReaped) reaped += 1;
        // Drop the file when the process is gone (reaped now, or already dead);
        // keep it only while the process is still alive and owned by a live owner.
        drop = wasReaped || !isPidAlive(entry.pid);
      } catch (error) {
        log?.(`[lifecycle] reap check failed for pid ${entry.pid}: ${error?.message ?? error}`);
      }
      if (drop) {
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          // best-effort
        }
      }
    }

    return { inspected: records.length, reaped };
  };

  return { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses, readProcessStartTimeMs };
};

const defaultRegistry = createManagedProcessRegistry();

export const registerManagedProcess = defaultRegistry.registerManagedProcess;
export const unregisterManagedProcess = defaultRegistry.unregisterManagedProcess;
export const reapOrphanedProcesses = defaultRegistry.reapOrphanedProcesses;
export const readProcessStartTimeMs = defaultRegistry.readProcessStartTimeMs;
