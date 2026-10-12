/**
 * Host-agnostic ACP session service over the backend manager, the session
 * index and one projector per live session (§3.2 session operations).
 *
 * No Express, no `http`, no `global-hub` imports: every method returns
 * `{ session, events }`-style results and the host adapter fans the events
 * out. `events` is an `EventEmitter` the host subscribes to for out-of-band
 * traffic (`sync` frames from live turns, `backend-exit` crashes).
 *
 * Lifecycle per session key:
 * - create → `session/new {cwd, mcpServers: []}` → index entry → `Session`.
 * - list → index ∪ `session/list {cwd}` over every enabled backend that
 *   advertises list (cursors followed), sorted by id; rows for other
 *   directories are dropped and discoveries are persisted to the index.
 * - open → cold: shared opening promise → `session/load` with `cwd` +
 *   `mcpServers: []` (replay builds the projection). Warm after a backend
 *   restart: `resume` if capable, else `load`. No `loadSession` capability →
 *   read-only stub with the index title.
 * - prompt → 409 when busy, opening or settling; post-cancel settle + 30 s
 *   watchdog (§4: cancel, load, replay-once, error).
 * - cancel → `session/cancel` notification + answer pending permission /
 *   elicitation requests with `cancelled`.
 * - config → `set_config_option`, or `set_mode` directly for
 *   modes-without-config agents (never `set_model`).
 * - delete → `delete` cap else `close` cap; drop the index entry.
 * - rename → index `userTitle` (wins over agent titles); agent titles
 *   persist to the index as they arrive.
 * - Backend crash → `session.error{acp_backend_exit}` on live sessions.
 * - Idle projections evict under an LRU policy (default: at most 20
 *   inactive, after 15 min idle); reopening rebuilds via load.
 */

import { EventEmitter } from 'node:events';

import { directoryKey, normalizeDirectory } from './directory-key.js';
import { decode, encode } from './session-key.js';
import { createSessionProjector } from './projector.js';

export const POST_CANCEL_SETTLE_MS = 250;
export const POST_CANCEL_WATCHDOG_MS = 30_000;
export const MAX_LIST_PAGES = 50;
/** At most this many idle (non-busy, non-opening) projections stay live. */
export const DEFAULT_MAX_INACTIVE_PROJECTIONS = 20;
/** Idle projections older than this evict (rebuilt via load on demand). */
export const DEFAULT_IDLE_EVICT_MS = 15 * 60_000;

export class AcpSessionError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AcpSessionError';
    if (code !== undefined) this.code = code;
  }
}

const busyError = (key) => new AcpSessionError(`ACP session is busy: ${key}`, { code: 'ACP_SESSION_BUSY' });
const unknownError = (key) => new AcpSessionError(`Unknown ACP session: ${key}`, { code: 'ACP_SESSION_UNKNOWN' });

export { normalizeDirectory, directoryKey } from './directory-key.js';

const hasCap = (caps, name) => {
  if (!caps || typeof caps !== 'object') return false;
  const value = caps[name];
  return value !== undefined && value !== null && value !== false;
};

const sessionCaps = (agentCapabilities) =>
  (agentCapabilities && typeof agentCapabilities === 'object' ? agentCapabilities.sessionCapabilities : null) ?? {};

const toPromptBlocks = (parts) => (Array.isArray(parts) ? parts : []).flatMap((part) => {
  if (part?.type === 'text' && typeof part.text === 'string') {
    return [{ type: 'text', text: part.text }];
  }
  if (part?.type === 'file' && typeof part.url === 'string') {
    return [{
      type: 'resource_link',
      uri: part.url,
      ...(typeof part.filename === 'string' ? { name: part.filename } : {}),
      ...(typeof part.mime === 'string' ? { mimeType: part.mime } : {}),
    }];
  }
  return [];
});

/**
 * The SDK wraps agent-thrown errors as `internalError({ details })`: the
 * message degrades to "Internal error" while the agent's text hides in
 * `data.details`. Unwrap it so the UI shows what the agent actually said.
 */
const promptErrorDetails = (error) => {
  if (!error || typeof error !== 'object') return { message: 'ACP request failed', code: undefined };
  const data = error.data;
  const details = data && typeof data === 'object' ? data.details : undefined;
  const detailText = typeof details === 'string'
    ? details
    : (details && typeof details.message === 'string' ? details.message : undefined);
  const generic = typeof error.message !== 'string' || /^(internal error|acp connection closed)$/i.test(error.message);
  return {
    message: (generic && detailText) ? detailText : (error.message ?? 'ACP request failed'),
    code: error.code,
  };
};

export const createAcpSessionService = ({
  manager,
  index,
  registry = null,
  now = () => Date.now(),
  settleMs = POST_CANCEL_SETTLE_MS,
  watchdogMs = POST_CANCEL_WATCHDOG_MS,
  maxInactiveProjections = DEFAULT_MAX_INACTIVE_PROJECTIONS,
  idleEvictMs = DEFAULT_IDLE_EVICT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  createProjector = createSessionProjector,
} = {}) => {
  if (!manager || typeof manager.ensureReady !== 'function') {
    throw new Error('createAcpSessionService requires a backend manager');
  }
  if (!index || typeof index.get !== 'function') {
    throw new Error('createAcpSessionService requires a session index');
  }

  const events = new EventEmitter();
  events.setMaxListeners(0);

  // key -> { entry, projector, nativeId, backendId, directory, connection,
  // turn, opening, cancelled, declinedInTurn, watchdogTimer, pendingRequests,
  // readOnly, lastActiveAt }
  //
  // `turn` is null when idle, else `{ generation, messageId, parts, retried,
  // deferred }` where `deferred.promise` resolves when the turn settles, is
  // abandoned by the watchdog, or finishes its post-cancel settle — every
  // waiter (cancel, delete, a second prompt's 409 path) observes it.
  const live = new Map();
  // Cold opens in flight, shared by concurrent open/messages/prompt/config.
  const opening = new Map();
  // nativeId -> key, qualified per backend (routes bound-hook traffic).
  const byNative = new Map();
  // Latest adopted connection per backend (stale-generation guard).
  const latestConnected = new Map();

  const emitSync = (directory, syncEvents) => {
    if (!Array.isArray(syncEvents) || syncEvents.length === 0) return;
    events.emit('sync', { directory, events: syncEvents });
  };

  const dropLive = (key, { onlyRecord = null } = {}) => {
    const record = live.get(key);
    if (!record) return;
    if (onlyRecord && record !== onlyRecord) return;
    if (record.watchdogTimer) {
      clearTimeout(record.watchdogTimer);
      record.watchdogTimer = null;
    }
    // A dropped record must never leave waiters hanging.
    record.turn?.deferred?.resolve({ status: 'dropped' });
    record.turn = null;
    byNative.delete(`${record.backendId}\0${record.nativeId}`);
    live.delete(key);
  };

  const trackLive = (record) => {
    record.lastActiveAt = now();
    live.set(record.key, record);
    byNative.set(`${record.backendId}\0${record.nativeId}`, record.key);
    latestConnected.set(record.backendId, record.connected);
    pruneIdle(record.key);
  };

  const touch = (record) => {
    record.lastActiveAt = now();
  };

  /**
   * Evict idle projections: non-busy, non-opening records older than
   * `idleEvictMs`, plus an LRU cap on the inactive set. `exceptKey` (the
   * record just tracked) never evicts itself. Eviction drops only the
   * projection; the sidecar entry stays and reopening rebuilds via load.
   */
  const pruneIdle = (exceptKey = null) => {
    const candidates = [];
    for (const [key, record] of live) {
      if (key === exceptKey) continue;
      if (!record.projector || record.readOnly) continue;
      if (record.turn || opening.has(key) || record.settling) continue;
      candidates.push(record);
    }
    for (const record of candidates) {
      if (now() - (record.lastActiveAt ?? 0) >= idleEvictMs) {
        persistTranscriptIds(record);
        dropLive(record.key);
      }
    }
    if (maxInactiveProjections >= 0) {
      // The cap counts the whole inactive set including the record just
      // tracked; victims are the oldest others, never the new record.
      const inactive = [...live.values()]
        .filter((record) => !record.turn && !opening.has(record.key) && !record.settling)
        .sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
      while (inactive.length > maxInactiveProjections) {
        const victim = inactive.find((record) => record.key !== exceptKey);
        if (!victim) break;
        inactive.splice(inactive.indexOf(victim), 1);
        persistTranscriptIds(victim);
        dropLive(victim.key);
      }
    }
  };

  const connectionOf = async (backendId) => manager.ensureReady(backendId);

  const capsOf = (connected) => connected?.agentCapabilities ?? null;

  const adoptConnection = (record, connected) => {
    record.connected = connected;
    record.generation = connected?.generation;
    latestConnected.set(record.backendId, connected);
  };

  // -- agent→client router (bound per backend+generation by the manager) ----
  //
  // The manager calls `hooksForBackend(backendId, generation)` for every
  // connection it creates; each triple routes ONLY to records of that
  // backend adopted at that generation. Payload ids are never used to infer
  // the backend (native ids are unique per agent, not across backends),
  // and a stale connection's callbacks can never reach a re-adopted record.

  const recordForBoundUpdate = (backendId, generation, nativeId) => {
    if (typeof nativeId !== 'string') return null;
    const key = byNative.get(`${backendId}\0${nativeId}`);
    if (!key) return null;
    const record = live.get(key);
    if (!record || record.backendId !== backendId || !record.projector) return null;
    if (record.generation !== generation) return null;
    if (latestConnected.get(backendId) !== undefined && record.connected !== latestConnected.get(backendId)) {
      return null;
    }
    return record;
  };

  const persistAgentTitle = (record) => {
    if (!record?.projector || !record.entry) return;
    const title = record.projector.session().title;
    if (!title || title === record.entry.title) return;
    if (record.entry.userTitle) return;
    record.entry = { ...record.entry, title };
    index.upsert(record.key, { title, updated: now() }).catch(() => {});
  };

  /**
   * Persist the live transcript's message ids so a later rebuild (after
   * eviction or a restart) can publish `message.removed` for ids the UI may
   * still hold. Called at turn settle, rebuild completion, announcements
   * and eviction — never per-delta.
   */
  const persistTranscriptIds = (record) => {
    if (!record?.projector || !record.entry) return;
    const messageIds = record.projector.transcriptIds().slice(-5000);
    record.entry = { ...record.entry, messageIds };
    index.upsert(record.key, { messageIds, updated: now() }).catch(() => {});
  };

  const hooksForBackend = (backendId, generation) => ({
    onSessionUpdate: (params) => {
      const record = recordForBoundUpdate(backendId, generation, params?.sessionId);
      if (!record) return;
      const syncEvents = record.projector.applyUpdate(params, { replay: record.replaying === true });
      record.lastUpdateAt = now();
      touch(record);
      persistAgentTitle(record);
      // Announcements add transcript messages outside any turn.
      if (syncEvents.some((event) => event.type === 'message.updated'
        && (event.properties.info?.role === 'model-switched' || event.properties.info?.role === 'agent-switched'))) {
        persistTranscriptIds(record);
      }
      // Rebuild traffic buffers until the load completes; the service then
      // publishes the replacement (removed prefix + canonical events).
      if (record.replaying && record.replayBuffer) {
        record.replayBuffer.push(...syncEvents);
        return;
      }
      emitSync(record.directory, syncEvents);
    },
    onRequestPermission: (params) => {
      const record = recordForBoundUpdate(backendId, generation, params?.sessionId);
      if (!record) return { outcome: { outcome: 'cancelled' } };
      touch(record);
      // Phase 1.4 projects the request; until then a cancelled turn answers
      // `cancelled` per the cancel cascade, and anything else parks until the
      // turn settles (Phase 1.4 replies through `permissions.reply`).
      if (record.cancelled) return { outcome: { outcome: 'cancelled' } };
      return new Promise((resolve) => {
        record.pendingRequests.push({ kind: 'permission', resolve });
      });
    },
    onElicitation: (params) => {
      const sessionId = params?.sessionId ?? params?._meta?.sessionId;
      const record = recordForBoundUpdate(backendId, generation, sessionId);
      if (!record) return { action: 'cancel' };
      touch(record);
      if (record.cancelled) return { action: 'cancel' };
      return new Promise((resolve) => {
        record.pendingRequests.push({ kind: 'elicitation', resolve });
      });
    },
  });

  const answerPending = (record) => {
    const pending = record.pendingRequests.splice(0);
    for (const request of pending) {
      try {
        if (request.kind === 'permission') request.resolve({ outcome: { outcome: 'cancelled' } });
        else request.resolve({ action: 'cancel' });
      } catch {
        // A settled handler must never wedge the turn teardown.
      }
    }
  };

  // -- crash handling --------------------------------------------------------

  const onBackendExit = ({ backendId, exit }) => {
    for (const record of [...live.values()]) {
      if (record.backendId !== backendId || !record.projector) continue;
      const syncEvents = record.projector.applyBackendExit(exit ?? null);
      answerPending(record);
      dropLive(record.key, { onlyRecord: record });
      emitSync(record.directory, syncEvents);
    }
  };

  if (typeof manager.events?.on === 'function') {
    manager.events.on('backend-exit', onBackendExit);
  }

  // -- turn runner -----------------------------------------------------------

  const settleWatchdog = (record) => {
    if (record.watchdogTimer) {
      clearTimeout(record.watchdogTimer);
      record.watchdogTimer = null;
    }
  };

  const armWatchdog = (record) => {
    settleWatchdog(record);
    record.watchdogTimer = setTimeout(() => {
      record.watchdogTimer = null;
      recoverStalledTurn(record).catch((error) => {
        // Recovery is terminal: never leave the turn hanging silently.
        // applyTerminalError works even on an idle (rebuilding) projector.
        try {
          const syncEvents = record.projector.applyTerminalError({
            message: `watchdog recovery failed: ${error?.message ?? error}`,
            code: 'acp_watchdog_failed',
          });
          emitSync(record.directory, syncEvents);
        } catch {
          // The projector is gone; nothing left to report.
        }
        answerPending(record);
        record.turn?.deferred?.resolve({ status: 'error', error });
        dropLive(record.key, { onlyRecord: record });
      });
    }, watchdogMs);
    record.watchdogTimer.unref?.();
  };

  /**
   * Post-cancel watchdog (§4): no update within the window → cancel again,
   * rebuild via `load`, replay the prompt once, then `error`. Recovery takes
   * ownership SYNCHRONOUSLY (the abandoned runner is invalidated before the
   * first await) and holds a generation-owned lock until it either installs
   * the retry turn or terminally fails. Recovery waits are bounded; on
   * failure or timeout the session errors and drops (a fresh open rebuilds),
   * so waiters can never block forever.
   */
  const recoverStalledTurn = async (record) => {
    const turn = record.turn;
    if (!turn || record.recovering) return;
    if (now() - (record.lastUpdateAt ?? 0) < watchdogMs) {
      armWatchdog(record);
      return;
    }
    // Take ownership synchronously: the abandoned runner's late completion
    // must fail its `record.turn !== captured` check from here on, and no
    // new prompt may start while recovery owns the record.
    const recovery = {
      generation: turn.generation + 1,
      messageId: turn.messageId,
      parts: turn.parts,
      retried: turn.retried,
      deferred: turn.deferred,
      isRecovery: true,
    };
    record.turn = recovery;
    record.recovering = true;
    settleWatchdog(record);

    const stillOurs = () => live.get(record.key) === record && record.turn === recovery;

    const failRecovery = (message, code) => {
      if (!stillOurs()) return;
      const syncEvents = record.projector.applyTerminalError({ message, code });
      emitSync(record.directory, syncEvents);
      answerPending(record);
      recovery.deferred.resolve({ status: 'error' });
      dropLive(record.key, { onlyRecord: record });
    };

    try {
      // A retry that stalls again errors out directly (no second rebuild).
      if (turn.retried) {
        failRecovery('prompt stalled twice; please retry', 'acp_watchdog_reload');
        return;
      }
      const withBound = async (promise, what) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${what} timed out`)), watchdogMs);
              timer.unref?.();
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        await withBound(record.connected.connection.cancel({ sessionId: record.nativeId }), 'watchdog cancel');
      } catch {
        // Best-effort; the load below is the real recovery.
      }
      if (!stillOurs()) return;
      record.replaying = true;
      record.replayBuffer = [];
      record.projector.beginReplay();
      try {
        await withBound(record.connected.connection.loadSession({
          sessionId: record.nativeId,
          cwd: record.directory,
          mcpServers: [],
        }), 'watchdog load');
      } catch (error) {
        record.projector.rollbackReplay();
        record.replaying = false;
        record.replayBuffer = null;
        failRecovery(`watchdog reload failed: ${error?.message ?? error}`, 'acp_watchdog_reload');
        return;
      }
      record.replaying = false;
      if (!stillOurs()) return;
      const replacement = record.projector.endReplay();
      const buffered = record.replayBuffer ?? [];
      record.replayBuffer = null;
      emitSync(record.directory, [...replacement, ...buffered]);
      // Replay the prompt once, on the recovery generation.
      const blocks = toPromptBlocks(turn.parts);
      let acceptEvents;
      try {
        acceptEvents = record.projector.acceptPrompt(turn.messageId, turn.parts);
      } catch (error) {
        failRecovery(`watchdog retry rejected: ${error?.message ?? error}`, 'acp_watchdog_reload');
        return;
      }
      emitSync(record.directory, acceptEvents);
      const retry = {
        generation: recovery.generation,
        messageId: turn.messageId,
        parts: turn.parts,
        retried: true,
        deferred: turn.deferred,
      };
      record.turn = retry;
      record.lastUpdateAt = now();
      armWatchdog(record);
      const connected = record.connected;
      connected.connection.prompt({ sessionId: record.nativeId, prompt: blocks }).then(
        (result) => {
          if (live.get(record.key) !== record || record.turn !== retry) return;
          settleWatchdog(record);
          const done = record.projector.applyPromptResult(result ?? null, {
            cancelledByUs: record.cancelled,
            declinedInTurn: record.declinedInTurn,
          });
          index.upsert(record.key, { updated: now() }).catch(() => {});
          emitSync(record.directory, done);
          retry.deferred.resolve({ status: 'settled', events: done });
          if (record.turn === retry) record.turn = null;
        },
        async (error) => {
          if (live.get(record.key) !== record || record.turn !== retry) return;
          settleWatchdog(record);
          let exited = connected.exited;
          if (!exited) {
            exited = await Promise.race([
              connected.waitForExit(),
              sleep(500).then(() => connected.exited),
            ]).catch(() => connected.exited);
          }
          if (live.get(record.key) !== record || record.turn !== retry) return;
          const unwrapped = exited
            ? { message: `agent process exited (code ${exited.code ?? 'null'}${exited.signal ? `, signal ${exited.signal}` : ''})`, code: 'acp_backend_exit' }
            : promptErrorDetails(error);
          const done = record.projector.applyPromptError(unwrapped);
          emitSync(record.directory, done);
          retry.deferred.resolve({ status: 'error', events: done, error });
          if (record.turn === retry) record.turn = null;
        },
      );
    } finally {
      // Every path above either dropped the record, installed the retry as
      // a normal turn, or bailed on a replaced record: the lock releases.
      record.recovering = false;
    }
  };

  const runPromptTurn = (record, turn) => {
    const blocks = toPromptBlocks(turn.parts);
    const connected = record.connected;
    const captured = turn;
    connected.connection.prompt({ sessionId: record.nativeId, prompt: blocks }).then(
      (result) => {
        // A watchdog recovery or newer turn owns the record now: the late
        // completion must not settle it.
        if (record.turn !== captured) return;
        settleWatchdog(record);
        const syncEvents = record.projector.applyPromptResult(result ?? null, {
          cancelledByUs: record.cancelled,
          declinedInTurn: record.declinedInTurn,
        });
        persistTranscriptIds(record);
        emitSync(record.directory, syncEvents);
        captured.deferred.resolve({ status: 'settled', events: syncEvents });
        if (record.turn === captured) record.turn = null;
      },
      async (error) => {
        if (record.turn !== captured) return;
        settleWatchdog(record);
        let exited = connected.exited;
        if (!exited) {
          exited = await Promise.race([
            connected.waitForExit(),
            sleep(500).then(() => connected.exited),
          ]).catch(() => connected.exited);
        }
        if (record.turn !== captured) return;
        const unwrapped = exited
          ? { message: `agent process exited (code ${exited.code ?? 'null'}${exited.signal ? `, signal ${exited.signal}` : ''})`, code: 'acp_backend_exit' }
          : promptErrorDetails(error);
        const syncEvents = record.projector.applyPromptError(unwrapped);
        persistTranscriptIds(record);
        emitSync(record.directory, syncEvents);
        captured.deferred.resolve({ status: 'error', events: syncEvents, error });
        if (record.turn === captured) record.turn = null;
      },
    );
  };

  const startTurn = (record, messageId, parts, { retried = false } = {}) => {
    const blocks = toPromptBlocks(parts);
    if (blocks.length === 0) {
      throw new AcpSessionError('ACP prompt needs at least one text or file part', { code: 'ACP_INVALID_PROMPT' });
    }
    let acceptEvents;
    try {
      acceptEvents = record.projector.acceptPrompt(messageId, parts);
    } catch (error) {
      if (error?.code === 'ACP_SESSION_BUSY') throw busyError(record.key);
      throw error;
    }
    emitSync(record.directory, acceptEvents);
    record.cancelled = false;
    record.declinedInTurn = false;
    record.lastUpdateAt = now();
    touch(record);
    let resolve;
    const deferred = { promise: new Promise((inner) => { resolve = inner; }), resolve: (value) => resolve(value) };
    const turn = {
      generation: (record.turnGeneration = (record.turnGeneration ?? 0) + 1),
      messageId,
      parts,
      retried,
      deferred,
    };
    record.turn = turn;
    armWatchdog(record);
    runPromptTurn(record, turn);
    deferred.promise.catch(() => {});
    return acceptEvents;
  };

  // -- core operations -------------------------------------------------------

  const create = async ({ backendId, directory, title }) => {
    const cwd = normalizeDirectory(directory);
    const connected = await connectionOf(backendId);
    const response = await connected.connection.newSession({ cwd, mcpServers: [] });
    const nativeId = response?.sessionId;
    if (typeof nativeId !== 'string' || !nativeId) {
      throw new AcpSessionError(`ACP backend ${backendId} returned no session id`, { code: 'ACP_BAD_SESSION_ID' });
    }
    const key = encode(backendId, nativeId);
    const created = now();
    const entry = await index.upsert(key, {
      backendId,
      nativeId,
      cwd,
      title: '',
      ...(typeof title === 'string' && title ? { userTitle: title } : {}),
      created,
      updated: created,
    });
    const projector = createProjector({ key, backendId, directory: cwd, index: entry, now });
    projector.seed(response, capsOf(connected));
    const record = {
      key,
      entry,
      projector,
      nativeId,
      backendId,
      directory: cwd,
      connected,
      generation: connected?.generation,
      turn: null,
      turnGeneration: 0,
      cancelled: false,
      declinedInTurn: false,
      settling: false,
      recovering: false,
      replaying: false,
      watchdogTimer: null,
      pendingRequests: [],
      readOnly: false,
      lastUpdateAt: created,
      lastActiveAt: created,
    };
    trackLive(record);
    const session = projector.session();
    const syncEvents = [{ type: 'session.created', properties: { info: session } }];
    emitSync(cwd, syncEvents);
    return { session, events: syncEvents };
  };

  const listSessions = async ({ directory }) => {
    const cwd = normalizeDirectory(directory);
    const wanted = directoryKey(cwd);
    pruneIdle();
    const rows = await index.listByDirectory(cwd);
    // The stored cwd spellings may predate normalization; filter by key.
    const sessions = new Map();
    for (const row of rows) {
      if (directoryKey(row.cwd) !== wanted) continue;
      const record = live.get(row.key);
      if (record?.projector) {
        sessions.set(row.key, record.projector.session());
      } else {
        sessions.set(row.key, {
          id: row.key,
          projectID: `acp:${row.backendId}`,
          directory: row.cwd,
          title: row.userTitle ?? row.title ?? '',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: row.created, updated: row.updated },
          metadata: { acp: { backendId: row.backendId, capabilities: {}, configOptions: [], modes: [] } },
        });
      }
    }
    // Discover live agent sessions across every enabled backend that
    // advertises list — even with an empty index. Failures merge nothing:
    // the index is the source for the sidebar, list is additive.
    // Discoveries persist to the index so they open like the rest.
    if (registry && typeof registry.list === 'function') {
      const entries = await registry.list().catch(() => []);
      await Promise.all((entries ?? []).map(async (entry) => {
        if (!entry || entry.enabled === false) return;
        let connected;
        try {
          connected = await connectionOf(entry.id);
        } catch {
          return;
        }
        if (!hasCap(sessionCaps(capsOf(connected)), 'list')) return;
        let cursor = null;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
          let listed;
          try {
            listed = await connected.connection.listSessions(cursor ? { cwd, cursor } : { cwd });
          } catch {
            return;
          }
          for (const info of listed?.sessions ?? []) {
            if (!info || typeof info.sessionId !== 'string') continue;
            if (typeof info.cwd === 'string' && directoryKey(info.cwd) !== wanted) continue;
            let itemKey;
            try {
              itemKey = encode(entry.id, info.sessionId);
            } catch {
              continue;
            }
            const updated = typeof info.updatedAt === 'string' && Number.isFinite(Date.parse(info.updatedAt))
              ? Date.parse(info.updatedAt)
              : now();
            const agentTitle = typeof info.title === 'string' ? info.title : '';
            const stored = await index.get(itemKey).catch(() => null);
            if (!stored) {
              // A discovery is exposed only after its sidecar entry lands;
              // a failed write omits the row (already-indexed rows are
              // unaffected) instead of listing an unopenable session.
              try {
                await index.upsert(itemKey, {
                  backendId: entry.id,
                  nativeId: info.sessionId,
                  cwd,
                  title: agentTitle,
                  created: updated,
                  updated,
                });
              } catch {
                continue;
              }
            } else if (agentTitle && stored.title !== agentTitle && !stored.userTitle) {
              await index.upsert(itemKey, { title: agentTitle, updated }).catch(() => {});
            }
            if (sessions.has(itemKey)) continue;
            const record = live.get(itemKey);
            if (record?.projector) {
              sessions.set(itemKey, record.projector.session());
              continue;
            }
            sessions.set(itemKey, {
              id: itemKey,
              projectID: `acp:${entry.id}`,
              directory: cwd,
              title: stored?.userTitle ?? agentTitle,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: stored?.created ?? updated, updated },
              metadata: { acp: { backendId: entry.id, capabilities: {}, configOptions: [], modes: [] } },
            });
          }
          cursor = listed?.nextCursor ?? null;
          if (!cursor) return;
        }
      }));
    }
    return [...sessions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  const performOpen = async (key) => {
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    const existing = live.get(key);
    if (existing?.projector && !existing.readOnly) {
      // Warm after a backend restart: the connection generation moved on;
      // `resume` if capable, else `load` — never serve a stale projector.
      let connected;
      try {
        connected = await connectionOf(existing.backendId);
      } catch (error) {
        throw new AcpSessionError(`ACP backend ${existing.backendId} is unavailable: ${error?.message ?? error}`, {
          code: 'ACP_BACKEND_UNAVAILABLE',
          cause: error,
        });
      }
      if (connected === existing.connected) {
        touch(existing);
        return { session: existing.projector.session(), events: [] };
      }
      const caps = sessionCaps(capsOf(connected));
      adoptConnection(existing, connected);
      touch(existing);
      if (hasCap(caps, 'resume')) {
        const response = await connected.connection.resumeSession({
          sessionId: existing.nativeId,
          cwd: existing.directory,
          mcpServers: [],
        });
        existing.projector.seed(response, capsOf(connected));
        return { session: existing.projector.session(), events: [] };
      }
      // Fall through to a full `load` replay below.
      dropLive(key, { onlyRecord: existing });
    } else if (existing) {
      dropLive(key, { onlyRecord: existing });
    }
    const entry = await index.get(key);
    if (!entry) throw unknownError(key);
    const cwd = entry.cwd;
    const connected = await connectionOf(entry.backendId);
    const caps = capsOf(connected);
    const projector = createProjector({ key, backendId: entry.backendId, directory: cwd, index: entry, now });
    const record = {
      key,
      entry,
      projector,
      nativeId: entry.nativeId,
      backendId: entry.backendId,
      directory: cwd,
      connected,
      generation: connected?.generation,
      turn: null,
      turnGeneration: 0,
      cancelled: false,
      declinedInTurn: false,
      settling: false,
      recovering: false,
      replaying: false,
      watchdogTimer: null,
      pendingRequests: [],
      readOnly: !hasCap(caps, 'loadSession'),
      lastUpdateAt: now(),
      lastActiveAt: now(),
    };
    if (record.readOnly) {
      // No replay source: a read-only stub with the index title. Prompting
      // it is rejected; the UI hides the composer for these.
      projector.seed(null, caps);
      trackLive(record);
      return { session: projector.session(), events: [] };
    }
    record.replaying = true;
    record.replayBuffer = [];
    trackLive(record);
    // Route this generation's replay into the fresh projector before `load`
    // responds (replay arrives as notifications during the call). Traffic
    // buffers until the load completes; the service then publishes the
    // replacement (removed prefix + canonical events) as one ordered batch.
    projector.beginReplay();
    let response;
    try {
      response = await connected.connection.loadSession({ sessionId: entry.nativeId, cwd, mcpServers: [] });
    } catch (error) {
      projector.rollbackReplay();
      dropLive(key, { onlyRecord: record });
      throw new AcpSessionError(`ACP session failed to load: ${error?.message ?? error}`, {
        code: error?.code ?? 'ACP_LOAD_FAILED',
        cause: error,
      });
    } finally {
      record.replaying = false;
    }
    projector.seed(response, caps);
    const replacement = projector.endReplay();
    const buffered = record.replayBuffer ?? [];
    record.replayBuffer = null;
    record.entry = { ...record.entry, messageIds: record.projector.transcriptIds().slice(-5000) };
    if (projector.session().title && projector.session().title !== entry.title && !entry.userTitle) {
      await index.upsert(key, { title: projector.session().title, messageIds: record.entry.messageIds, updated: now() }).catch(() => {});
    } else {
      await index.upsert(key, { messageIds: record.entry.messageIds, updated: now() }).catch(() => {});
    }
    const events = [...replacement, ...buffered];
    emitSync(cwd, events);
    return { session: projector.session(), events };
  };

  /**
   * Open (loading when cold). Concurrent opens of one key share a single
   * setup promise; mutating operations await it rather than racing setup.
   */
  const open = async ({ key }) => {
    pruneIdle();
    const inFlight = opening.get(key);
    if (inFlight) return inFlight;
    const setup = performOpen(key).finally(() => {
      if (opening.get(key) === setup) opening.delete(key);
    });
    opening.set(key, setup);
    return setup;
  };

  const messages = async ({ key, limit, before }) => {
    await open({ key });
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    touch(record);
    return record.projector.page({ limit, before });
  };

  const message = async ({ key, messageId }) => {
    await open({ key });
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    touch(record);
    // Pages are cheapest newest-first; scan from the tail (callers almost
    // always want a recent message) without a page-size cap.
    let before;
    for (;;) {
      const page = record.projector.page({ limit: 100, ...(before ? { before } : {}) });
      const found = page.items.find((item) => item.info.id === messageId);
      if (found) return found;
      if (!page.cursor.next) break;
      before = page.cursor.next;
    }
    throw new AcpSessionError(`Unknown ACP message: ${messageId}`, { code: 'ACP_MESSAGE_UNKNOWN' });
  };

  const assertReadyForTurn = (record) => {
    if (record.turn || record.settling || record.recovering || opening.has(record.key)) {
      throw busyError(record.key);
    }
    if (record.projector.busy) throw busyError(record.key);
  };

  const prompt = async ({ key, messageId, parts }) => {
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    await open({ key });
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    if (record.readOnly) {
      throw new AcpSessionError(`ACP session is read-only: ${key}`, { code: 'ACP_SESSION_READONLY' });
    }
    assertReadyForTurn(record);
    return startTurn(record, messageId, parts);
  };

  const cancel = async ({ key }) => {
    const record = live.get(key);
    // No live turn (or already settling one): nothing to interrupt. The
    // settle window keeps `settling` true so a second cancel also sees it.
    if (!record?.projector || !record.turn || record.settling) return false;
    if (!record.projector.busy) return false;
    // Capture the cancelled turn and acquire the settle lock synchronously,
    // BEFORE awaiting the cancel send: a prompt result arriving during that
    // await must not expose an unlocked session, and the wait below must
    // observe the captured turn — never a newer client's next turn.
    const turn = record.turn;
    record.settling = true;
    record.cancelled = true;
    try {
      await record.connected.connection.cancel({ sessionId: record.nativeId });
    } catch {
      // A cancel that fails to send still cascades locally below.
    }
    // Cancel cascade (§6): answer every pending permission/elicitation with
    // `cancelled` now that the cancel is out.
    answerPending(record);
    // Post-cancel settle: hold the session lock through the cancelled result
    // plus 250 ms so trailing updates land on the completed turn and no
    // other client can prompt before settlement completes.
    armWatchdog(record);
    try {
      await turn.deferred.promise;
    } catch {
      // Turn teardown already emitted its events; cancel still succeeded.
    }
    await sleep(settleMs);
    // Generation-owned teardown: release only while this record is still
    // live and no newer turn has (impossibly) started under the lock.
    if (live.get(key) === record && (!record.turn || record.turn === turn)) {
      record.settling = false;
    }
    touch(record);
    return true;
  };

  const config = async ({ key, configId, value }) => {
    if (typeof configId !== 'string' || !configId) {
      throw new AcpSessionError('ACP config requires a configId', { code: 'ACP_INVALID_CONFIG' });
    }
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    // Config needs the live session's options/modes to choose its path.
    await open({ key });
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    if (record.readOnly) {
      throw new AcpSessionError(`ACP session is read-only: ${key}`, { code: 'ACP_SESSION_READONLY' });
    }
    const connected = record.connected;
    const meta = record.projector.session().metadata?.acp ?? {};
    const modes = meta.modes ?? [];
    const configOptions = meta.configOptions ?? [];
    // D9 modes-without-config path, chosen BEFORE any RPC: a synthetic
    // `mode` selector on an agent with modes but no config options goes
    // straight to `set_mode` (a conforming agent has no set_config_option).
    if (configId === 'mode' && configOptions.length === 0 && modes.length > 0 && typeof value === 'string') {
      try {
        await connected.connection.setSessionMode({ sessionId: record.nativeId, modeId: value });
      } catch (error) {
        throw new AcpSessionError(`ACP session failed to set mode: ${error?.message ?? error}`, {
          code: 'ACP_CONFIG_FAILED',
          cause: error,
        });
      }
      const syncEvents = record.projector.applyUpdate({
        sessionId: record.nativeId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: value },
      });
      emitSync(record.directory, syncEvents);
      await index.upsert(key, {
        updated: now(),
        lastConfig: { ...(record.entry.lastConfig ?? {}), [configId]: value },
      }).catch(() => {});
      touch(record);
      return;
    }
    const request = { sessionId: record.nativeId, configId };
    if (typeof value === 'boolean') {
      request.type = 'boolean';
      request.value = value;
    } else {
      request.value = String(value);
    }
    let response;
    try {
      response = await connected.connection.setSessionConfigOption(request);
    } catch (error) {
      if (error?.code === -32601 || /unknown config/i.test(error?.message ?? '')) {
        throw new AcpSessionError(`Unknown ACP config option: ${configId}`, {
          code: 'ACP_CONFIG_UNKNOWN',
          cause: error,
        });
      }
      throw error;
    }
    if (response?.configOptions) {
      const syncEvents = record.projector.applyUpdate({
        sessionId: record.nativeId,
        update: { sessionUpdate: 'config_option_update', configOptions: response.configOptions },
      });
      emitSync(record.directory, syncEvents);
    }
    await index.upsert(key, {
      updated: now(),
      lastConfig: { ...(record.entry.lastConfig ?? {}), [configId]: value },
    }).catch(() => {});
    touch(record);
  };

  const remove = async ({ key }) => {
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    // Deleting during setup waits for the open first (it may fail).
    if (opening.has(key)) {
      await opening.get(key).catch(() => {});
    }
    const record = live.get(key) ?? null;
    const entry = record?.entry ?? await index.get(key);
    if (!entry) throw unknownError(key);
    if (record?.turn) {
      await cancel({ key }).catch(() => {});
    }
    const connected = record?.connected ?? await connectionOf(entry.backendId).catch(() => null);
    const caps = sessionCaps(capsOf(connected));
    if (connected && hasCap(caps, 'delete')) {
      await connected.connection.deleteSession({ sessionId: entry.nativeId });
    } else if (connected && hasCap(caps, 'close')) {
      await connected.connection.closeSession({ sessionId: entry.nativeId });
    }
    dropLive(key, { onlyRecord: record });
    await index.remove(key);
    emitSync(entry.cwd, [{ type: 'session.deleted', properties: { sessionID: key } }]);
    return true;
  };

  const rename = async ({ key, title }) => {
    if (typeof title !== 'string' || !title.trim()) {
      throw new AcpSessionError('ACP rename requires a title', { code: 'ACP_INVALID_TITLE' });
    }
    const entry = await index.get(key);
    if (!entry) throw unknownError(key);
    const clean = title.trim().slice(0, 500);
    await index.upsert(key, { userTitle: clean, updated: now() });
    const record = live.get(key);
    if (record?.projector) {
      record.entry = { ...record.entry, userTitle: clean };
      record.projector.setUserTitle(clean);
      const syncEvents = [{
        type: 'session.patched',
        properties: { sessionID: key, patch: { title: clean, time: { updated: now() } } },
      }];
      emitSync(record.directory, syncEvents);
      touch(record);
      return { session: record.projector.session(), events: syncEvents };
    }
    const session = {
      id: key,
      projectID: `acp:${entry.backendId}`,
      directory: entry.cwd,
      title: clean,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: entry.created, updated: now() },
      metadata: { acp: { backendId: entry.backendId, capabilities: {}, configOptions: [], modes: [] } },
    };
    return { session, events: [] };
  };

  const status = async ({ directory }) => {
    const cwd = normalizeDirectory(directory);
    const wanted = directoryKey(cwd);
    pruneIdle();
    const statuses = {};
    for (const record of live.values()) {
      if (directoryKey(record.directory) !== wanted || !record.projector) continue;
      statuses[record.key] = record.projector.busy ? { type: 'busy' } : { ...record.projector.status };
    }
    return statuses;
  };

  return {
    events,
    /**
     * Per-backend agent→client hooks, bound by the manager at connect time.
     * Replaces the old global `connectionHooks` (kept as a same-shape
     * alias would be a lie — ids are only unique per backend).
     */
    hooksForBackend,
    create,
    list: listSessions,
    open,
    messages,
    message,
    prompt,
    cancel,
    config,
    delete: remove,
    rename,
    status,
    /** Test seam: the live record for a key (projector, connection). */
    getLive: (key) => live.get(key) ?? null,
    /** Host shutdown: persist transcripts, stop crash listeners, clear timers. */
    dispose: () => {
      if (typeof manager.events?.off === 'function') {
        manager.events.off('backend-exit', onBackendExit);
      }
      // Best-effort replacement sets for post-restart rebuilds. The index
      // mutation queue orders these before any later read; the host awaits
      // backend shutdown after this, which outlasts the writes.
      for (const record of live.values()) {
        if (record.projector && !record.readOnly) persistTranscriptIds(record);
      }
      for (const key of [...live.keys()]) dropLive(key);
      opening.clear();
    },
  };
};
