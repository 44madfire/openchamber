/**
 * One-off generation (D15): throwaway ACP sessions for the small-model
 * callers (commit/PR message, rename, walkthrough).
 *
 * Each `generate()` call runs `session/new` in a fresh empty temp cwd →
 * `set_config_option` to the backend's configured helper model/effort →
 * one strict-format prompt → `delete` if supported, else `close`. Calls
 * are serialized per backend and never touch the session index, the
 * projector, or UI events: the throwaway session id is known only here.
 *
 * Sharing the backend process is safe by construction: `session/update`
 * traffic routes through the connection hooks the host bound at connect
 * time, which only know about indexed sessions. The one-off collector
 * subscribes through `hooksForOneOff(backendId)`, which the host composes
 * into the manager's `connectionHooks` factory alongside the session
 * service's `hooksForBackend`:
 *
 * ```js
 * connectionHooks: (backendId, generation) => {
 *   const sessions = service.hooksForBackend(backendId, generation);
 *   const oneOff = oneOffs.hooksForOneOff(backendId);
 *   return {
 *     ...sessions,
 *     onSessionUpdate: async (params) => {
 *       // The one-off hook returns true when the update belonged to a
 *       // live throwaway session; those are swallowed, everything else
 *       // reaches the session router untouched.
 *       if (await oneOff.onSessionUpdate(params)) return;
 *       await sessions.onSessionUpdate?.(params);
 *     },
 *     // One-off sessions must never surface permission or elicitation
 *     // prompts: a throwaway turn has no user to ask, so decline them
 *     // before the session router can park them.
 *     onRequestPermission: async (params) => (
 *       (await oneOff.onRequestPermission?.(params)) ?? sessions.onRequestPermission(params)
 *     ),
 *     onElicitation: async (params) => (
 *       (await oneOff.onElicitation?.(params)) ?? sessions.onElicitation(params)
 *     ),
 *   };
 * },
 * ```
 *
 * Updates for the one-off session id are collected locally and swallowed —
 * never forwarded to the session router — and everything else passes
 * through untouched, so concurrent normal sessions on the same connection
 * are unaffected. No change to `connection.js` or `backend-manager.js` was
 * needed: the `connectionHooks` factory already composes per-backend hooks.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Default prompt timeout; the turn is cancelled past it. */
export const DEFAULT_ONEOFF_TIMEOUT_MS = 60_000;
/** Default output clamp: commit messages and titles are short. */
export const DEFAULT_ONEOFF_MAX_CHARS = 2000;
/** Prefix for the per-call temp cwd (created + removed per call). */
export const ONEOFF_TMP_PREFIX = 'acp-oneoff-';
/** Best-effort bound for cancel sends and delete/close cleanup RPCs. */
export const ONEOFF_CLEANUP_TIMEOUT_MS = 5_000;
/** Grace wait for a cancelled turn to settle before giving up on it. */
export const ONEOFF_CANCEL_SETTLE_MS = 1_000;

export class AcpOneOffError extends Error {
  constructor(message, { code, backendId, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AcpOneOffError';
    if (code !== undefined) this.code = code;
    if (backendId !== undefined) this.backendId = backendId;
  }
}

const hasCap = (caps, name) => {
  if (!caps || typeof caps !== 'object') return false;
  const value = caps[name];
  return value !== undefined && value !== null && value !== false;
};

const sessionCapsOf = (connected) =>
  (connected?.agentCapabilities && typeof connected.agentCapabilities === 'object'
    ? connected.agentCapabilities.sessionCapabilities
    : null) ?? {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Race `promise` against `ms`; on timeout reject with `error`. The loser's
 * settlement is always observed, so nothing here can surface as an
 * unhandled rejection. A non-positive `ms` waits forever.
 */
const withTimeout = async (promise, ms, error) => {
  if (!(ms > 0)) return promise;
  let timer = null;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(error), ms);
      timer.unref?.();
      Promise.resolve(promise).then(
        (value) => resolve(value),
        (failure) => reject(failure),
      );
    });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Await `promise` but give up after `ms`, resolving `fallback` instead.
 * The underlying promise still settles in the background (observed, so no
 * unhandled rejection); late success after a timeout just goes nowhere.
 * Used for best-effort phases (cancel, cleanup) that must never wedge the
 * caller's queue.
 */
const withSettleCap = async (promise, ms, fallback) => {
  if (!(ms > 0)) {
    try {
      return await promise;
    } catch {
      return fallback;
    }
  }
  let timer = null;
  try {
    return await new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
      Promise.resolve(promise).then(
        (value) => resolve(value),
        () => resolve(fallback),
      );
    });
  } finally {
    clearTimeout(timer);
  }
};

const selectValuesOf = (option) => {
  const values = new Set();
  const options = Array.isArray(option?.options) ? option.options : null;
  if (!options) return values;
  for (const item of options) {
    if (item && typeof item === 'object') {
      if (typeof item.value === 'string') values.add(item.value);
      // Grouped options nest the values one level deeper.
      if (Array.isArray(item.options)) {
        for (const nested of item.options) {
          if (nested && typeof nested.value === 'string') values.add(nested.value);
        }
      }
    }
  }
  return values;
};

/**
 * Coerce a registry helper value (always a string per the schema) to the
 * wire shape of the advertised option: booleans take `{ type: 'boolean',
 * value }`; selects take the value id as a string.
 * Returns `{ request, warning }`: `request` is null when the value cannot
 * apply to this option (unknown id handled by the caller). A select value
 * is accepted ONLY when it is actually listed: an empty or missing options
 * list means the value cannot be verified, so it warns rather than sending
 * an arbitrary value the agent may reject mid-turn.
 */
const coerceHelperValue = (option, rawValue) => {
  const type = option?.type;
  if (type === 'boolean') {
    const normalized = String(rawValue).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return { request: { type: 'boolean', value: true }, warning: null };
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return { request: { type: 'boolean', value: false }, warning: null };
    }
    return {
      request: null,
      warning: `helper config "${option.id}" ignored: "${rawValue}" is not a boolean value`,
    };
  }
  const values = selectValuesOf(option);
  if (!values.has(String(rawValue))) {
    return {
      request: null,
      warning: `helper config "${option.id}" ignored: "${rawValue}" is not an advertised value`,
    };
  }
  return { request: { value: String(rawValue) }, warning: null };
};

const advertisedOptionsOf = (configOptions) => {
  const advertised = new Map();
  for (const option of configOptions ?? []) {
    if (option && typeof option.id === 'string') advertised.set(option.id, option);
  }
  return advertised;
};

const FENCE_RE = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/;
const QUOTE_RE = /^(['"`])((?:(?!\1)[\s\S])*)\1$/;
// Conversational lead-ins only: a generic "Capitalized heading:" rule would
// eat legitimate requested output such as "Summary:\n…" or "Notes:\n…".
const PREAMBLE_RE = /^(sure|certainly|of course|absolutely|here('s| is)|below is|here you go)\b[\s!.:,;-]*$/i;
// A bare "Label:" lead-in counts only when it reads as chat ("Here is your
// commit message:"), not as a document heading ("Summary:").
const CHATTY_LABEL_RE = /^here (is|are) .+:\s*$/i;
const SIGNOFF_RE = /^(hope this helps|let me know|feel free)\b[\s\S]*$/i;

const stripPreambleLines = (text) => {
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length - 1) {
    const line = lines[start].trim();
    if (PREAMBLE_RE.test(line) || CHATTY_LABEL_RE.test(line)) {
      start += 1;
      continue;
    }
    break;
  }
  return { lines, start };
};

const stripSignoffLine = (lines, start) => {
  let end = lines.length;
  if (end - start > 1 && SIGNOFF_RE.test(lines[end - 1].trim())) {
    end -= 1;
  }
  return end;
};

const stripWrappers = (text) => {
  let current = text.trim();
  if (!current) return current;
  const fenced = FENCE_RE.exec(current);
  if (fenced) current = fenced[1].trim();
  const quoted = QUOTE_RE.exec(current);
  if (quoted) current = quoted[2].trim();
  return current;
};

/**
 * Trim the collected text to the requested shape: drop chatty preamble
 * lines first ("Sure, here is …"), then code fences and a single
 * surrounding quote pair, then a trailing sign-off ("Hope this helps!"),
 * and finally truncate to `maxChars`. Preamble removal runs before wrapper
 * stripping (and once more after) so combined preamble+fence replies still
 * unwrap; document headings such as "Summary:" are preserved.
 */
export const trimOneOffOutput = (raw, maxChars = DEFAULT_ONEOFF_MAX_CHARS) => {
  let text = typeof raw === 'string' ? raw : '';
  text = text.trim();
  if (!text) return '';
  // Preamble first: a lead-in above a fence would otherwise pin it in place.
  let stripped = stripPreambleLines(text);
  text = stripped.lines.slice(stripped.start).join('\n').trim();
  if (!text) return '';
  text = stripWrappers(text);
  if (!text) return '';
  // A fence can hide a second lead-in ("```\nHere is…\n…```"); the same
  // pass also drops the trailing sign-off.
  stripped = stripPreambleLines(text);
  const end = stripSignoffLine(stripped.lines, stripped.start);
  text = stripped.lines.slice(stripped.start, end).join('\n').trim();
  text = stripWrappers(text);
  const limit = Number(maxChars);
  if (Number.isFinite(limit) && limit >= 0 && text.length > limit) {
    text = text.slice(0, limit).trimEnd();
  }
  return text;
};

export const createOneOff = ({
  manager,
  registry,
  index = null,
  tmpRoot = null,
  timeoutMs = DEFAULT_ONEOFF_TIMEOUT_MS,
  cleanupTimeoutMs = ONEOFF_CLEANUP_TIMEOUT_MS,
  cancelSettleMs = ONEOFF_CANCEL_SETTLE_MS,
} = {}) => {
  if (!manager || typeof manager.ensureReady !== 'function') {
    throw new Error('createOneOff requires a backend manager');
  }
  if (typeof manager.acquire !== 'function') {
    throw new Error('createOneOff requires a backend manager with acquire/release leases');
  }
  if (!registry || typeof registry.get !== 'function') {
    throw new Error('createOneOff requires a backend registry');
  }

  // backendId -> Set of live collector records. The hook closure below
  // routes by session id; records self-remove when their turn settles so
  // the sets stay small and stale sessions never capture traffic.
  const collectors = new Map();
  // backendId -> count of in-flight session/new calls ("creation claims").
  // While a claim is pending, updates for session ids the session router
  // cannot know yet are swallowed: one-off calls are serialized per
  // backend, so any unknown id arriving during our creation window belongs
  // to the throwaway session being created. See hooksForOneOff.
  const pendingCreations = new Map();
  // backendId -> promise chain serializing generate() calls per backend.
  const queues = new Map();

  /**
   * Agent→client hooks for one-off sessions. The update hook returns true
   * when the update was claimed (the host swallows it) and false when it
   * must reach the session router. The permission/elicitation hooks return
   * a decline for one-off sessions, or null when the request belongs to a
   * normal session and must reach the session router.
   *
   * `isKnownSession`, when provided by the host, reports whether a session
   * id belongs to the indexed (normal) session set. It disambiguates the
   * creation window: unknown ids during a pending session/new are the
   * throwaway's own setup traffic; known ids always pass through. Without
   * it, only updates for fully-registered collector sessions are claimed,
   * and creation-window traffic passes through (safe, but noisier).
   */
  const hooksForOneOff = (backendId, { isKnownSession = null } = {}) => {
    const knownSession = typeof isKnownSession === 'function' ? isKnownSession : null;
    const claimsSession = (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) return false;
      const live = collectors.get(backendId);
      if (live) {
        for (const record of live) {
          if (record.sessionId === sessionId) return true;
        }
      }
      return false;
    };
    return {
      // Claims EVERY update for a live one-off session id — not just the
      // collected text — so nothing from a throwaway session (usage,
      // config echoes, trailing chunks after settle) can reach the session
      // router or the UI. Anything for another session id passes through.
      onSessionUpdate: (params) => {
        const sessionId = params?.sessionId;
        if (typeof sessionId !== 'string' || !sessionId) return false;
        const live = collectors.get(backendId);
        let claimed = false;
        if (live) {
          for (const record of live) {
            if (record.sessionId !== sessionId) continue;
            claimed = true;
            try {
              record.onUpdate(params?.update);
            } catch {
              // A collector bug must never break the agent→client pump.
            }
          }
        }
        if (claimed) return true;
        // In-flight creation with no collector yet: swallow the
        // throwaway's setup traffic (buffered text is discarded — setup
        // banners are never collected; see the turn gate).
        if ((pendingCreations.get(backendId) ?? 0) > 0 && knownSession && !knownSession(sessionId)) {
          return true;
        }
        return false;
      },
      // A throwaway turn has no user to ask: decline promptly so the agent
      // never blocks on a parked request. Non-one-off ids return null so
      // the host falls through to the session router.
      onRequestPermission: (params) => {
        if (claimsSession(params?.sessionId)) return { outcome: { outcome: 'cancelled' } };
        return null;
      },
      onElicitation: (params) => {
        const sessionId = params?.sessionId ?? params?._meta?.sessionId;
        if (claimsSession(sessionId)) return { action: 'cancel' };
        return null;
      },
    };
  };

  const removeCollector = (backendId, record) => {
    const live = collectors.get(backendId);
    if (!live) return;
    live.delete(record);
    if (live.size === 0) collectors.delete(backendId);
  };

  const trackCreation = (backendId) => {
    pendingCreations.set(backendId, (pendingCreations.get(backendId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (pendingCreations.get(backendId) ?? 1) - 1;
      if (left <= 0) pendingCreations.delete(backendId);
      else pendingCreations.set(backendId, left);
    };
  };

  // delete if capable, else close if capable, else leave; never throws and
  // never waits past `cleanupTimeoutMs` — cleanup must not wedge the queue.
  const cleanupSession = async (connected, sessionId) => {
    const caps = sessionCapsOf(connected);
    if (!hasCap(caps, 'delete') && !hasCap(caps, 'close')) return 'left';
    const attempt = (async () => {
      try {
        if (hasCap(caps, 'delete')) {
          await connected.connection.deleteSession({ sessionId });
          return 'deleted';
        }
        await connected.connection.closeSession({ sessionId });
        return 'closed';
      } catch {
        return 'left';
      }
    })();
    attempt.catch(() => {});
    return withSettleCap(attempt, cleanupTimeoutMs, 'left');
  };

  const cancelSession = async (connected, sessionId) => {
    const attempt = (async () => {
      try {
        await connected.connection.cancel({ sessionId });
        return true;
      } catch {
        return false;
      }
    })();
    attempt.catch(() => {});
    return withSettleCap(attempt, cleanupTimeoutMs, false);
  };

  const generateOne = async ({ backendId, instruction, input, maxChars }) => {
    if (typeof backendId !== 'string' || !backendId) {
      throw new AcpOneOffError('one-off generation requires a backendId', { code: 'ACP_ONEOFF_INVALID' });
    }
    if (typeof instruction !== 'string' || !instruction.trim()) {
      throw new AcpOneOffError('one-off generation requires an instruction', {
        code: 'ACP_ONEOFF_INVALID', backendId,
      });
    }
    if (typeof input !== 'string') {
      throw new AcpOneOffError('one-off generation requires an input string', {
        code: 'ACP_ONEOFF_INVALID', backendId,
      });
    }
    const limit = maxChars === undefined ? DEFAULT_ONEOFF_MAX_CHARS : maxChars;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
      throw new AcpOneOffError('one-off maxChars must be a non-negative number', {
        code: 'ACP_ONEOFF_INVALID', backendId,
      });
    }
    const effectiveTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_ONEOFF_TIMEOUT_MS;

    // The whole lifecycle — lease, temp dir, creation, helper config,
    // prompt, cancel, cleanup — runs under one deadline. `expired` flips
    // when the deadline passes, and every phase below races it, so a stuck
    // session/new, set_config_option, cancel send or delete/close still
    // releases the collector, the temp dir, the lease and the queue slot.
    let expired = false;
    let fireTimeout;
    const timeoutPromise = new Promise((_, reject) => {
      fireTimeout = () => {
        expired = true;
        reject(new AcpOneOffError(`one-off generation timed out after ${effectiveTimeout} ms`, {
          code: 'ACP_ONEOFF_TIMEOUT', backendId,
        }));
      };
    });
    timeoutPromise.catch(() => {});
    const timer = setTimeout(fireTimeout, effectiveTimeout);
    timer.unref?.();
    const bounded = (promise) => Promise.race([promise, timeoutPromise]);

    // Hold a manager lease for the complete lifecycle so idle reap cannot
    // kill the backend mid-turn (ensureReady alone only marks use).
    const acquirePromise = manager.acquire(backendId);
    acquirePromise.then(() => {}, () => {});
    let lease = null;
    let entry = null;
    try {
      lease = await bounded(acquirePromise);
      entry = await bounded(registry.get(backendId));
    } catch (error) {
      clearTimeout(timer);
      // A late acquire success after our deadline still holds a lease:
      // release whatever lands. A late failure has nothing to release.
      acquirePromise.then((late) => late?.release?.(), () => {});
      throw error;
    }
    const connected = lease.connection;
    if (!entry) {
      lease.release();
      clearTimeout(timer);
      throw new AcpOneOffError(`Unknown ACP backend: ${backendId}`, {
        code: 'ACP_BACKEND_UNKNOWN', backendId,
      });
    }

    // Fresh empty temp dir per call: the agent gets a cwd it cannot read
    // the project from, and nothing survives the call.
    const root = tmpRoot ?? os.tmpdir();
    let cwd = null;
    const removeTmp = async () => {
      if (!cwd) return;
      try {
        await fsp.rm(cwd, { recursive: true, force: true });
      } catch {
        // Best-effort: a leftover empty dir is harmless.
      }
    };

    let sessionId = null;
    let record = null;
    // A session/new response that arrives after the deadline still names a
    // live agent session: adopt it for a best-effort late cleanup instead
    // of leaking it.
    let lateSessionId = null;
    const noteLateSession = (created) => {
      const id = created?.sessionId;
      if (typeof id === 'string' && id && !sessionId) lateSessionId = id;
    };

    try {
      cwd = await bounded(fsp.mkdtemp(path.join(root, ONEOFF_TMP_PREFIX)));

      // Creation claim: registered BEFORE session/new runs, so updates the
      // agent emits while creation is in flight are classified (and
      // swallowed for the throwaway) instead of leaking to the router.
      const releaseCreation = trackCreation(backendId);
      let created;
      try {
        const newPromise = connected.connection.newSession({ cwd, mcpServers: [] });
        newPromise.then(noteLateSession, () => {});
        created = await bounded(newPromise);
      } finally {
        releaseCreation();
      }
      sessionId = created?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new AcpOneOffError(`ACP backend ${backendId} returned no session id`, {
          code: 'ACP_BAD_SESSION_ID', backendId,
        });
      }

      // Register the collector for the whole session life (not just the
      // prompt): helper-config echoes and pre-prompt announcements belong
      // to the throwaway session too, and must never reach the router.
      // Text collection itself starts at the prompt: agents may emit
      // session-setup banners as agent_message_chunk before the turn
      // (pi-acp's startup info), which must be claimed yet not collected.
      // Config echoes also refresh the advertised set below, so a
      // model-dependent option advertised mid-setup still validates.
      let text = '';
      let usage = null;
      let cost = null;
      // pi-acp echoes its startup info inside `_meta` on the session/new
      // response: retained here so a banner chunk that arrives AFTER the
      // prompt dispatches (a setTimeout-0 race on the agent side, past
      // every client-side gate) can still be recognized and stripped
      // from the collected result. No other agent is keyed on.
      const startupBanner = typeof created?._meta?.piAcp?.startupInfo === 'string'
        && created._meta.piAcp.startupInfo
        ? created._meta.piAcp.startupInfo
        : null;
      // Collection opens only once the prompt round-trip is actually
      // dispatched (see below): some agents emit setup banners as
      // `agent_message_chunk` AFTER `session/new` resolves (pi-acp posts
      // its Skills/Extensions banner via setTimeout(...,0)), and those
      // must be claimed yet never collected. The flag flips in the same
      // synchronous block that sends `session/prompt`, so no await gap
      // can interleave a banner between arming and dispatch.
      let turnStarted = false;
      let advertised = advertisedOptionsOf(created?.configOptions);
      record = {
        sessionId,
        onUpdate: (update) => {
          if (!update || typeof update !== 'object') return;
          const kind = update.sessionUpdate;
          if (kind === 'agent_message_chunk') {
            if (!turnStarted) return;
            const content = update.content;
            if (content?.type === 'text' && typeof content.text === 'string') {
              text += content.text;
            }
          } else if (kind === 'usage_update') {
            if (typeof update.used === 'number') {
              usage = { ...(usage ?? {}), totalTokens: update.used };
              if (typeof update.size === 'number') usage.contextSize = update.size;
            }
            if (update.cost && typeof update.cost.amount === 'number') {
              cost = { amount: update.cost.amount, currency: update.cost.currency ?? 'USD' };
            }
          } else if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
            advertised = advertisedOptionsOf(update.configOptions);
          } else if (kind === 'current_mode_update' && typeof update.currentModeId === 'string') {
            // A synthetic `mode` helper id tracks mode-only agents; keep it
            // verifiable without a config-options round trip.
            const modeOption = advertised.get('mode');
            if (modeOption) {
              advertised.set('mode', { ...modeOption, currentValue: update.currentModeId });
            }
          }
        },
      };
      let live = collectors.get(backendId);
      if (!live) {
        live = new Set();
        collectors.set(backendId, live);
      }
      live.add(record);

      // Helper config (§3.1): apply `{ configId: value }` only for ids the
      // session advertises. Unknown ids, uncoercible values and agent
      // rejections warn in the result — they never fail the call.
      //
      // Model first: switching models can reset dependent settings
      // (effort/thinking), so `model` applies before everything else.
      // After each set, the response's complete configOptions replace the
      // advertised set and every LATER setting re-validates against it —
      // a value that stops being advertised (or was only ever advertised
      // under another model) warns instead of sending a stale id.
      const warnings = [];
      const helper = entry.helper?.config ?? {};
      const helperIds = Object.keys(helper);
      const modelFirst = (ids) => ids.sort((a, b) => {
        if (a === 'model' && b !== 'model') return -1;
        if (b === 'model' && a !== 'model') return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const configId of modelFirst(helperIds)) {
        const option = advertised.get(configId);
        if (!option) {
          warnings.push(`helper config "${configId}" ignored: not advertised by this session`);
          continue;
        }
        const { request, warning } = coerceHelperValue(option, helper[configId]);
        if (!request) {
          warnings.push(warning);
          continue;
        }
        try {
          const response = await bounded(
            connected.connection.setSessionConfigOption({ sessionId, configId, ...request }),
          );
          if (response && Array.isArray(response.configOptions)) {
            advertised = advertisedOptionsOf(response.configOptions);
          }
        } catch (error) {
          if (expired) throw error;
          warnings.push(`helper config "${configId}" rejected: ${error?.message ?? error}`);
        }
      }

      const promptBlocks = [
        { type: 'text', text: `Reply with exactly what is requested and nothing else. No preamble, no explanation, no quotes, no code fences.\n\n${instruction.trim()}` },
        { type: 'text', text: input },
      ];
      // Open collection in the same synchronous block that dispatches the
      // prompt: anything the agent emitted before this line (post-new
      // setup banners, helper-config echoes) is claimed but dropped, and
      // no await gap can interleave a banner between arming and dispatch.
      text = '';
      turnStarted = true;
      const promptPromise = connected.connection.prompt({ sessionId, prompt: promptBlocks });
      promptPromise.then(() => {}, () => {});
      let promptResult = null;
      try {
        promptResult = await bounded(promptPromise);
      } catch (error) {
        if (expired) {
          // Deadline hit mid-turn: cancel (bounded, best-effort), give the
          // cancelled turn a beat to settle, then report the timeout.
          await cancelSession(connected, sessionId);
          await withSettleCap(promptPromise.catch(() => null), cancelSettleMs, null);
        }
        throw error;
      }

      // Draft-RFD prompt usage fills gaps the usage_update stream left.
      const draftUsage = promptResult?.usage;
      if (draftUsage && typeof draftUsage === 'object') {
        const total = typeof draftUsage.totalTokens === 'number'
          ? draftUsage.totalTokens
          : (typeof draftUsage.inputTokens === 'number' || typeof draftUsage.outputTokens === 'number'
            ? (draftUsage.inputTokens ?? 0) + (draftUsage.outputTokens ?? 0)
            : null);
        if (total !== null && !(usage && typeof usage.totalTokens === 'number')) {
          usage = { ...(usage ?? {}), totalTokens: total };
        }
      }

      const sessionCleanup = await cleanupSession(connected, sessionId);
      clearTimeout(timer);
      // A setup banner that won the agent-side race lands inside the
      // collected turn text (the gate cannot precede the response it
      // follows). When the agent told us its exact banner bytes in the
      // session/new `_meta`, strip that prefix verbatim: exact-match
      // only, so genuine model output is never touched.
      let collected = text;
      if (startupBanner && collected.startsWith(startupBanner)) {
        collected = collected.slice(startupBanner.length);
      }
      return {
        text: trimOneOffOutput(collected, limit),
        ...(usage ? { usage } : {}),
        ...(cost ? { cost } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        sessionCleanup,
      };
    } catch (error) {
      // Failed calls still clean up their session (bounded, best-effort,
      // never masks the original error) so timeouts and prompt errors
      // leave no trace. A late session/new arrival is adopted here too.
      const target = sessionId ?? lateSessionId;
      if (target && connected) {
        await cleanupSession(connected, target).catch(() => 'left');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (record) removeCollector(backendId, record);
      await removeTmp();
      lease.release();
    }
  };

  // Serialize calls per backend: the queue chain never rejects AND always
  // settles (generateOne is fully deadline-bounded), so one call's failure
  // — or a stuck agent — cannot wedge the backend for the next.
  const generate = async (options) => {
    const backendId = options?.backendId;
    const previous = queues.get(backendId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    queues.set(backendId, tail);
    await previous.catch(() => {});
    try {
      return await generateOne(options);
    } finally {
      release();
      if (queues.get(backendId) === tail) queues.delete(backendId);
    }
  };

  /**
   * Default backend selection for the one-off route and the small-model
   * fallback (Phase 1.6): an explicit `backendId` wins (unknown/disabled
   * rejected); else the session's own backend when `sessionKey` names an
   * indexed session; else the first ready enabled backend, in registry
   * order. Readiness is probed via `ensureReady` — a start failure moves
   * on to the next entry instead of failing the call.
   */
  const resolveBackend = async ({ backendId = null, sessionKey = null } = {}) => {
    if (backendId !== null && backendId !== undefined) {
      if (typeof backendId !== 'string' || !backendId) {
        throw new AcpOneOffError('one-off backendId must be a non-empty string', { code: 'ACP_ONEOFF_INVALID' });
      }
      const entry = await registry.get(backendId);
      if (!entry) {
        throw new AcpOneOffError(`Unknown ACP backend: ${backendId}`, { code: 'ACP_BACKEND_UNKNOWN', backendId });
      }
      if (entry.enabled === false) {
        throw new AcpOneOffError(`ACP backend is disabled: ${backendId}`, { code: 'ACP_BACKEND_DISABLED', backendId });
      }
      return backendId;
    }
    if (sessionKey !== null && sessionKey !== undefined) {
      if (typeof sessionKey !== 'string' || !sessionKey || typeof index?.get !== 'function') {
        throw new AcpOneOffError('one-off sessionKey must be a non-empty string', { code: 'ACP_ONEOFF_INVALID' });
      }
      const session = await index.get(sessionKey).catch(() => null);
      if (session?.backendId) return resolveBackend({ backendId: session.backendId });
      throw new AcpOneOffError(`Unknown ACP session: ${sessionKey}`, { code: 'ACP_SESSION_UNKNOWN' });
    }
    const entries = await registry.list().catch(() => []);
    for (const entry of entries ?? []) {
      if (!entry || entry.enabled === false) continue;
      try {
        await manager.ensureReady(entry.id);
        return entry.id;
      } catch {
        // Not startable right now; the next entry may be.
      }
    }
    throw new AcpOneOffError('No ready ACP backend is available', { code: 'ACP_BACKEND_UNAVAILABLE' });
  };

  return { generate, resolveBackend, hooksForOneOff, trimOneOffOutput };
};
