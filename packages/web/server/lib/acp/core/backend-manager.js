/**
 * One agent process per backend entry (D7), lazily spawned and idle-reaped.
 *
 * States per backend: `unconfigured` (no registry entry or disabled),
 * `idle` (no process), `starting` (spawn + initialize in flight),
 * `ready` (initialized, usable), `error` (last start failed or the process
 * crashed; `lastError` and `stderrTail` say why).
 *
 * The manager owns processes, not sessions: later phases borrow `connection`
 * from `ensureReady()` to run session methods. Idle reap only stops a
 * backend nobody marked busy; `acquire()`/`release()` is the lease later
 * phases use to keep a live turn's process alive.
 *
 * Lifecycle serialization: every backend has a chain mutex plus a generation
 * counter. Stop/restart/shutdown bump the generation *before* tearing down;
 * a start only publishes its connection when its generation is still
 * current, and kills the process it built otherwise — so a stale start can
 * never resurrect `ready` after its process was killed, and overlapping
 * restarts never orphan a process. `shutdown()` closes admission (new
 * starts fail fast) and awaits every owned teardown, including processes
 * whose start is still in flight.
 */

import { EventEmitter } from 'node:events';

import { AcpVersionMismatchError } from './protocol-version.js';
import { resolveAuthTerminalInvocation } from './auth-terminal.js';
import { connectAcpAgent } from './connection.js';
import { spawnAcpAgent } from './spawn.js';

/** Idle backends are reaped after this long (configurable). */
export const DEFAULT_IDLE_REAP_MS = 10 * 60_000;

export class AcpBackendError extends Error {
  constructor(message, { code, backendId, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AcpBackendError';
    if (code !== undefined) this.code = code;
    if (backendId !== undefined) this.backendId = backendId;
  }
}

const toErrorMessage = (error) => {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
};

export const createAcpBackendManager = ({
  registry,
  spawnAgent = spawnAcpAgent,
  connectAgent = connectAcpAgent,
  idleReapMs = DEFAULT_IDLE_REAP_MS,
  now = () => Date.now(),
  connectionHooks = {},
  timeouts,
  clientInfo,
  // Host-owned connect log (keeps the core host-agnostic): called with
  // `{ backendId, protocolVersion, agentInfo }` on every successful connect,
  // including restart and respawn.
  onConnect,
  // How long to wait for stderr to flush after a failed start before
  // snapshotting the tail. Short in tests via injection.
  stderrFlushMs = 100,
} = {}) => {
  if (!registry || typeof registry.get !== 'function' || typeof registry.list !== 'function') {
    throw new Error('createAcpBackendManager requires a registry with get/list');
  }
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let shutDown = false;

  // backendId -> { state, entry, spawned, connected, lastError, lastUsedAt,
  // leases, chain, generation, reapTimer, lastKnown }
  // `lastKnown` keeps the final status snapshot after a crash or stop so
  // `status()` still reports capabilities and the stderr tail.
  const backends = new Map();

  const recordOf = (backendId) => {
    let record = backends.get(backendId);
    if (!record) {
      record = {
        state: 'idle',
        entry: null,
        spawned: null,
        connected: null,
        lastError: null,
        lastUsedAt: now(),
        leases: 0,
        chain: Promise.resolve(),
        generation: 0,
        // Tracks in-flight starts (and every process they built) so stop /
        // shutdown can settle them instead of deadlocking behind them.
        pendingStarts: new Set(),
        reapTimer: null,
        lastKnown: null,
      };
      backends.set(backendId, record);
    }
    return record;
  };

  // Serialize an async operation per backend: operations run in call order,
  // and a throwing operation does not break the chain for the next one.
  const serialize = (record, fn) => {
    const run = record.chain.then(fn, fn);
    // The chain itself never rejects; the caller still sees this op's error.
    record.chain = run.catch(() => {});
    return run;
  };

  const clearReapTimer = (record) => {
    if (record.reapTimer) {
      clearTimeout(record.reapTimer);
      record.reapTimer = null;
    }
  };

  const snapshot = (backendId, record) => {
    const connected = record.connected;
    return {
      id: backendId,
      state: record.state,
      protocolVersion: connected?.protocolVersion ?? record.lastKnown?.protocolVersion ?? null,
      agentInfo: connected?.agentInfo ?? record.lastKnown?.agentInfo ?? null,
      agentCapabilities: connected?.agentCapabilities ?? record.lastKnown?.agentCapabilities ?? null,
      authMethods: connected?.authMethods ?? record.lastKnown?.authMethods ?? [],
      lastError: record.lastError,
      stderrTail: (() => {
        try {
          return record.spawned?.getStderrTail?.() ?? record.lastKnown?.stderrTail ?? '';
        } catch {
          return record.lastKnown?.stderrTail ?? '';
        }
      })(),
    };
  };

  const rememberKnown = (backendId, record) => {
    const current = snapshot(backendId, record);
    record.lastKnown = {
      protocolVersion: current.protocolVersion,
      agentInfo: current.agentInfo,
      agentCapabilities: current.agentCapabilities,
      authMethods: current.authMethods,
      stderrTail: current.stderrTail,
    };
  };

  const scheduleReap = (backendId, record) => {
    clearReapTimer(record);
    if (shutDown) return;
    if (!(idleReapMs > 0)) return;
    if (record.state !== 'ready' || record.leases > 0) return;
    const delay = Math.max(0, record.lastUsedAt + idleReapMs - now());
    record.reapTimer = setTimeout(() => {
      record.reapTimer = null;
      if (record.state === 'ready' && record.leases === 0 && now() - record.lastUsedAt >= idleReapMs) {
        stopBackend(backendId, { reason: 'idle' }).catch(() => {});
      } else {
        scheduleReap(backendId, record);
      }
    }, delay);
    record.reapTimer.unref?.();
  };

  const touch = (backendId, record) => {
    record.lastUsedAt = now();
    scheduleReap(backendId, record);
  };

  const killSpawned = async (spawned) => {
    if (!spawned) return;
    try {
      await spawned.kill();
    } catch {
      // Teardown is best-effort; the status already reflects the stop.
    }
  };

  // Assumes the caller's generation: kills and clears only what belongs to
  // it. Must run serialized per backend.
  const stopGeneration = async (backendId, record, { reason } = {}) => {
    clearReapTimer(record);
    const spawned = record.spawned;
    if (spawned) {
      rememberKnown(backendId, record);
      record.spawned = null;
      record.connected = null;
      if (record.state !== 'error') record.state = 'idle';
      await killSpawned(spawned);
    } else {
      record.connected = null;
      if (record.state !== 'error') record.state = 'idle';
    }
    if (reason === 'idle') events.emit('backend-idle-reaped', { backendId });
  };

  // Stop whatever is current, invalidating any in-flight start. The
  // generation bump lands synchronously at call time — before queueing
  // behind the chain — so a start that is blocked in `connectAgent` is
  // already stale when it resolves, even though the teardown itself runs
  // serialized. In-flight starts are awaited (they kill what they built
  // instead of publishing) before the teardown proceeds.
  const stopBackend = (backendId, { reason } = {}) => {
    const record = recordOf(backendId);
    record.generation += 1;
    const invalidated = record.generation;
    return serialize(record, async () => {
      await settlePendingStarts(record, invalidated);
      await stopGeneration(backendId, record, { reason });
    });
  };

  // Wait for in-flight starts of an invalidated generation to finish their
  // cleanup (each kills the process it built). Starts register themselves
  // in `pendingStarts` with their generation; only entries at most
  // `invalidated` are settled, so a newer start is never disturbed.
  const settlePendingStarts = async (record, invalidated) => {
    const pending = [...record.pendingStarts].filter((entry) => entry.generation <= invalidated);
    await Promise.all(pending.map((entry) => entry.settled.catch(() => {})));
  };

  const resolveEntry = async (backendId) => {
    const entry = await registry.get(backendId);
    if (!entry) {
      throw new AcpBackendError(`Unknown ACP backend: ${backendId}`, { code: 'ACP_BACKEND_UNKNOWN', backendId });
    }
    if (entry.enabled === false) {
      throw new AcpBackendError(`ACP backend is disabled: ${backendId}`, { code: 'ACP_BACKEND_DISABLED', backendId });
    }
    return entry;
  };

  // Run one start attempt for `generation`. On success the connection
  // publishes only if the generation is still current; otherwise the fresh
  // process is killed and a stale-generation error throws (the winner that
  // bumped the generation owns the outcome).
  const runStart = async (backendId, record, entry, generation) => {
    let spawned = null;
    let connected = null;
    try {
      spawned = spawnAgent({
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env,
      });
      // `connectionHooks` may be a factory: each connection generation gets
      // hooks bound to its backend, so agent→client traffic can never be
      // attributed to another backend's session by payload inspection.
      const hooks = typeof connectionHooks === 'function'
        ? connectionHooks(backendId, generation)
        : connectionHooks;
      connected = await connectAgent({
        child: spawned.child,
        getStderrTail: () => spawned.getStderrTail(),
        hooks,
        timeouts,
        clientName: clientInfo?.name,
        clientVersion: clientInfo?.version,
      });
    } catch (error) {
      if (spawned) {
        // Stderr arrives after `exit`: give the pipe a beat to flush so
        // the tail in the error status names the real failure.
        await new Promise((resolve) => setTimeout(resolve, stderrFlushMs));
        record.spawned = spawned;
        rememberKnown(backendId, record);
        record.spawned = null;
        await killSpawned(spawned);
      }
      if (record.generation !== generation) {
        throw new AcpBackendError(`ACP backend ${backendId} start was superseded`, {
          code: 'ACP_BACKEND_SUPERSEDED',
          backendId,
        });
      }
      record.connected = null;
      record.state = 'error';
      record.lastError = toErrorMessage(error);
      clearReapTimer(record);
      events.emit('backend-error', { backendId, error, status: snapshot(backendId, record) });
      if (error instanceof AcpVersionMismatchError) throw error;
      throw new AcpBackendError(`ACP backend ${backendId} failed to start: ${toErrorMessage(error)}`, {
        code: error?.code ?? 'ACP_BACKEND_START_FAILED',
        backendId,
        cause: error,
      });
    }

    if (record.generation !== generation || shutDown) {
      // Stale (or shut down mid-start): never publish. Kill what we built.
      await killSpawned(spawned);
      throw new AcpBackendError(`ACP backend ${backendId} start was superseded`, {
        code: shutDown ? 'ACP_BACKEND_SHUTDOWN' : 'ACP_BACKEND_SUPERSEDED',
        backendId,
      });
    }

    record.spawned = spawned;
    // The connection's generation, for generation-bound agent→client hooks:
    // callbacks stamped with an older generation must not reach records
    // adopted after a restart.
    try {
      connected.generation = generation;
    } catch {
      // A frozen test double: generation binding degrades to identity checks.
    }
    record.connected = connected;
    record.state = 'ready';
    record.lastError = null;
    record.entry = entry;
    const status = snapshot(backendId, record);
    events.emit('backend-ready', { backendId, status });
    if (typeof onConnect === 'function') {
      try {
        onConnect({ backendId, protocolVersion: connected.protocolVersion, agentInfo: connected.agentInfo });
      } catch {
        // Logging must never break a connect.
      }
    }

    // Crash detection: the child died outside our control. Sessions go
    // to `session.error` in Phase 1.3; here the backend drops to `error`
    // and the next use respawns it. The generation guard keeps a late
    // exit from clobbering a newer start.
    connected.waitForExit().then((exit) => {
      if (record.spawned !== spawned || record.generation !== generation) return;
      rememberKnown(backendId, record);
      record.spawned = null;
      record.connected = null;
      record.state = 'error';
      record.lastError = `agent process exited (code ${exit?.code ?? 'null'}${exit?.signal ? `, signal ${exit.signal}` : ''})`;
      clearReapTimer(record);
      events.emit('backend-exit', { backendId, exit, status: snapshot(backendId, record) });
    }).catch(() => {});

    return connected;
  };

  /**
   * The live connection for `backendId`, starting the process when needed.
   * Concurrent callers share one start. The current registry entry is always
   * consulted — even on the ready fast path — so a removed or disabled
   * backend stops serving immediately. Marks the backend used (idle reap
   * counts from here); long operations should `acquire()` instead.
   */
  const ensureReady = async (backendId) => {
    if (shutDown) {
      throw new AcpBackendError(`ACP backend ${backendId} is shut down`, {
        code: 'ACP_BACKEND_SHUTDOWN',
        backendId,
      });
    }
    const record = recordOf(backendId);
    // Admission + start creation run serialized; the start itself runs
    // outside the chain (registered in `pendingStarts`) so a stop can
    // invalidate it while it is blocked in `connectAgent`, and so
    // concurrent callers share it instead of spawning twice.
    const pending = await serialize(record, async () => {
      if (shutDown) {
        throw new AcpBackendError(`ACP backend ${backendId} is shut down`, {
          code: 'ACP_BACKEND_SHUTDOWN',
          backendId,
        });
      }
      const entry = await resolveEntry(backendId);
      if (record.state === 'ready' && record.connected) {
        touch(backendId, record);
        return { ready: record.connected };
      }
      const inFlight = [...record.pendingStarts].find((item) => item.generation === record.generation);
      if (inFlight) return { pending: inFlight };
      record.state = 'starting';
      record.lastError = null;
      const generation = record.generation;
      const created = { generation, settled: null };
      created.settled = runStart(backendId, record, entry, generation).finally(() => {
        record.pendingStarts.delete(created);
      });
      // Every waiter observes the outcome via await; this only suppresses
      // the unhandled-rejection warning for the shared promise.
      created.settled.catch(() => {});
      record.pendingStarts.add(created);
      return { pending: created };
    });
    if (pending.ready) return pending.ready;
    const connected = await pending.pending.settled;
    touch(backendId, record);
    return connected;
  };

  /**
   * Hold the backend alive across a multi-step operation. The returned
   * release function must be called when done; reap waits for leases. A
   * restart invalidates the lease's connection (release is still safe).
   */
  const acquire = async (backendId) => {
    const connected = await ensureReady(backendId);
    const record = recordOf(backendId);
    const generation = record.generation;
    record.leases += 1;
    clearReapTimer(record);
    let released = false;
    return {
      connection: connected,
      release: () => {
        if (released) return;
        released = true;
        record.leases = Math.max(0, record.leases - 1);
        // Only reschedule reap when this lease's generation is still the
        // live one; a restart owns the timer now.
        if (record.generation === generation) touch(backendId, record);
      },
    };
  };

  /** Stop the process if running, then start fresh. Serialized: overlapping
   * restarts run one after another, each killing exactly what it stopped. */
  const restart = async (backendId) => {
    if (shutDown) {
      throw new AcpBackendError(`ACP backend ${backendId} is shut down`, {
        code: 'ACP_BACKEND_SHUTDOWN',
        backendId,
      });
    }
    const record = recordOf(backendId);
    // Invalidate synchronously (see stopBackend), then stop + start fresh
    // serialized. The start runs through ensureReady so concurrent callers
    // share it.
    record.generation += 1;
    const invalidated = record.generation;
    await serialize(record, async () => {
      if (shutDown) {
        throw new AcpBackendError(`ACP backend ${backendId} is shut down`, {
          code: 'ACP_BACKEND_SHUTDOWN',
          backendId,
        });
      }
      await settlePendingStarts(record, invalidated);
      await stopGeneration(backendId, record);
      record.state = 'idle';
      record.lastError = null;
      record.lastKnown = null;
    });
    await ensureReady(backendId);
    return snapshot(backendId, record);
  };

  /**
   * Run `authenticate` for `methodId` against a ready backend. Terminal
   * methods are never passed to the agent (Phase 1.6 opens a terminal
   * panel instead); reject them here so no caller can slip one through.
   */
  const authenticate = async (backendId, methodId) => {
    const connected = await ensureReady(backendId);
    const record = recordOf(backendId);
    const method = (connected.authMethods ?? []).find((entry) => entry?.id === methodId);
    if (!method) {
      throw new AcpBackendError(`Unknown auth method for backend ${backendId}: ${methodId}`, {
        code: 'ACP_AUTH_UNKNOWN_METHOD',
        backendId,
      });
    }
    if (method.type === 'terminal') {
      throw new AcpBackendError(`Auth method ${methodId} needs an interactive terminal`, {
        code: 'ACP_AUTH_TERMINAL',
        backendId,
      });
    }
    try {
      await connected.connection.authenticate({ methodId });
    } catch (error) {
      throw new AcpBackendError(`ACP backend ${backendId} authentication failed: ${toErrorMessage(error)}`, {
        code: error?.code ?? 'ACP_AUTH_FAILED',
        backendId,
        cause: error,
      });
    }
    touch(backendId, record);
    return snapshot(backendId, record);
  };

  /**
   * Resolve a `terminal` auth method into the `{ command, args, env }` the
   * UI opens in the terminal panel: registry invocation + the method's
   * extra args/env (spec: the client runs the configured agent program as
   * a separate interactive process and MUST NOT pass it to
   * `authenticate`). `methodId` selects among several; omitted, the
   * single terminal method is used, else rejected as ambiguous.
   */
  const authTerminal = async (backendId, methodId = null) => {
    const connected = await ensureReady(backendId);
    const entry = await resolveEntry(backendId);
    const methods = connected.authMethods ?? [];
    let method = null;
    if (methodId !== null && methodId !== undefined) {
      method = methods.find((candidate) => candidate?.id === methodId) ?? null;
      if (!method) {
        throw new AcpBackendError(`Unknown auth method for backend ${backendId}: ${methodId}`, {
          code: 'ACP_AUTH_UNKNOWN_METHOD',
          backendId,
        });
      }
      if (method.type !== 'terminal') {
        throw new AcpBackendError(`Auth method ${methodId} is not a terminal method`, {
          code: 'ACP_AUTH_NOT_TERMINAL',
          backendId,
        });
      }
    } else {
      const terminals = methods.filter((candidate) => candidate?.type === 'terminal');
      if (terminals.length !== 1) {
        throw new AcpBackendError(
          terminals.length === 0
            ? `Backend ${backendId} offers no terminal auth method`
            : `Backend ${backendId} offers several terminal auth methods; pass methodId`,
          { code: 'ACP_AUTH_UNKNOWN_METHOD', backendId },
        );
      }
      method = terminals[0];
    }
    const invocation = resolveAuthTerminalInvocation(entry, method);
    return { ...invocation, methodId: method.id };
  };

  const status = async (backendId) => {
    const record = recordOf(backendId);
    // Read the entry outside the chain; the state transition runs
    // serialized. A stop for a removed/disabled backend invalidates
    // synchronously so an in-flight start cannot publish behind it.
    const entry = await registry.get(backendId);
    const gone = !entry || entry.enabled === false;
    if (gone) record.generation += 1;
    const invalidated = record.generation;
    return serialize(record, async () => {
      if (gone) {
        if (record.spawned || record.state === 'ready' || record.state === 'starting') {
          await settlePendingStarts(record, invalidated);
          await stopGeneration(backendId, record);
        }
        record.state = 'unconfigured';
        return { ...snapshot(backendId, record), state: 'unconfigured' };
      }
      if (record.state === 'unconfigured') record.state = 'idle';
      return snapshot(backendId, record);
    });
  };

  /**
   * Reconcile every known backend against the saved registry: backends that
   * were removed or disabled stop (their processes die), the rest report.
   * Called after PUT; also the read path for GET.
   */
  const listStatuses = async () => {
    const entries = await registry.list();
    const live = new Map(entries.map((entry) => [entry.id, entry]));
    const out = [];
    for (const entry of entries) {
      out.push({ entry, ...(await status(entry.id)) });
    }
    // Records the registry no longer names: stop their processes so a
    // removed backend cannot keep running (and serving) invisibly.
    for (const backendId of [...backends.keys()]) {
      if (!live.has(backendId)) {
        await status(backendId);
      }
    }
    return out;
  };

  /**
   * Stop every backend and close admission: new starts fail fast, in-flight
   * starts are settled (their processes killed, never published), and every
   * owned teardown is awaited. Idempotent. Used at server shutdown: no
   * orphans left behind.
   */
  const shutdown = async () => {
    shutDown = true;
    const ids = [...backends.keys()];
    const invalidated = new Map();
    for (const id of ids) {
      const record = recordOf(id);
      record.generation += 1;
      invalidated.set(id, record.generation);
    }
    await Promise.all(ids.map((id) => {
      const record = recordOf(id);
      return serialize(record, async () => {
        await settlePendingStarts(record, invalidated.get(id));
        await stopGeneration(id, record);
      }).catch(() => {});
    }));
  };

  return {
    events,
    ensureReady,
    acquire,
    restart,
    authenticate,
    authTerminal,
    status,
    listStatuses,
    shutdown,
    /** Stop one backend (also used by idle reap). Serialized like the rest. */
    stop: (backendId) => stopBackend(backendId),
  };
};
