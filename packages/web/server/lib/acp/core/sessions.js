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
 * - prompt → 409 when busy, opening, settling or mutating; post-cancel
 *   settle + 30 s watchdog (§4: cancel, load, replay-once, error). The
 *   turn installs before the start-snapshot await, so the pre-dispatch
 *   window is cancellable and guarded. Checkpoint `start` before
 *   `session/prompt` (budgeted; late → incomplete turn), `end` after
 *   every terminal outcome incl. crash and watchdog failure (D12).
 *   A persisted revert note is consumed exactly once at dispatch (D13).
 * - checkpoints/diff/revert/fork → per-turn git snapshots in the index
 *   (D12), turn diffs in the DiffView shape (D14), file restore from a
 *   session-owned end tree under a mutation lock + fork with load
 *   rebuild or persisted boundary + note (D13), explicit fork with load
 *   rebuild (unstable cap only).
 * - cancel → `session/cancel` notification + answer pending permission /
 *   elicitation requests with `cancelled`.
 * - `permissions.reply` / `forms.reply` / `forms.cancel` → answer the parked
 *   JSON-RPC request, then emit `permission.replied` / `form.settled`.
 * - config → `set_config_option`, or `set_mode` directly for
 *   modes-without-config agents (never `set_model`); refreshes the registry
 *   config cache (D9).
 * - commands → the cached `available_commands` in `CommandInfo` shape.
 * - Child sessions (`opencode/session/child_update`, `_meta`) get their own
 *   live record + projector (`parentKey` in the index, `parentID` on the
 *   session) and their traffic routes by native child id.
 * - delete → `delete` cap else `close` cap; drop the index entry.
 * - rename → index `userTitle` (wins over agent titles); agent titles
 *   persist to the index as they arrive.
 * - Backend crash → `session.error{acp_backend_exit}` on live sessions.
 * - Idle projections evict under an LRU policy (default: at most 20
 *   inactive, after 15 min idle); reopening rebuilds via load.
 *   (Child records never evict while their parent is live.)
 */

import { EventEmitter } from 'node:events';

import { canonicalDirectory, directoryKey, normalizeDirectory } from './directory-key.js';
import {
  choiceFormFor,
  contentForAnswer,
  elicitationFormFor,
  formIdFor,
  isChoicePrompt,
  optionIdForReply,
  permissionIdFor,
  permissionRequestFor,
  validateAnswerContent,
} from './interaction.js';
import { decode, encode } from './session-key.js';
import { createSessionProjector } from './projector.js';

export const POST_CANCEL_SETTLE_MS = 250;
export const POST_CANCEL_WATCHDOG_MS = 30_000;
export const MAX_LIST_PAGES = 50;
/** At most this many idle (non-busy, non-opening) projections stay live. */
export const DEFAULT_MAX_INACTIVE_PROJECTIONS = 20;
/** Idle projections older than this evict (rebuilt via load on demand). */
export const DEFAULT_IDLE_EVICT_MS = 15 * 60_000;
/** Budget for the pre-prompt `start` snapshot before the prompt goes out anyway (D12). */
export const CHECKPOINT_START_BUDGET_MS = 1500;
/** The well-known empty git tree, used as the placeholder `start` of incomplete turns. */
export const EMPTY_TREE_ID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Note prefixed to the next prompt after a no-fork revert (D13). */
export const REVERT_NOTE_PREFIX = (turn) => `[Note: files were reverted to the state before turn ${turn}; turns ${turn}+ were undone]`;

export class AcpSessionError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AcpSessionError';
    if (code !== undefined) this.code = code;
  }
}

const busyError = (key) => new AcpSessionError(`ACP session is busy: ${key}`, { code: 'ACP_SESSION_BUSY' });
const unknownError = (key) => new AcpSessionError(`Unknown ACP session: ${key}`, { code: 'ACP_SESSION_UNKNOWN' });

/**
 * True when an agent call failed because the session (or the whole
 * connection) is already gone: a closed stdio pipe, an unknown session id,
 * or a method the restarted backend no longer serves. D5 treats these as
 * "already deleted" and drops local state anyway. Anything else (quota,
 * auth, provider errors) means the session may be alive — the delete must
 * throw so the index entry survives. The SDK wraps agent-thrown text as
 * `internalError({ details })`, so the match runs over the unwrapped text
 * (same rule as `promptErrorDetails`).
 */
const isGoneSessionError = (error) => {
  const { message } = promptErrorDetails(error);
  if (error?.code === -32601) return true;
  return /acp connection closed|unknown session|session not found|no such session|session .* (gone|deleted|expired|does not exist|could not be found)/i.test(message);
};
export { canonicalDirectory, normalizeDirectory, directoryKey } from './directory-key.js';

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
 * Prefix the revert note (D13) to prompt parts: joined onto the first
 * text part when there is one, else a new leading text part. File parts
 * pass through untouched.
 */
const prefixRevertNote = (parts, note) => {
  const list = Array.isArray(parts) ? parts : [];
  const at = list.findIndex((part) => part?.type === 'text' && typeof part.text === 'string');
  if (at === -1) return [{ type: 'text', text: note }, ...list];
  return list.map((part, index) => (index === at ? { ...part, text: `${note}\n\n${part.text}` } : part));
};
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
  checkpoints = null,
  checkpointStartBudgetMs = CHECKPOINT_START_BUDGET_MS,
  now = () => Date.now(),
  settleMs = POST_CANCEL_SETTLE_MS,
  watchdogMs = POST_CANCEL_WATCHDOG_MS,
  maxInactiveProjections = DEFAULT_MAX_INACTIVE_PROJECTIONS,
  idleEvictMs = DEFAULT_IDLE_EVICT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  createProjector = createSessionProjector,
  canonicalDirectory: canonicalDirectoryImpl = canonicalDirectory,
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
  // pendingPermissions, pendingForms, readOnly, lastActiveAt, parentKey,
  // childStatus }
  //
  // `turn` is null when idle, else `{ generation, messageId, parts, retried,
  // deferred }` where `deferred.promise` resolves when the turn settles, is
  // abandoned by the watchdog, or finishes its post-cancel settle — every
  // waiter (cancel, delete, a second prompt's 409 path) observes it.
  // `pendingPermissions` maps request id → parked permission (projected
  // request + resolver + options); `pendingForms` maps form id → parked form
  // (projected form + resolver + either an elicitation schema or a parked
  // permission for choice prompts). `pendingRequests` stays as the legacy
  // cascade list (every parked entry is also listed there).
  const live = new Map();
  // Cold opens in flight, shared by concurrent open/messages/prompt/config.
  const opening = new Map();
  // nativeId -> key, qualified per backend (routes bound-hook traffic).
  const byNative = new Map();
  // Latest adopted connection per backend (stale-generation guard).
  const latestConnected = new Map();
  // In-flight crash end-settlements (best-effort, never block teardown).
  const pendingCrashSettles = new Set();
  // Keys the user deleted this process lifetime. A close-only backend keeps
  // the closed session in `session/list`; without the tombstone the next
  // listing resurrects it into the index and the sidebar.
  const deletedKeys = new Set();

  const emitSync = (directory, syncEvents) => {
    if (!Array.isArray(syncEvents) || syncEvents.length === 0) return;
    events.emit('sync', { directory, events: syncEvents });
  };

  // -- Phase 1.5: checkpoints (D12), revert (D13), turn diff (D14) -------------
  //
  // Turn ordinals are canonical from the projector (`turnNumberOf`): the
  // 1-based index in the accepted-turn list, identical across rebuilds
  // because live prompts and load replay append in transcript order. The
  // index persists `{ turn, start, end, complete }` per turn; a turn with
  // no usable start snapshot is `complete: false` and refuses revert/diff.

  /** Merge `row` into the entry's checkpoints (by turn), returning the entry. */
  const recordCheckpoint = (entry, row) => {
    const rows = Array.isArray(entry.checkpoints) ? [...entry.checkpoints] : [];
    const at = rows.findIndex((candidate) => candidate.turn === row.turn);
    if (at === -1) rows.push(row);
    else rows[at] = { ...rows[at], ...row };
    rows.sort((a, b) => a.turn - b.turn);
    return { ...entry, checkpoints: rows };
  };

  const persistCheckpointRow = (record, row, { bypassLiveGuard = false } = {}) => {
    if (!record?.entry) return;
    // Never resurrect a deleted index entry: the record is dropped before
    // the index entry on delete, so a record that is no longer live
    // settles silently (crash/watchdog teardowns race delete this way) —
    // unless the caller proves the entry still exists (crash settle,
    // which re-reads the index first).
    if (!bypassLiveGuard && live.get(record.key) !== record) return;
    record.entry = recordCheckpoint(record.entry, row);
    index.upsert(record.key, { checkpoints: record.entry.checkpoints, updated: now() }).catch(() => {});
  };

  const checkpointRowOf = (entry, turn) =>
    (Array.isArray(entry?.checkpoints) ? entry.checkpoints : []).find((row) => row.turn === turn) ?? null;

  const latestCheckpointTurn = (entry) => {
    let latest = 0;
    for (const row of entry?.checkpoints ?? []) {
      if (Number.isInteger(row?.turn) && row.turn > latest) latest = row.turn;
    }
    return latest;
  };

  /** One snapshot attempt; `ACP_CHECKPOINT_BUSY` retries once, then throws. */
  const snapshotOnce = async (args) => {
    try {
      return await checkpoints.snapshot(args);
    } catch (error) {
      if (error?.code !== 'ACP_CHECKPOINT_BUSY') throw error;
      return checkpoints.snapshot(args);
    }
  };

  /** Race a snapshot against `ms`; resolves `{ tree }` or `{ timeout: true }`. */
  const snapshotWithin = (args, ms) => {
    const attempt = snapshotOnce(args);
    // The loser still settles (ref + index write land); only the waiter
    // moves on. Unhandled rejections are impossible: both branches observe.
    attempt.catch(() => {});
    if (!(ms > 0)) return attempt.then((result) => ({ tree: result.tree }));
    let timer;
    return Promise.race([
      attempt.then((result) => ({ tree: result.tree })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), ms);
        timer.unref?.();
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
  };

  /**
   * Background warm for a project's shadow repo: the first-ever snapshot
   * (~12 s cold on large projects) must not delay the first prompt. A
   * turn-0 probe snapshot warms the work index; the prompt flow never
   * waits on it. Fire-and-forget: failures leave the first real snapshot
   * cold, which the start budget already tolerates.
   */
  const warmedProjects = new Set();
  const warmCheckpoints = (directory) => {
    if (!checkpoints) return;
    let scope;
    try {
      scope = directoryKey(directory);
    } catch {
      return;
    }
    if (warmedProjects.has(scope)) return;
    warmedProjects.add(scope);
    snapshotOnce({ cwd: directory, sessionKey: 'warm', turn: 0, phase: 'start' }).catch(() => {});
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
    // ...nor parked agent requests: answer them so the agent's turn can
    // finish, and settle the cards. Idempotent (splice-once), so prior
    // explicit cascades make this a no-op.
    try {
      emitSync(record.directory, answerPending(record));
    } catch {
      // Teardown never throws.
    }
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
   * Evict idle projections: non-busy, non-opening, non-mutating records
   * older than `idleEvictMs`, plus an LRU cap on the inactive set.
   * `exceptKey` (the record just tracked) never evicts itself. Children
   * whose parent is live never evict (the parent's transcript links to
   * them). A record holding the mutation lock (revert/fork in flight)
   * never evicts: eviction would drop the locked record and let a fresh
   * open dispatch a prompt while the original restore still runs.
   * Eviction drops only the projection; the sidecar entry stays and
   * reopening rebuilds via load. Evicted records settle parked prompts.
   */
  const pruneIdle = (exceptKey = null) => {
    const evictable = (record) => {
      if (!record.projector || record.readOnly) return false;
      if (record.turn || opening.has(record.key) || record.settling || record.mutating) return false;
      if (record.parentKey && live.has(record.parentKey)) return false;
      return true;
    };
    const evict = (record) => {
      // Parked prompts die with the projection: answer them so the agent's
      // turn can finish, and settle the cards.
      emitSync(record.directory, answerPending(record));
      persistTranscriptIds(record);
      dropLive(record.key);
    };
    const candidates = [];
    for (const [key, record] of live) {
      if (key === exceptKey) continue;
      if (!evictable(record)) continue;
      candidates.push(record);
    }
    for (const record of candidates) {
      if (now() - (record.lastActiveAt ?? 0) >= idleEvictMs) {
        evict(record);
      }
    }
    if (maxInactiveProjections >= 0) {
      // The cap counts the whole inactive set including the record just
      // tracked; victims are the oldest others, never the new record.
      const inactive = [...live.values()]
        .filter((record) => evictable(record))
        .sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
      while (inactive.length > maxInactiveProjections) {
        const victim = inactive.find((record) => record.key !== exceptKey);
        if (!victim) break;
        inactive.splice(inactive.indexOf(victim), 1);
        evict(victim);
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

  // -- Phase 1.4: permissions, elicitation, children, config cache ------------

  let pendingNonce = 0;
  const nextNonce = () => {
    pendingNonce += 1;
    return pendingNonce;
  };

  const ensurePendingMaps = (record) => {
    // D7: parked permission/form requests are memory-only by design. The
    // parked entry holds the live JSON-RPC resolver for the agent's turn,
    // and the agent turn dies with the process — after an API restart the
    // agent is gone, so there is nothing a persisted request could answer
    // and every reply 404s. Pending cards are intentionally not restored.
    if (!record.pendingPermissions) record.pendingPermissions = new Map();
    if (!record.pendingForms) record.pendingForms = new Map();
    if (!record.pendingRequests) record.pendingRequests = [];
    return record;
  };

  /**
   * Persist last-seen config options into the backend registry entry `cache`
   * (D9 pre-session picker). Best-effort: the turn never waits on it, and a
   * failed write only means the picker shows older options. The patch runs
   * inside the registry's mutation queue, so a concurrent backend PUT can
   * neither be overwritten nor wipe the cache.
   */
  const refreshConfigCache = (backendId, configOptions) => {
    if (!registry || typeof registry.patchCache !== 'function') return;
    if (!Array.isArray(configOptions)) return;
    registry.patchCache(
      backendId,
      configOptions.map((option) => ({ ...(option && typeof option === 'object' ? option : {}) })),
      new Date(now()).toISOString(),
    ).catch(() => {});
  };

  const currentConfigOptions = (record) =>
    record?.projector?.session()?.metadata?.acp?.configOptions ?? null;

  /**
   * Park a `session/request_permission`: project it, emit `permission.asked`
   * (or `form.created` for choice prompts), and return a promise the reply
   * route settles. Unanswerable requests (stale, cancelled) resolve
   * `cancelled` immediately.
   */
  const parkPermission = (record, params) => {
    ensurePendingMaps(record);
    const nonce = nextNonce();
    const toolCallId = typeof params?.toolCall?.toolCallId === 'string' && params.toolCall.toolCallId
      ? params.toolCall.toolCallId
      : `unknown-${nonce}`;
    return new Promise((resolve) => {
      if (isChoicePrompt(params)) {
        const formId = formIdFor(record.key, nonce);
        const form = choiceFormFor(formId, record.key, params);
        const cascade = { kind: 'form-choice', resolve, id: formId };
        record.pendingRequests.push(cascade);
        record.pendingForms.set(formId, {
          form,
          resolve,
          cascade,
          choice: { options: Array.isArray(params?.options) ? params.options : [] },
          settled: false,
        });
        emitSync(record.directory, [{ type: 'form.created', properties: { form } }]);
        return;
      }
      const requestId = permissionIdFor(record.key, toolCallId, nonce);
      const home = record.projector.toolSource(toolCallId);
      const source = home ? { type: 'tool', messageID: home.messageID, id: home.partID } : null;
      const request = permissionRequestFor(requestId, record.key, params, source);
      const cascade = { kind: 'permission', resolve, id: requestId };
      record.pendingRequests.push(cascade);
      record.pendingPermissions.set(requestId, {
        request,
        resolve,
        cascade,
        options: Array.isArray(params?.options) ? params.options : [],
        settled: false,
      });
      emitSync(record.directory, [{ type: 'permission.asked', properties: request }]);
    });
  };

  /**
   * Park an `elicitation/create`. Form mode projects to `form.created`;
   * URL mode (never advertised) and untranslatable schemas resolve `decline`
   * immediately so the agent can fall back.
   */
  const parkElicitation = (record, params) => {
    ensurePendingMaps(record);
    const mode = params?.mode;
    if (mode === 'url') return { action: 'decline' };
    if (mode !== undefined && mode !== 'form' && !(mode && typeof mode === 'string' && mode.startsWith('_'))) {
      return { action: 'decline' };
    }
    if (typeof mode === 'string' && mode.startsWith('_')) return { action: 'decline' };
    const nonce = nextNonce();
    const formId = formIdFor(record.key, nonce);
    const form = elicitationFormFor(formId, record.key, params);
    if (!form) return { action: 'decline' };
    return new Promise((resolve) => {
      const cascade = { kind: 'elicitation', resolve, id: formId };
      record.pendingRequests.push(cascade);
      record.pendingForms.set(formId, {
        form,
        resolve,
        cascade,
        elicitation: { requestedSchema: params?.requestedSchema ?? {} },
        settled: false,
      });
      emitSync(record.directory, [{ type: 'form.created', properties: { form } }]);
    });
  };

  /** Unpark one entry after its resolver settled (reply, cancel, cascade). */
  const unpark = (record, cascade) => {
    if (!record || !cascade) return;
    const at = record.pendingRequests?.indexOf(cascade);
    if (at !== undefined && at >= 0) record.pendingRequests.splice(at, 1);
    if (cascade.kind === 'permission') record.pendingPermissions?.delete(cascade.id);
    else record.pendingForms?.delete(cascade.id);
  };

  /**
   * True when any live ancestor's turn was cancelled. Children hold no turns
   * of their own; their requests belong to the ancestor turn flow. A dropped
   * ancestor carries no turn state, so the walk ends there.
   */
  const cancelledByAncestor = (record) => {
    const seenKeys = new Set([record.key]);
    let parentKey = record.parentKey;
    while (typeof parentKey === 'string' && !seenKeys.has(parentKey)) {
      seenKeys.add(parentKey);
      const parent = live.get(parentKey);
      if (!parent) return false;
      if (parent.cancelled === true) return true;
      parentKey = parent.parentKey;
    }
    return false;
  };


  const hooksForBackend = (backendId, generation) => ({
    onSessionUpdate: (params) => {
      const childMeta = params?.update?._meta?.['opencode/child-session'];
      if (childMeta && typeof childMeta === 'object') {
        routeChildTraffic(backendId, generation, params, childMeta);
        return;
      }
      const record = recordForBoundUpdate(backendId, generation, params?.sessionId);
      if (!record) return;
      const syncEvents = record.projector.applyUpdate(params, { replay: record.replaying === true });
      record.lastUpdateAt = now();
      touch(record);
      persistAgentTitle(record);
      // Config updates refresh the D9 cache; the picker reads it pre-session.
      if (params?.update?.sessionUpdate === 'config_option_update') {
        refreshConfigCache(backendId, currentConfigOptions(record));
      }
      // Announcements and agent notices add transcript messages outside any
      // turn; their ids persist so post-restart rebuilds can remove them.
      if (syncEvents.some((event) => event.type === 'message.updated'
        && (event.properties.info?.role === 'model-switched' || event.properties.info?.role === 'agent-switched' || event.properties.info?.role === 'agent-notice'))) {
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
      // A cancelled ancestor turn cancels descendants too: a late child
      // request that parked here would hang the agent's cancelled prompt
      // behind a user reply that can never come. Scoped to the turn:
      // `cancelled` clears when the next turn starts.
      if (record.cancelled || cancelledByAncestor(record)) return { outcome: { outcome: 'cancelled' } };
      return parkPermission(record, params);
    },
    onElicitation: (params) => {
      const sessionId = params?.sessionId ?? params?._meta?.sessionId;
      const record = recordForBoundUpdate(backendId, generation, sessionId);
      if (!record) return { action: 'cancel' };
      touch(record);
      if (record.cancelled || cancelledByAncestor(record)) return { action: 'cancel' };
      return parkElicitation(record, params);
    },
    onUnknownNotification: (method, params) => {
      if (method === 'opencode/session/child_update') {
        routeChildNotification(backendId, generation, params);
      }
      // Every other extension notification stays ignored per the spec's
      // extensibility rules — never throw on agent traffic.
    },
  });

  /**
   * Answer every parked permission/elicitation for a session with
   * `cancelled` and settle its card: cancel, turn end, backend exit and
   * eviction all funnel here. Emits the `permission.replied`/`form.settled`
   * events so the UI drops the cards. Returns the emitted events.
   */
  const answerPending = (record, { markDeclined = false } = {}) => {
    if (!record) return [];
    ensurePendingMaps(record);
    const pending = record.pendingRequests.splice(0);
    const syncEvents = [];
    for (const request of pending) {
      try {
        if (request.kind === 'permission') {
          request.resolve({ outcome: { outcome: 'cancelled' } });
          record.pendingPermissions.delete(request.id);
          syncEvents.push({ type: 'permission.replied', properties: { sessionID: record.key, requestID: request.id } });
        } else {
          request.resolve(request.kind === 'form-choice'
            ? { outcome: { outcome: 'cancelled' } }
            : { action: 'cancel' });
          record.pendingForms.delete(request.id);
          syncEvents.push({ type: 'form.settled', properties: { sessionID: record.key, formID: request.id } });
        }
      } catch {
        // A settled handler must never wedge the turn teardown.
      }
    }
    if (markDeclined && pending.length > 0) record.declinedInTurn = true;
    return syncEvents;
  };

  /** Live descendants of a record, transitively (children, grandchildren). */
  const liveDescendants = (parentKey) => {
    const out = [];
    const queue = [parentKey];
    const seenKeys = new Set([parentKey]);
    while (queue.length > 0) {
      const current = queue.shift();
      for (const record of live.values()) {
        if (record.parentKey !== current || seenKeys.has(record.key)) continue;
        seenKeys.add(record.key);
        out.push(record);
        queue.push(record.key);
      }
    }
    return out;
  };

  /**
   * Answer a record's parked requests plus every live descendant's, each to
   * its own directory. Exactly once per entry (splice-once). Used by cancel
   * and terminal turn teardown: children never hold turns of their own, but
   * their parked prompts belong to the parent's turn flow.
   */
  const answerPendingTree = (record, options = {}) => {
    if (!record) return;
    emitSync(record.directory, answerPending(record, options));
    for (const descendant of liveDescendants(record.key)) {
      if (live.get(descendant.key) !== descendant) continue;
      emitSync(descendant.directory, answerPending(descendant, options));
    }
  };

  // -- coordinated descendant replay (parent rebuilds) ------------------------
  //
  // A parent `load` rebuilds the whole tree: every live descendant snapshots
  // and resets alongside the parent, child traffic routes with replay
  // semantics into per-record buffers, and each record publishes its own
  // replacement batch after the load succeeds (or rolls back on failure).
  // Records created mid-replay start in replay mode and are dropped if the
  // load fails — they have no pre-rebuild state to restore.

  const beginReplayTree = (record) => {
    record.projector.beginReplay();
    record.replaying = true;
    record.replayBuffer = [];
    for (const descendant of liveDescendants(record.key)) {
      if (live.get(descendant.key) !== descendant || !descendant.projector) continue;
      descendant.projector.beginReplay();
      descendant.replaying = true;
      descendant.replayBuffer = [];
    }
  };

  const rollbackReplayTree = (record) => {
    record.projector.rollbackReplay();
    record.replaying = false;
    record.replayBuffer = null;
    for (const descendant of liveDescendants(record.key)) {
      if (live.get(descendant.key) !== descendant) continue;
      if (descendant.createdDuringReplay) {
        dropLive(descendant.key, { onlyRecord: descendant });
        continue;
      }
      if (!descendant.projector) continue;
      descendant.projector.rollbackReplay();
      descendant.replaying = false;
      descendant.replayBuffer = null;
    }
  };

  const endReplayTree = (record) => {
    const parentReplacement = record.projector.endReplay();
    const parentBuffered = record.replayBuffer ?? [];
    record.replaying = false;
    record.replayBuffer = null;
    for (const descendant of liveDescendants(record.key)) {
      if (live.get(descendant.key) !== descendant || !descendant.projector) continue;
      descendant.replaying = false;
      const buffered = descendant.replayBuffer ?? [];
      descendant.replayBuffer = null;
      descendant.createdDuringReplay = false;
      const replacement = descendant.projector.endReplay();
      persistTranscriptIds(descendant);
      touch(descendant);
      emitSync(descendant.directory, [...replacement, ...buffered]);
    }
    return { parentReplacement, parentBuffered };
  };

  // -- child sessions (opencode extension: `opencode/session/child_update` +
  // `_meta["opencode/child-session"]` chunks) --------------------------------
  //
  // A child gets its own live record + projector (`parentKey` in the index,
  // `parentID` on the session) and its traffic routes by native child id.
  // The parent `subagent` tool part links to the child key in its metadata.
  // Extension data is consumed wherever it appears, never by agent name (D8).

  const CHILD_STATUS_TO_SESSION = {
    created: 'idle',
    running: 'busy',
    completed: 'idle',
    failed: 'idle',
    interrupted: 'idle',
  };

  const childOutcomeFor = (status) => {
    if (status === 'completed') return 'succeeded';
    if (status === 'failed' || status === 'interrupted') return status === 'failed' ? 'failed' : 'interrupted';
    return undefined;
  };

  /**
+   * The live child record for a native child id, creating it (projector +
+   * index entry + `session.created`) on first sight. `parent` is the live
+   * parent record; `info` carries `{ title, toolCallId }` when known.
+   */
  const ensureChildRecord = (parent, nativeChildId, info = {}) => {
    const backendId = parent.backendId;
    const at = byNative.get(`${backendId}\0${nativeChildId}`);
    const known = at ? live.get(at) : null;
    if (known?.projector && known.backendId === backendId) {
      // A record from an older connection generation must adopt the parent's
      // current connection before its traffic routes: otherwise bound
      // updates, permissions and elicitations fail the generation check.
      // Stale parked requests settle — the old connection is dead.
      if (known.generation !== parent.generation || known.connected !== parent.connected) {
        emitSync(known.directory, answerPending(known));
        adoptConnection(known, parent.connected);
      }
      return { record: known, created: false };
    }
    let key;
    try {
      key = encode(backendId, nativeChildId);
    } catch {
      return { record: null, created: false };
    }
    const created = now();
    index.upsert(key, {
      backendId,
      nativeId: nativeChildId,
      cwd: parent.directory,
      title: typeof info.title === 'string' ? info.title : '',
      parentKey: parent.key,
      created,
      updated: created,
    }).catch(() => {});
    const entry = {
      key,
      backendId,
      nativeId: nativeChildId,
      cwd: parent.directory,
      title: typeof info.title === 'string' ? info.title : '',
      parentKey: parent.key,
      created,
      updated: created,
    };
    const projector = createProjector({ key, backendId, directory: parent.directory, index: entry, now });
    const record = {
      key,
      entry,
      projector,
      nativeId: nativeChildId,
      backendId,
      directory: parent.directory,
      connected: parent.connected,
      generation: parent.generation,
      turn: null,
      turnGeneration: 0,
      cancelled: false,
      declinedInTurn: false,
      settling: false,
      recovering: false,
      replaying: false,
      watchdogTimer: null,
      pendingRequests: [],
      pendingPermissions: new Map(),
      pendingForms: new Map(),
      readOnly: false,
      parentKey: parent.key,
      childStatus: 'running',
      lastUpdateAt: created,
      lastActiveAt: created,
    };
    trackLive(record);
    // Adopt the parent's connection generation so bound routing reaches the
    // child without a restart round-trip.
    adoptConnection(record, parent.connected);
    const session = projector.session();
    const syncEvents = [{ type: 'session.created', properties: { info: session } }];
    if (parent.replaying) {
      // Discovered mid-rebuild: join the replay tree (canonical ids,
      // buffered events) and drop on load failure.
      record.projector.beginReplay();
      record.replaying = true;
      record.replayBuffer = [syncEvents[0]];
      record.createdDuringReplay = true;
    } else {
      emitSync(parent.directory, syncEvents);
    }
    if (info.title) persistAgentTitle(record);
    return { record, created: true };
  };

  const childKeyOf = (backendId, nativeChildId) => byNative.get(`${backendId}\0${nativeChildId}`) ?? null;

  /** Link the parent `subagent` tool part to the child session key. Returns the events; the caller emits or buffers them. */
  const linkParentSubagent = (parent, childKey, toolCallId) => {
    if (!parent?.projector || typeof childKey !== 'string') return [];
    let callId = typeof toolCallId === 'string' && toolCallId ? toolCallId : null;
    if (!callId) {
      // Without a tool call id, link the newest running `subagent` part —
      // the child belongs to the call that is still open.
      callId = newestOpenSubagentCall(parent);
    }
    if (!callId) return [];
    return parent.projector.linkSubagentChild(callId, childKey);
  };

  const emitParentLink = (parent, childKey, toolCallId) => {
    const linkEvents = linkParentSubagent(parent, childKey, toolCallId);
    if (parent.replaying && parent.replayBuffer) parent.replayBuffer.push(...linkEvents);
    else emitSync(parent.directory, linkEvents);
  };

  const newestOpenSubagentCall = (parent) => {
    // Pages are newest-first; the first open `subagent` part wins.
    let before;
    for (let page = 0; page < 10; page += 1) {
      const records = parent.projector.page({ limit: 100, ...(before ? { before } : {}) });
      for (const item of records.items) {
        for (const part of item.parts ?? []) {
          if (part?.type === 'tool' && part.tool === 'subagent'
            && (part.state?.status === 'pending' || part.state?.status === 'running')
            && !(part.state?.metadata && typeof part.state.metadata === 'object' && part.state.metadata.sessionID)) {
            return part.callID;
          }
        }
      }
      if (!records.cursor.next) return null;
      before = records.cursor.next;
    }
    return null;
  };

  const sinkFor = (record) => (record.replaying && record.replayBuffer
    ? { emit: (syncEvents) => { record.replayBuffer.push(...syncEvents); } }
    : { emit: (syncEvents) => emitSync(record.directory, syncEvents) });

  const applyChildStatus = (parent, child, status, title) => {
    if (!child?.projector) return;
    const known = typeof status === 'string' ? status : 'running';
    child.childStatus = known;
    if (typeof title === 'string' && title) {
      child.entry = { ...child.entry, title };
      index.upsert(child.key, { title, updated: now() }).catch(() => {});
    }
    const patch = { time: { updated: now() } };
    if (typeof title === 'string' && title) patch.title = title;
    const outcome = childOutcomeFor(known);
    if (outcome) patch.outcome = outcome;
    const sink = sinkFor(child);
    sink.emit([{
      type: 'session.patched',
      properties: { sessionID: child.key, patch },
    }]);
    const mapped = CHILD_STATUS_TO_SESSION[known] ?? 'idle';
    sink.emit([{
      type: 'session.status',
      properties: { sessionID: child.key, status: { type: mapped } },
    }]);
    if (outcome) {
      touch(child);
      persistTranscriptIds(child);
    }
  };

  /**
+   * Route a `session/update` carrying `_meta["opencode/child-session"]` to
+   * the child's projector. The parent record is resolved from the
+   * notification's own session id (bound+generation checked); unknown
+   * parents drop the chunk.
+   */
  const routeChildTraffic = (backendId, generation, params, childMeta) => {
    const nativeChildId = typeof childMeta.id === 'string' && childMeta.id ? childMeta.id : null;
    if (!nativeChildId) return;
    // Nested children name their direct parent in the meta; the
    // notification's own session id is the fallback (top-level children).
    const parentNative = typeof childMeta.parentID === 'string' && childMeta.parentID
      ? childMeta.parentID
      : params?.sessionId;
    const parent = recordForBoundUpdate(backendId, generation, parentNative)
      ?? recordForBoundUpdate(backendId, generation, params?.sessionId);
    if (!parent) return;
    // The child's own view of the update: same content, addressed to the
    // child session. Strip the child meta so the projector treats it as
    // ordinary traffic.
    const update = params?.update && typeof params.update === 'object' ? { ...params.update } : null;
    if (!update || typeof update.sessionUpdate !== 'string') return;
    if (update._meta && typeof update._meta === 'object') {
      const meta = { ...update._meta };
      delete meta['opencode/child-session'];
      if (Object.keys(meta).length > 0) update._meta = meta;
      else delete update._meta;
    }
    const { record: child } = ensureChildRecord(parent, nativeChildId, { title: childMeta.title });
    if (!child) return;
    emitParentLink(parent, child.key, childMeta.toolCallId);
    // The agent's own subagent turn: never a standalone notice (D2).
    const syncEvents = child.projector.applyUpdate({ sessionId: nativeChildId, update }, { replay: child.replaying === true, agentTurn: true });
    child.lastUpdateAt = now();
    touch(child);
    sinkFor(child).emit(syncEvents);
  };

  /**
+   * Route an `opencode/session/child_update` extension notification. Status
+   * notifications create/update the child record; `update` notifications
+   * feed the child's projector.
+   */
  const routeChildNotification = (backendId, generation, params) => {
    const nativeChildId = typeof params?.childSessionId === 'string' && params.childSessionId ? params.childSessionId : null;
    if (!nativeChildId) return;
    const parentNative = typeof params?.parentSessionId === 'string' ? params.parentSessionId
      : (typeof params?.rootSessionId === 'string' ? params.rootSessionId : null);
    const parent = parentNative ? recordForBoundUpdate(backendId, generation, parentNative) : null;
    if (!parent) {
      // No live parent: adopt an existing child record if one is already
      // tracked (a restarted parent replays without the child context), else
      // drop — there is no directory to fan out to.
      const key = childKeyOf(backendId, nativeChildId);
      const child = key ? live.get(key) : null;
      if (!child?.projector || child.backendId !== backendId || child.generation !== generation) return;
      if (params?.type === 'update' && params?.update && typeof params.update === 'object') {
        const syncEvents = child.projector.applyUpdate({ sessionId: nativeChildId, update: params.update }, { replay: child.replaying === true, agentTurn: true });
        touch(child);
        sinkFor(child).emit(syncEvents);
      } else if (params?.type === 'status') {
        applyChildStatus(null, child, params?.status, params?.title);
      }
      return;
    }
    const { record: child } = ensureChildRecord(parent, nativeChildId, { title: params?.title });
    if (!child) return;
    emitParentLink(parent, child.key, params?.toolCallId);
    if (params?.type === 'update' && params?.update && typeof params.update === 'object') {
      const syncEvents = child.projector.applyUpdate({ sessionId: nativeChildId, update: params.update }, { replay: child.replaying === true, agentTurn: true });
      child.lastUpdateAt = now();
      touch(child);
      sinkFor(child).emit(syncEvents);
    } else if (params?.type === 'status' || typeof params?.status === 'string') {
      applyChildStatus(parent, child, params?.status, params?.title);
    } else if (typeof params?.title === 'string' && params.title) {
      applyChildStatus(parent, child, child.childStatus ?? 'running', params.title);
    }
  };


  // -- crash handling --------------------------------------------------------

  const onBackendExit = ({ backendId, exit }) => {
    for (const record of [...live.values()]) {
      if (record.backendId !== backendId || !record.projector) continue;
      const syncEvents = record.projector.applyBackendExit(exit ?? null);
      const settled = answerPending(record);
      // The dead turn's end snapshot still lands (best-effort): without
      // it a successful start row would keep `complete: true` with no
      // end tree, and later reverts would lose their current tree. The
      // shared terminal settlement snapshots, then merges onto a fresh
      // index read only when the entry still exists — settle-after-drop
      // can never resurrect a deleted session.
      if (record.turn?.messageId && typeof record.projector.turnNumberOf === 'function') {
        const turnNumber = record.projector.turnNumberOf(record.turn.messageId);
        record.crashSettle = settleTerminalCheckpoint(record, turnNumber);
      }
      dropLive(record.key, { onlyRecord: record });
      emitSync(record.directory, [...syncEvents, ...settled]);
    }
  };

  if (typeof manager.events?.on === 'function') {
    manager.events.on('backend-exit', onBackendExit);
  }

  /**
   * Shared terminal settlement for teardown paths that drop the record
   * (backend exit, watchdog failure): snapshots the end tree, then
   * merges it onto a FRESH index read — never onto a pre-teardown
   * row — and only when the entry still exists, so settle-after-drop
   * can never resurrect a deleted session. Best-effort; teardown
   * never blocks on it. The promise parks in `pendingCrashSettles`
   * so tests can await it.
   */
  const settleTerminalCheckpoint = (record, turnNumber) => {
    if (!checkpoints || !Number.isInteger(turnNumber)) return Promise.resolve();
    const key = record.key;
    const directory = record.directory;
    const settled = (async () => {
      try {
        const ended = await snapshotWithin(
          { cwd: directory, sessionKey: key, turn: turnNumber, phase: 'end' },
          checkpointStartBudgetMs,
        ).catch(() => null);
        const entry = await index.get(key).catch(() => null);
        if (!entry) return;
        const row = checkpointRowOf(entry, turnNumber);
        if (!row || !ended?.tree) return;
        const next = recordCheckpoint(entry, { turn: turnNumber, end: ended.tree, complete: row.complete === true });
        await index.upsert(key, { checkpoints: next.checkpoints, updated: now() }).catch(() => {});
      } catch {
        // Best-effort: the terminal report already went out.
      }
    })();
    settled.catch(() => {});
    pendingCrashSettles.add(settled);
    settled.finally(() => pendingCrashSettles.delete(settled));
    return settled;
  };

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
        if (record.turn?.messageId && typeof record.projector?.turnNumberOf === 'function' && record.projector) {
          settleTerminalCheckpoint(record, record.projector.turnNumberOf(record.turn.messageId));
        }
        answerPendingTree(record);
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
      if (recovery.messageId && typeof record.projector.turnNumberOf === 'function') {
        settleTerminalCheckpoint(record, record.projector.turnNumberOf(recovery.messageId));
      }
      answerPendingTree(record);
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
      beginReplayTree(record);
      try {
        await withBound(record.connected.connection.loadSession({
          sessionId: record.nativeId,
          cwd: record.directory,
          mcpServers: [],
        }), 'watchdog load');
      } catch (error) {
        rollbackReplayTree(record);
        failRecovery(`watchdog reload failed: ${error?.message ?? error}`, 'acp_watchdog_reload');
        return;
      }
      if (!stillOurs()) {
        rollbackReplayTree(record);
        return;
      }
      const { parentReplacement, parentBuffered } = endReplayTree(record);
      emitSync(record.directory, [...parentReplacement, ...parentBuffered]);
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
        async (result) => {
          if (live.get(record.key) !== record || record.turn !== retry) return;
          settleWatchdog(record);
          const done = record.projector.applyPromptResult(result ?? null, {
            cancelledByUs: record.cancelled,
            declinedInTurn: record.declinedInTurn,
          });
          index.upsert(record.key, { updated: now() }).catch(() => {});
          await settleTurnCheckpoint(
            record,
            typeof record.projector.turnNumberOf === 'function' ? record.projector.turnNumberOf(retry.messageId) : null,
          );
          if (live.get(record.key) !== record || record.turn !== retry) return;
          emitSync(record.directory, done);
          answerPendingTree(record);
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
          await settleTurnCheckpoint(
            record,
            typeof record.projector.turnNumberOf === 'function' ? record.projector.turnNumberOf(retry.messageId) : null,
          );
          if (live.get(record.key) !== record || record.turn !== retry) return;
          emitSync(record.directory, done);
          answerPendingTree(record);
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

  /**
   * Record the `end` snapshot for a settled turn (D12): result, cancel,
   * error, backend exit and watchdog failure alike. End capture is
   * attempted even when the start never landed — under a retained end
   * the row keeps `complete: false` but gains a session-owned end tree
   * for later reverts. A hung end snapshot must not wedge turn teardown:
   * it races the start budget, and a miss marks the row incomplete
   * rather than failing the turn. Never resurrects a deleted index
   * entry: a missing entry (deleted session) settles silently.
   */
  const settleTurnCheckpoint = async (record, turnNumber, { bypassLiveGuard = false } = {}) => {
    if (!checkpoints || !Number.isInteger(turnNumber)) return;
    const row = checkpointRowOf(record.entry, turnNumber);
    if (!row) return;
    const complete = row.complete === true;
    try {
      const ended = await snapshotWithin(
        { cwd: record.directory, sessionKey: record.key, turn: turnNumber, phase: 'end' },
        checkpointStartBudgetMs,
      );
      if (ended.tree) {
        persistCheckpointRow(record, { turn: turnNumber, end: ended.tree, complete }, { bypassLiveGuard });
      } else {
        persistCheckpointRow(record, { turn: turnNumber, end: row.end ?? null, complete: false }, { bypassLiveGuard });
      }
    } catch {
      persistCheckpointRow(record, { turn: turnNumber, end: row.end ?? null, complete: false }, { bypassLiveGuard });
    }
  };

  /** Latest session-owned end tree: newest `end` across this session's rows, or null. */
  const latestSessionEndTree = (entry) => {
    let tree = null;
    let at = -1;
    for (const row of entry?.checkpoints ?? []) {
      if (typeof row?.end === 'string' && row.end && Number.isInteger(row.turn) && row.turn > at) {
        at = row.turn;
        tree = row.end;
      }
    }
    return tree;
  };

  const runPromptTurn = (record, turn) => {
    const blocks = toPromptBlocks(turn.parts);
    const connected = record.connected;
    const captured = turn;
    const settleCheckpoint = () => settleTurnCheckpoint(
      record,
      typeof record.projector.turnNumberOf === 'function' ? record.projector.turnNumberOf(captured.messageId) : null,
    );
    connected.connection.prompt({ sessionId: record.nativeId, prompt: blocks }).then(
      async (result) => {
        // A watchdog recovery or newer turn owns the record now: the late
        // completion must not settle it.
        if (record.turn !== captured) return;
        settleWatchdog(record);
        const syncEvents = record.projector.applyPromptResult(result ?? null, {
          cancelledByUs: record.cancelled,
          declinedInTurn: record.declinedInTurn,
        });
        // A result with parked requests still open: the agent moved on
        // without them (or answered around them) — settle the cards so the
        // UI never shows a prompt for a finished turn.
        persistTranscriptIds(record);
        await settleCheckpoint();
        if (record.turn !== captured) return;
        emitSync(record.directory, syncEvents);
        answerPendingTree(record);
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
        await settleCheckpoint();
        if (record.turn !== captured) return;
        emitSync(record.directory, syncEvents);
        answerPendingTree(record);
        captured.deferred.resolve({ status: 'error', events: syncEvents, error });
        if (record.turn === captured) record.turn = null;
      },
    );
  };

  const startTurn = async (record, messageId, parts, { retried = false } = {}) => {
    const blocks = toPromptBlocks(parts);
    if (blocks.length === 0) {
      throw new AcpSessionError('ACP prompt needs at least one text or file part', { code: 'ACP_INVALID_PROMPT' });
    }
    // The turn installs BEFORE the first await (the start snapshot): the
    // projector is busy from `acceptPrompt` on, and the window between
    // accept and dispatch must be observable (cancel) and guarded
    // (delete, backend exit). `dispatching` marks the pre-dispatch
    // window; cancel during it reports the interruption and startTurn
    // abandons the dispatch instead of prompting a dead session.
    let resolve;
    const deferred = { promise: new Promise((inner) => { resolve = inner; }), resolve: (value) => resolve(value) };
    deferred.promise.catch(() => {});
    const turn = {
      generation: (record.turnGeneration = (record.turnGeneration ?? 0) + 1),
      messageId,
      parts,
      retried,
      deferred,
      dispatching: true,
    };
    let acceptEvents;
    try {
      acceptEvents = record.projector.acceptPrompt(messageId, parts);
    } catch (error) {
      if (error?.code === 'ACP_SESSION_BUSY') throw busyError(record.key);
      throw error;
    }
    record.turn = turn;
    record.cancelled = false;
    record.declinedInTurn = false;
    record.lastUpdateAt = now();
    touch(record);
    // The `start` snapshot races a budget (D12): when it is not ready in
    // time, the prompt goes out anyway and the turn is marked incomplete
    // (revert/diff refuse it). The ordinal is canonical from the
    // projector, so a rebuild numbers the same turn identically.
    if (checkpoints && !record.parentKey) {
      const turnNumber = typeof record.projector.turnNumberOf === 'function'
        ? record.projector.turnNumberOf(messageId)
        : null;
      if (Number.isInteger(turnNumber)) {
        try {
          const started = await snapshotWithin(
            { cwd: record.directory, sessionKey: record.key, turn: turnNumber, phase: 'start' },
            checkpointStartBudgetMs,
          );
          if (started.tree) {
            persistCheckpointRow(record, { turn: turnNumber, start: started.tree, end: null, complete: true });
          } else {
            persistCheckpointRow(record, {
              turn: turnNumber,
              start: EMPTY_TREE_ID,
              end: null,
              complete: false,
            });
          }
        } catch {
          persistCheckpointRow(record, { turn: turnNumber, start: EMPTY_TREE_ID, end: null, complete: false });
        }
      }
    }
    // Post-await guard: cancel, delete or backend replacement during the
    // snapshot window abandons the dispatch. A replaced record's teardown
    // (dropLive resolves the deferred) owns the settle; a cancelled turn
    // on the live record settles below as interrupted.
    if (live.get(record.key) !== record || record.turn !== turn) {
      return acceptEvents;
    }
    if (record.cancelled) {
      settleWatchdog(record);
      const syncEvents = record.projector.applyPromptResult({ stopReason: 'cancelled' }, { cancelledByUs: true });
      persistTranscriptIds(record);
      await settleTurnCheckpoint(
        record,
        typeof record.projector.turnNumberOf === 'function' ? record.projector.turnNumberOf(messageId) : null,
      );
      emitSync(record.directory, syncEvents);
      answerPendingTree(record);
      turn.deferred.resolve({ status: 'settled', events: syncEvents });
      if (record.turn === turn) record.turn = null;
      return acceptEvents;
    }
    // Exactly-once revert note (D13): consumed from the persisted entry
    // when the prompt is actually dispatched, so eviction/restart cannot
    // drop it and a cancelled dispatch cannot double-send it. The note
    // write is itself a pre-dispatch await, so ownership/cancellation
    // re-checks AFTER it: an abandoned dispatch restores the note
    // instead of consuming it.
    const note = typeof record.entry?.pendingRevertNote === 'string' && record.entry.pendingRevertNote
      ? record.entry.pendingRevertNote
      : null;
    if (note) {
      const next = { ...record.entry };
      delete next.pendingRevertNote;
      record.entry = next;
      await index.upsert(record.key, { pendingRevertNote: undefined, updated: now() }).catch(() => {});
      if (live.get(record.key) !== record || record.turn !== turn) {
        // Replaced record: restore the note so the surviving record's
        // next dispatch still carries it.
        record.entry = { ...record.entry, pendingRevertNote: note };
        await index.upsert(record.key, { pendingRevertNote: note, updated: now() }).catch(() => {});
        return acceptEvents;
      }
      if (record.cancelled) {
        // Cancelled during the note write: restore the note and settle
        // as interrupted (same as the snapshot-window cancel below).
        record.entry = { ...record.entry, pendingRevertNote: note };
        await index.upsert(record.key, { pendingRevertNote: note, updated: now() }).catch(() => {});
        settleWatchdog(record);
        const syncEvents = record.projector.applyPromptResult({ stopReason: 'cancelled' }, { cancelledByUs: true });
        persistTranscriptIds(record);
        await settleTurnCheckpoint(
          record,
          typeof record.projector.turnNumberOf === 'function' ? record.projector.turnNumberOf(messageId) : null,
        );
        emitSync(record.directory, syncEvents);
        answerPendingTree(record);
        turn.deferred.resolve({ status: 'settled', events: syncEvents });
        if (record.turn === turn) record.turn = null;
        return acceptEvents;
      }
      turn.parts = prefixRevertNote(parts, note);
    }
    turn.dispatching = false;
    // The staged revert commits with this dispatch: clear the persisted
    // boundary fields alongside the projection (which acceptPrompt
    // already cleared), so cold lists and replay stay boundary-free.
    if (record.entry?.revertedFromTurn !== undefined || record.entry?.revertMessageID !== undefined) {
      const next = { ...record.entry };
      delete next.revertedFromTurn;
      delete next.revertMessageID;
      record.entry = next;
      await index.upsert(record.key, { revertedFromTurn: undefined, revertMessageID: undefined, updated: now() }).catch(() => {});
      if (live.get(record.key) !== record || record.turn !== turn || record.cancelled) {
        // Abandoned during the boundary clear: same settle as the note
        // paths (note already consumed — the prompt it prefixes never
        // sends, so restore it).
        if (note) {
          record.entry = { ...record.entry, pendingRevertNote: note };
          await index.upsert(record.key, { pendingRevertNote: note, updated: now() }).catch(() => {});
        }
        if (live.get(record.key) !== record || record.turn !== turn) return acceptEvents;
        settleWatchdog(record);
        const syncEvents = record.projector.applyPromptResult({ stopReason: 'cancelled' }, { cancelledByUs: true });
        persistTranscriptIds(record);
        await settleTurnCheckpoint(
          record,
          typeof record.projector.turnNumberOf === 'function' ? record.projector.turnNumberOf(messageId) : null,
        );
        emitSync(record.directory, syncEvents);
        answerPendingTree(record);
        turn.deferred.resolve({ status: 'settled', events: syncEvents });
        if (record.turn === turn) record.turn = null;
        return acceptEvents;
      }
    }
    emitSync(record.directory, acceptEvents);
    armWatchdog(record);
    runPromptTurn(record, turn);
    return acceptEvents;
  };

  // -- core operations -------------------------------------------------------

  const create = async ({ backendId, directory, title }) => {
    const cwd = await canonicalDirectoryImpl(directory);
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
      pendingPermissions: new Map(),
      pendingForms: new Map(),
      readOnly: false,
      lastUpdateAt: created,
      lastActiveAt: created,
    };
    trackLive(record);
    refreshConfigCache(backendId, currentConfigOptions(record));
    warmCheckpoints(cwd);
    const session = projector.session();
    const syncEvents = [{ type: 'session.created', properties: { info: session } }];
    emitSync(cwd, syncEvents);
    return { session, events: syncEvents };
  };

  const listSessions = async ({ directory }) => {
    const cwd = await canonicalDirectoryImpl(directory);
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
          ...(row.parentKey ? { parentID: row.parentKey } : {}),
          projectID: `acp:${row.backendId}`,
          directory: row.cwd,
          title: row.userTitle ?? row.title ?? '',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: row.created, updated: row.updated },
          ...(typeof row.revertMessageID === 'string' && row.revertMessageID
            ? { revert: { messageID: row.revertMessageID } }
            : {}),
          metadata: {
            acp: {
              backendId: row.backendId,
              capabilities: {},
              configOptions: [],
              modes: [],
              ...(Number.isInteger(row.revertedFromTurn) ? { revertedFromTurn: row.revertedFromTurn } : {}),
            },
          },
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
            if (deletedKeys.has(itemKey)) continue;
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
    // A record mid-rebuild (fork warmup, cold open racing elsewhere)
    // serves nothing until its replay lands: await the shared guard
    // instead of returning an empty transcript. Without this, opening
    // a fork URL in the rebuild window shows a draft that the router
    // then drops.
    if (existing?.replaying && opening.has(key)) {
      await opening.get(key).catch(() => {});
      const settled = live.get(key);
      if (!settled?.projector) throw unknownError(key);
      touch(settled);
      return { session: settled.projector.session(), events: [] };
    }
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
      // The parent's connection moved on: every live descendant adopts it
      // too, or its bound traffic fails the generation check. Stale parked
      // requests settle — the old connection is dead.
      for (const descendant of liveDescendants(key)) {
        if (live.get(descendant.key) !== descendant) continue;
        emitSync(descendant.directory, answerPending(descendant));
        adoptConnection(descendant, connected);
      }
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
      pendingPermissions: new Map(),
      pendingForms: new Map(),
      readOnly: !hasCap(caps, 'loadSession'),
      ...(entry.parentKey ? { parentKey: entry.parentKey } : {}),
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
    // Descendants rebuild alongside the parent (same lifecycle, own batches).
    projector.beginReplay();
    for (const descendant of liveDescendants(key)) {
      if (live.get(descendant.key) !== descendant || !descendant.projector) continue;
      descendant.projector.beginReplay();
      descendant.replaying = true;
      descendant.replayBuffer = [];
    }
    let response;
    warmCheckpoints(cwd);
    try {
      response = await connected.connection.loadSession({ sessionId: entry.nativeId, cwd, mcpServers: [] });
    } catch (error) {
      rollbackReplayTree(record);
      dropLive(key, { onlyRecord: record });
      throw new AcpSessionError(`ACP session failed to load: ${error?.message ?? error}`, {
        code: error?.code ?? 'ACP_LOAD_FAILED',
        cause: error,
      });
    }
    projector.seed(response, caps);
    const { parentReplacement, parentBuffered } = endReplayTree(record);
    record.entry = { ...record.entry, messageIds: record.projector.transcriptIds().slice(-5000) };
    // The replay re-canonicalized the revert boundary (fresh ids): persist
    // the live boundary message id so cold list rows serve it too. The
    // pending note needs no restore — it lives in the entry already and
    // startTurn consumes it at dispatch.
    const liveBoundary = record.projector.session().revert?.messageID;
    if (typeof liveBoundary === 'string' && liveBoundary && liveBoundary !== record.entry.revertMessageID) {
      record.entry = { ...record.entry, revertMessageID: liveBoundary };
      await index.upsert(key, { revertMessageID: liveBoundary, messageIds: record.entry.messageIds, updated: now() }).catch(() => {});
    } else if (projector.session().title && projector.session().title !== entry.title && !entry.userTitle) {
      await index.upsert(key, { title: projector.session().title, messageIds: record.entry.messageIds, updated: now() }).catch(() => {});
    } else {
      await index.upsert(key, { messageIds: record.entry.messageIds, updated: now() }).catch(() => {});
    }
    const events = [...parentReplacement, ...parentBuffered];
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
    if (record.turn || record.settling || record.recovering || record.mutating || opening.has(record.key)) {
      throw busyError(record.key);
    }
    if (record.projector.busy) throw busyError(record.key);
  };

  /**
   * Generation-owned session mutation lock (revert/fork/delete paths):
   * acquired synchronously after the readiness check, held through the
   * whole `fn` (restore + boundary), released in `finally`. Prompt,
   * revert, fork and delete all honor it via `assertReadyForTurn` /
   * explicit checks, so no agent turn can edit files concurrently with
   * a revert. Returns `fn`'s value.
   */
  const withMutationLock = async (record, fn) => {
    const token = (record.mutationGeneration = (record.mutationGeneration ?? 0) + 1);
    record.mutating = token;
    try {
      return await fn();
    } finally {
      if (record.mutating === token) record.mutating = null;
    }
  };

  const assertMutable = (record) => {
    if (record.turn || record.settling || record.recovering || record.mutating || opening.has(record.key) || record.projector.busy) {
      throw busyError(record.key);
    }
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
    // Pre-dispatch window (start snapshot still running): flag the cancel
    // and let startTurn abandon the dispatch after its await. No agent
    // cancel is sent — nothing was dispatched yet. Still waits for the
    // turn teardown so callers observe the interruption.
    if (record.turn.dispatching) {
      const pending = record.turn;
      record.settling = true;
      record.cancelled = true;
      answerPendingTree(record);
      try {
        await pending.deferred.promise;
      } catch {
        // Turn teardown already emitted its events; cancel still succeeded.
      }
      await sleep(settleMs);
      if (live.get(key) === record && (!record.turn || record.turn === pending)) {
        record.settling = false;
      }
      touch(record);
      return true;
    }
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
    // `cancelled` now that the cancel is out — including descendants'.
    answerPendingTree(record);
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
    // D4: some agents answer success while keeping the old value (a
    // cross-provider model switch the provider rejects server-side). The
    // `currentValue` in the response is the source of truth: when the
    // agent did not apply the requested value, the projection still syncs
    // to what the agent reports, but the caller gets a 409 with the
    // agent's resulting value so the UI's error toast shows it.
    const applied = Array.isArray(response?.configOptions)
      ? (response.configOptions.find((option) => option?.id === configId)?.currentValue ?? undefined)
      : undefined;
    const want = typeof value === 'boolean' ? value : String(value);
    const mismatch = applied !== undefined && String(applied) !== String(want);
    if (response?.configOptions) {
      const syncEvents = record.projector.applyUpdate({
        sessionId: record.nativeId,
        update: { sessionUpdate: 'config_option_update', configOptions: response.configOptions },
      });
      emitSync(record.directory, syncEvents);
      refreshConfigCache(record.backendId, currentConfigOptions(record));
    }
    await index.upsert(key, {
      updated: now(),
      // Session state follows the agent, not the request: a silent keep
      // persists the agent's value so reopen/reconcile cannot resurrect
      // the rejected one.
      lastConfig: { ...(record.entry.lastConfig ?? {}), [configId]: applied ?? value },
    }).catch(() => {});
    touch(record);
    if (mismatch) {
      throw new AcpSessionError(
        `ACP agent kept ${JSON.stringify(applied)} for ${configId} instead of the requested ${JSON.stringify(want)}`,
        { code: 'ACP_CONFIG_NOT_APPLIED' },
      );
    }
  };

  // -- Phase 1.4 operations: permissions, forms, commands, config cache -----

  const liveRecordFor = (key) => {
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    return record;
  };

  /**
   * Answer one parked permission (§3.2 `permissions.reply`): resolve the
   * parked JSON-RPC request with the selected option (or `cancelled`), then
   * emit `permission.replied`. A reject marks `declinedInTurn` (T2).
   */
  const replyPermission = async ({ key, requestId, reply }) => {
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
      throw new AcpSessionError('ACP permission reply must be once, always or reject', { code: 'ACP_INVALID_REQUEST' });
    }
    const record = liveRecordFor(key);
    ensurePendingMaps(record);
    const parked = record.pendingPermissions.get(requestId);
    if (!parked || parked.settled) {
      throw new AcpSessionError(`Unknown ACP permission: ${requestId}`, { code: 'ACP_PERMISSION_UNKNOWN' });
    }
    parked.settled = true;
    const optionId = optionIdForReply(parked.options, reply);
    if (reply === 'reject' || !optionId) record.declinedInTurn = true;
    try {
      parked.resolve(optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } });
    } finally {
      unpark(record, parked.cascade);
    }
    const syncEvents = [{ type: 'permission.replied', properties: { sessionID: key, requestID: requestId } }];
    emitSync(record.directory, syncEvents);
    touch(record);
    return { events: syncEvents };
  };

  const getPermission = async ({ key, requestId }) => {
    const record = liveRecordFor(key);
    const parked = record.pendingPermissions?.get(requestId);
    if (!parked || parked.settled) {
      throw new AcpSessionError(`Unknown ACP permission: ${requestId}`, { code: 'ACP_PERMISSION_UNKNOWN' });
    }
    return { permission: parked.request };
  };

  const listPendingPermissions = async ({ directory }) => {
    const cwd = await canonicalDirectoryImpl(directory);
    const wanted = directoryKey(cwd);
    const out = [];
    for (const record of live.values()) {
      if (directoryKey(record.directory) !== wanted) continue;
      for (const parked of record.pendingPermissions?.values() ?? []) {
        if (!parked.settled) out.push(parked.request);
      }
    }
    return out;
  };

  /**
   * Answer one parked form (§3.2 `forms.reply`): elicitation forms resolve
   * `{action:'accept',content}`; choice prompts resolve the parked
   * permission with the selected `optionId`. Then `form.settled`.
   */
  const replyForm = async ({ key, formId, answer }) => {
    const record = liveRecordFor(key);
    ensurePendingMaps(record);
    const parked = record.pendingForms.get(formId);
    if (!parked || parked.settled) {
      throw new AcpSessionError(`Unknown ACP form: ${formId}`, { code: 'ACP_FORM_UNKNOWN' });
    }
    // Validation runs BEFORE settling: a rejected answer keeps the form
    // parked so the user can correct it.
    let content = null;
    let selected = null;
    if (parked.choice) {
      const choice = answer && typeof answer === 'object' ? answer.choice : undefined;
      const options = parked.choice.options ?? [];
      selected = options.find((option) => String(option?.optionId) === String(choice)) ?? null;
      if (!selected) {
        throw new AcpSessionError(`Unknown choice for form: ${choice}`, { code: 'ACP_INVALID_REQUEST' });
      }
    } else {
      content = contentForAnswer(parked.elicitation?.requestedSchema, answer);
      const invalid = validateAnswerContent(parked.elicitation?.requestedSchema, content);
      if (invalid) {
        throw new AcpSessionError(`Invalid form answer: ${invalid}`, { code: 'ACP_INVALID_REQUEST' });
      }
    }
    parked.settled = true;
    try {
      if (parked.choice) {
        // An explicit reject option is a decline (T2), like `reject` and
        // dismiss: the turn ends by user choice, not interruption.
        if (selected.kind === 'reject_once' || selected.kind === 'reject_always') record.declinedInTurn = true;
        parked.resolve({ outcome: { outcome: 'selected', optionId: selected.optionId } });
      } else {
        parked.resolve({ action: 'accept', content });
      }
    } finally {
      unpark(record, parked.cascade);
    }
    const syncEvents = [{ type: 'form.settled', properties: { sessionID: key, formID: formId } }];
    emitSync(record.directory, syncEvents);
    touch(record);
    return { events: syncEvents };
  };

  /**
   * Dismiss one parked form: elicitation resolves `{action:'cancel'}`;
   * choice prompts answer the parked permission with `cancelled`. Marks
   * `declinedInTurn` (T2 covers dismissed questions too).
   */
  const cancelForm = async ({ key, formId }) => {
    const record = liveRecordFor(key);
    ensurePendingMaps(record);
    const parked = record.pendingForms.get(formId);
    if (!parked || parked.settled) {
      throw new AcpSessionError(`Unknown ACP form: ${formId}`, { code: 'ACP_FORM_UNKNOWN' });
    }
    parked.settled = true;
    record.declinedInTurn = true;
    try {
      parked.resolve(parked.choice ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' });
    } finally {
      unpark(record, parked.cascade);
    }
    const syncEvents = [{ type: 'form.settled', properties: { sessionID: key, formID: formId } }];
    emitSync(record.directory, syncEvents);
    touch(record);
    return { events: syncEvents };
  };

  const listPendingForms = async ({ directory }) => {
    const cwd = await canonicalDirectoryImpl(directory);
    const wanted = directoryKey(cwd);
    const out = [];
    for (const record of live.values()) {
      if (directoryKey(record.directory) !== wanted) continue;
      for (const parked of record.pendingForms?.values() ?? []) {
        if (!parked.settled) out.push(parked.form);
      }
    }
    return out;
  };

  /** Cached `available_commands` of one session, `CommandInfo`-compatible. */
  const commands = async ({ key }) => {
    await open({ key });
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    touch(record);
    return (record.projector.commands ?? []).map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
    }));
  };

  /** Last-seen config options of one backend (D9 pre-session picker). */
  const configCache = async ({ backendId }) => {
    if (!registry || typeof registry.list !== 'function') return [];
    const entries = await registry.list().catch(() => []);
    const entry = (Array.isArray(entries) ? entries : []).find((row) => row?.id === backendId);
    if (!entry) {
      throw new AcpSessionError(`Unknown ACP backend: ${backendId}`, { code: 'ACP_BACKEND_UNKNOWN' });
    }
    const cached = entry?.cache?.configOptions;
    return Array.isArray(cached) ? cached : [];
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
    // A revert/fork holds the mutation lock through restore + boundary:
    // deleting under it would strand the boundary install and the fork
    // record. Deletion refuses while a mutation runs (409).
    if (record?.mutating) throw busyError(key);
    if (record?.turn) {
      await cancel({ key }).catch(() => {});
    }
    // A deleted parent orphans its descendants' parked prompts (their agent
    // context is gone with the session): settle them so no card or agent
    // turn hangs. Descendant records/transcripts stay live and viewable.
    if (record) answerPendingTree(record);
    const connected = record?.connected ?? await connectionOf(entry.backendId).catch(() => null);
    const caps = sessionCaps(capsOf(connected));
    // D5: delete is idempotent. When the agent call fails because the
    // session or the whole connection is already gone, the local state
    // (index entry + checkpoint refs) still drops and the delete reports
    // success with a warning — otherwise the zombie survives restarts.
    // Any other agent failure still throws (the session may be alive).
    let warning = null;
    const forget = async () => {
      dropLive(key, { onlyRecord: record });
      deletedKeys.add(key);
      await index.remove(key);
      // Checkpoint refs die with the session (best-effort; a GC failure
      // must not fail the delete).
      if (checkpoints) {
        await checkpoints.gc({ sessionKey: key, cwd: entry.cwd }).catch(() => {});
      }
      const deleted = { type: 'session.deleted', properties: { sessionID: key } };
      emitSync(entry.cwd, [deleted]);
    };
    if (connected && (hasCap(caps, 'delete') || hasCap(caps, 'close'))) {
      try {
        if (hasCap(caps, 'delete')) {
          await connected.connection.deleteSession({ sessionId: entry.nativeId });
        } else {
          await connected.connection.closeSession({ sessionId: entry.nativeId });
        }
      } catch (error) {
        if (!isGoneSessionError(error)) throw error;
        warning = promptErrorDetails(error).message;
      }
    } else if (!connected) {
      warning = `ACP backend ${entry.backendId} is unreachable; dropped local session state`;
    }
    await forget();
    return warning ? { deleted: true, warning } : true;
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

  // -- Phase 1.5 operations: checkpoints, turn diff, revert, fork ------------

  /** Per-turn checkpoint completeness of one session, oldest first. */
  const checkpointsOf = async ({ key }) => {
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    const entry = live.get(key)?.entry ?? await index.get(key);
    if (!entry) throw unknownError(key);
    return (Array.isArray(entry.checkpoints) ? entry.checkpoints : [])
      .filter((row) => Number.isInteger(row?.turn))
      .map((row) => ({ turn: row.turn, complete: row.complete === true }))
      .sort((a, b) => a.turn - b.turn);
  };

  const requireCheckpointStore = () => {
    if (!checkpoints) {
      throw new AcpSessionError('ACP checkpoints are not available', { code: 'ACP_SESSIONS_UNAVAILABLE' });
    }
    return checkpoints;
  };

  /**
   * Turn diff (D14): `start..end` of one turn in the DiffView shape
   * (`FileDiffInfo[]`). Incomplete turns refuse — their `start` never
   * landed, so there is nothing truthful to diff.
   */
  const diff = async ({ key, turn }) => {
    if (!Number.isInteger(turn) || turn <= 0) {
      throw new AcpSessionError('ACP diff requires a positive turn', { code: 'ACP_INVALID_REQUEST' });
    }
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    await open({ key });
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    const row = checkpointRowOf(record.entry, turn);
    if (!row) {
      throw new AcpSessionError(`No checkpoint for turn ${turn} of ${key}`, { code: 'ACP_CHECKPOINT_UNKNOWN' });
    }
    if (row.complete !== true || !row.end) {
      throw new AcpSessionError(`Checkpoint for turn ${turn} of ${key} is incomplete`, { code: 'ACP_CHECKPOINT_INCOMPLETE' });
    }
    touch(record);
    return requireCheckpointStore().diff({ cwd: record.directory, from: row.start, to: row.end });
  };

  /**
   * Ask the agent to fork the session (unstable `session/fork`, T6: never
   * send `before` — no agent advertises fork-at-message). Returns the fork
   * response, or null when the backend does not advertise `fork`.
   */
  const forkNative = async (record, connected) => {
    const caps = sessionCaps(capsOf(connected));
    if (!hasCap(caps, 'fork')) return null;
    if (typeof connected.connection.unstable_forkSession !== 'function') {
      throw new AcpSessionError(`ACP backend ${record.backendId} offers no fork method`, {
        code: 'ACP_FORK_UNSUPPORTED',
      });
    }
    return connected.connection.unstable_forkSession({
      sessionId: record.nativeId,
      cwd: record.directory,
      mcpServers: [],
    });
  };

  /** First user message id of a canonical turn ordinal, or null. */
  const userMessageIdForTurn = (record, turn) => {
    if (typeof record.projector.turnNumberOf !== 'function') return null;
    for (const id of record.projector.transcriptIds()) {
      if (record.projector.turnNumberOf(id) === turn) return id;
    }
    return null;
  };

  /** Track a live record for a forked native session id. */
  const trackFork = async ({ record, nativeId, forked, pendingRevertNote = null }) => {
    const forkKey = encode(record.backendId, nativeId);
    const created = now();
    const sourceEntry = record.entry;
    const entry = await index.upsert(forkKey, {
      backendId: record.backendId,
      nativeId,
      cwd: record.directory,
      title: sourceEntry.title ?? '',
      ...(sourceEntry.userTitle ? { userTitle: sourceEntry.userTitle } : {}),
      ...(typeof pendingRevertNote === 'string' && pendingRevertNote ? { pendingRevertNote } : {}),
      created,
      updated: created,
    });
    const projector = createProjector({ key: forkKey, backendId: record.backendId, directory: record.directory, index: entry, now });
    projector.seed(forked, capsOf(record.connected));
    const forkedRecord = {
      key: forkKey,
      entry,
      projector,
      nativeId,
      backendId: record.backendId,
      directory: record.directory,
      connected: record.connected,
      generation: record.connected?.generation,
      turn: null,
      turnGeneration: 0,
      cancelled: false,
      declinedInTurn: false,
      settling: false,
      recovering: false,
      replaying: false,
      watchdogTimer: null,
      pendingRequests: [],
      pendingPermissions: new Map(),
      pendingForms: new Map(),
      readOnly: false,
      lastUpdateAt: created,
      lastActiveAt: created,
    };
    trackLive(forkedRecord);
    return { forkKey, forkedRecord, created };
  };

  /**
   * Rebuild a freshly tracked fork through its own `load` before it is
   * exposed as ready: ACP fork preserves the whole transcript, and the
   * fork's checkpoint turns must number canonically from the inherited
   * conversation. Replay routes to the fork record (tracked, so bound
   * updates land); failures drop the fork — a fork with no transcript
   * is worse than no fork.
   */
  const openForkRecord = async (forkedRecord) => {
    const connected = forkedRecord.connected;
    // Shield the rebuild with an opening guard: concurrent open() calls
    // for the fork key await the SAME replay instead of racing it, so a
    // reader can never see the fork mid-rebuild (empty transcript) or
    // start a second load against it.
    if (opening.has(forkedRecord.key)) {
      await opening.get(forkedRecord.key).catch(() => {});
      const settled = live.get(forkedRecord.key);
      if (settled?.projector) return { session: settled.projector.session(), events: [] };
      throw unknownError(forkedRecord.key);
    }
    let releaseOpening;
    const gate = new Promise((resolve) => { releaseOpening = resolve; });
    opening.set(forkedRecord.key, gate);
    forkedRecord.replaying = true;
    forkedRecord.replayBuffer = [];
    forkedRecord.projector.beginReplay();
    let response;
    try {
      response = await connected.connection.loadSession({
        sessionId: forkedRecord.nativeId,
        cwd: forkedRecord.directory,
        mcpServers: [],
      });
    } catch (error) {
      forkedRecord.projector.rollbackReplay();
      forkedRecord.replaying = false;
      forkedRecord.replayBuffer = null;
      dropLive(forkedRecord.key, { onlyRecord: forkedRecord });
      if (opening.get(forkedRecord.key) === gate) opening.delete(forkedRecord.key);
      releaseOpening();
      throw new AcpSessionError(`ACP fork failed to load: ${error?.message ?? error}`, {
        code: error?.code ?? 'ACP_LOAD_FAILED',
        cause: error,
      });
    }
    forkedRecord.projector.seed(response, capsOf(connected));
    const replacement = forkedRecord.projector.endReplay();
    const buffered = forkedRecord.replayBuffer ?? [];
    forkedRecord.replaying = false;
    forkedRecord.replayBuffer = null;
    forkedRecord.entry = { ...forkedRecord.entry, messageIds: forkedRecord.projector.transcriptIds().slice(-5000) };
    await index.upsert(forkedRecord.key, { messageIds: forkedRecord.entry.messageIds, updated: now() }).catch(() => {});
    if (opening.get(forkedRecord.key) === gate) opening.delete(forkedRecord.key);
    releaseOpening();
    const events = [...replacement, ...buffered];
    emitSync(forkedRecord.directory, events);
    return { session: forkedRecord.projector.session(), events };
  };

  /**
   * Revert (D13): restore files to the target turn's `start` tree with
   * `current` = the newest session-owned end tree (rejected when none
   * exists — the shared project index is never the deletion base), then
   * the conversation boundary. A generation-owned mutation lock spans
   * restore + boundary so no turn can edit concurrently. Fork when the
   * backend supports it (the fork rebuilds via its own load, arms the
   * persisted rollback note, and the caller continues there; the source
   * keeps its transcript and refs), else the boundary lands on the
   * authoritative projection with a persisted exactly-once note. Refuses
   * while busy (409). The boundary is `session.revert.messageID` — the
   * field the UI dock reads — plus `metadata.acp.revertedFromTurn`.
   */
  const revert = async ({ key, turn }) => {
    if (!Number.isInteger(turn) || turn <= 0) {
      throw new AcpSessionError('ACP revert requires a positive turn', { code: 'ACP_INVALID_REQUEST' });
    }
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    await open({ key });
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    assertMutable(record);
    if (record.readOnly) {
      throw new AcpSessionError(`ACP session is read-only: ${key}`, { code: 'ACP_SESSION_READONLY' });
    }
    const row = checkpointRowOf(record.entry, turn);
    if (!row) {
      throw new AcpSessionError(`No checkpoint for turn ${turn} of ${key}`, { code: 'ACP_CHECKPOINT_UNKNOWN' });
    }
    if (row.complete !== true) {
      throw new AcpSessionError(`Checkpoint for turn ${turn} of ${key} is incomplete`, { code: 'ACP_CHECKPOINT_INCOMPLETE' });
    }
    // Session-owned deletion base: the newest `end` across THIS session's
    // rows — never the shared project index, which other sessions' turns
    // also warm. Without one the deletion set is unknowable and the
    // revert is rejected rather than guessing.
    const current = latestSessionEndTree(record.entry);
    if (!current) {
      throw new AcpSessionError(`No trustworthy end tree for ${key}; cannot revert`, { code: 'ACP_CHECKPOINT_INCOMPLETE' });
    }
    const store = requireCheckpointStore();
    return withMutationLock(record, async () => {
      if (live.get(key) !== record) throw unknownError(key);
      const outcome = await store.restore({ cwd: record.directory, tree: row.start, current });
      touch(record);
      // The boundary user message: the first message of turn N is where
      // the revert strip starts. Null when the projection predates the
      // checkpoint — then the strip marker is omitted but the metadata
      // boundary still lands.
      const boundaryMessageId = userMessageIdForTurn(record, turn);
      let forked = null;
      try {
        forked = await forkNative(record, record.connected);
      } catch (error) {
        // A fork the agent advertised but cannot perform is a failed
        // revert, not a silent no-fork revert: the files already
        // restored, so the session must not pretend the conversation
        // followed.
        throw new AcpSessionError(`ACP fork failed, files were restored: ${error?.message ?? error}`, {
          code: 'ACP_FORK_FAILED',
          cause: error,
        });
      }
      if (forked?.sessionId) {
        const nativeId = forked.sessionId;
        if (typeof nativeId !== 'string' || !nativeId) {
          throw new AcpSessionError('ACP backend returned no fork session id', { code: 'ACP_BAD_SESSION_ID' });
        }
        // Fork path: the fork inherits the whole transcript (rebuilt via
        // its own load before it is exposed), carries the persisted
        // rollback note for its first prompt, and the caller continues
        // there. The source keeps its transcript, its checkpoint rows
        // and its refs — and greys its undone turns.
        const note = REVERT_NOTE_PREFIX(turn);
        const { forkedRecord, created } = await trackFork({ record, nativeId, forked, pendingRevertNote: note });
        await openForkRecord(forkedRecord);
        record.entry = { ...record.entry, revertedFromTurn: turn, updated: created };
        if (boundaryMessageId) record.entry.revertMessageID = boundaryMessageId;
        await index.upsert(record.key, {
          revertedFromTurn: turn,
          ...(boundaryMessageId ? { revertMessageID: boundaryMessageId } : {}),
          updated: created,
        }).catch(() => {});
        const sourceEvents = boundaryMessageId && typeof record.projector.setRevertBoundary === 'function'
          ? record.projector.setRevertBoundary(turn, boundaryMessageId)
          : [];
        emitSync(record.directory, sourceEvents);
        const session = forkedRecord.projector.session();
        const createdEvents = [{ type: 'session.created', properties: { info: session } }];
        emitSync(record.directory, createdEvents);
        return { ...outcome, session, events: [...sourceEvents, ...createdEvents] };
      }
      // In-place path (no fork capability): the boundary lives on the
      // authoritative projection (GET/list/revert all serve it), the
      // pending note persists for exactly-once dispatch, and the patch
      // the revert strip renders goes out. The session itself returns.
      const at = now();
      const note = REVERT_NOTE_PREFIX(turn);
      record.entry = { ...record.entry, revertedFromTurn: turn, pendingRevertNote: note, updated: at };
      if (boundaryMessageId) record.entry.revertMessageID = boundaryMessageId;
      await index.upsert(record.key, {
        revertedFromTurn: turn,
        pendingRevertNote: note,
        ...(boundaryMessageId ? { revertMessageID: boundaryMessageId } : {}),
        updated: at,
      }).catch(() => {});
      const syncEvents = boundaryMessageId && typeof record.projector.setRevertBoundary === 'function'
        ? record.projector.setRevertBoundary(turn, boundaryMessageId)
        : [];
      emitSync(record.directory, syncEvents);
      return { ...outcome, session: record.projector.session(), events: syncEvents };
    });
  };

  /**
   * Fork one session (§3.2 `sessions.fork`): only when the fork capability
   * is present (unstable). The fork rebuilds via its own load before it
   * is exposed, so its transcript and turn numbering are canonical.
   */
  const fork = async ({ key }) => {
    const decoded = decode(key);
    if (!decoded) throw unknownError(key);
    await open({ key });
    const record = live.get(key);
    if (!record?.projector) throw unknownError(key);
    assertMutable(record);
    return withMutationLock(record, async () => {
      if (live.get(key) !== record) throw unknownError(key);
      const forked = await forkNative(record, record.connected);
      if (!forked || typeof forked.sessionId !== 'string' || !forked.sessionId) {
        throw new AcpSessionError(`ACP backend ${record.backendId} does not support fork`, { code: 'ACP_FORK_UNSUPPORTED' });
      }
      const { forkKey, forkedRecord } = await trackFork({ record, nativeId: forked.sessionId, forked });
      const { events: replayEvents } = await openForkRecord(forkedRecord);
      const session = forkedRecord.projector.session();
      const syncEvents = [
        { type: 'session.forked', properties: { sessionID: forkKey, parentID: key } },
        { type: 'session.created', properties: { info: session } },
      ];
      emitSync(record.directory, syncEvents);
      touch(record);
      return { session, events: [...replayEvents, ...syncEvents] };
    });
  };

  const status = async ({ directory }) => {
    const cwd = await canonicalDirectoryImpl(directory);
    const wanted = directoryKey(cwd);
    pruneIdle();
    const statuses = {};
    for (const record of live.values()) {
      if (directoryKey(record.directory) !== wanted || !record.projector) continue;
      // A turn whose result is being settled (end snapshot, deferred
      // release) still owns the session: report busy until `record.turn`
      // clears, or clients prompt into a 409.
      statuses[record.key] = record.turn || record.projector.busy
        ? { type: 'busy' }
        : { ...record.projector.status };
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
    checkpoints: checkpointsOf,
    diff,
    revert,
    fork,
    /**
     * True when a live record tracks `nativeId` on `backendId`. The host's
     * one-off `isKnownSession` predicate: disambiguates the throwaway
     * creation window (unknown ids then are the throwaway's own setup
     * traffic; known ids always pass through to the session router).
     */
    hasNativeSession: (backendId, nativeId) => {
      if (typeof backendId !== 'string' || typeof nativeId !== 'string') return false;
      const key = byNative.get(`${backendId}\0${nativeId}`);
      return typeof key === 'string' && live.has(key);
    },
    replyPermission,
    getPermission,
    listPendingPermissions,
    replyForm,
    cancelForm,
    listPendingForms,
    commands,
    configCache,
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
