/**
 * Session index (D10): the sidecar `acp-sessions.json` that makes ACP sessions
 * listable, renamable and re-openable across server restarts.
 *
 * One entry per session the user has seen: `{ key, backendId, nativeId, cwd,
 * title, userTitle?, parentKey?, created, updated, lastConfig?,
 * checkpoints?, revertedFromTurn?, revertMessageID?, pendingRevertNote? }`.
 * It records what ACP itself cannot: user renames (no ACP method), parent
 * linkage (missing from opencode's list), the last-seen config for the
 * pre-session picker, per-turn git checkpoint trees (D12), the revert
 * boundary (D13: turn ordinal + boundary message id) and the pending
 * next-prompt note (consumed exactly once). It stores NO transcript — a
 * cold session rebuilds its projection from `session/load` replay.
 * Version 2 adds the checkpoint/revert fields; version 1 files still load
 * (the new fields are optional and fill in on next write).
 *
 * Writes are atomic (temp file + rename) and mutations are serialized, the
 * same pattern as the backend registry. `title` is the agent's latest title;
 * `displayTitle(entry)` prefers `userTitle` when set.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { directoryKey } from './directory-key.js';
import { BACKEND_ID_PATTERN } from './session-key.js';

export const ACP_SESSIONS_FILE = 'acp-sessions.json';
const STORE_VERSION = 2;

const TREE_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const checkpointSchema = z.strictObject({
  turn: z.number().int().positive(),
  start: z.string().regex(TREE_ID_PATTERN),
  end: z.string().regex(TREE_ID_PATTERN).nullable(),
  complete: z.boolean(),
});

const entrySchema = z.strictObject({
  key: z.string().min(1).max(128),
  backendId: z.string().regex(BACKEND_ID_PATTERN),
  nativeId: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(32_000),
  title: z.string().max(500).default(''),
  userTitle: z.string().min(1).max(500).optional(),
  parentKey: z.string().min(1).max(128).optional(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  lastConfig: z.record(z.string().max(256), z.union([z.string().max(4096), z.number(), z.boolean()])).optional(),
  messageIds: z.array(z.string().max(256)).max(5000).optional(),
  checkpoints: z.array(checkpointSchema).max(100_000).optional(),
  revertedFromTurn: z.number().int().positive().optional(),
  revertMessageID: z.string().min(1).max(256).optional(),
  pendingRevertNote: z.string().min(1).max(2000).optional(),
});

const storeSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(STORE_VERSION)]),
  sessions: z.array(entrySchema),
});

/**
 * @typedef {z.infer<typeof entrySchema>} AcpSessionEntry
 */

/** The title the UI shows: an explicit user rename wins over the agent title. */
export const displayTitle = (entry) => entry?.userTitle ?? entry?.title ?? '';

const filePathFor = (dataDir) => path.join(dataDir, ACP_SESSIONS_FILE);

const clone = (entry) => ({
  ...entry,
  ...(entry.lastConfig ? { lastConfig: { ...entry.lastConfig } } : {}),
  ...(entry.messageIds ? { messageIds: [...entry.messageIds] } : {}),
  ...(entry.checkpoints ? { checkpoints: entry.checkpoints.map((row) => ({ ...row })) } : {}),
});

export const createAcpSessionIndex = ({ dataDir, fsPromises = fsp } = {}) => {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new Error('createAcpSessionIndex requires a dataDir');
  }
  const filePath = filePathFor(dataDir);
  let mutationQueue = Promise.resolve();
  const withMutation = async (fn) => {
    const previous = mutationQueue;
    let release;
    mutationQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const readRaw = async () => {
    try {
      return await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };

  const loadUntracked = async () => {
    const raw = await readRaw();
    if (raw === null) return new Map();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('ACP sessions file is not valid JSON'), { code: 'ACP_INDEX_CORRUPT' });
    }
    const store = storeSchema.safeParse(parsed);
    if (!store.success) {
      throw Object.assign(new Error('ACP sessions file failed validation'), {
        code: 'ACP_INDEX_CORRUPT',
        issues: store.error.issues,
      });
    }
    // Last entry wins on duplicate keys; a corrupt duplicate must not wedge the index.
    const map = new Map();
    for (const entry of store.data.sessions) map.set(entry.key, entry);
    return map;
  };

  const saveUntracked = async (map) => {
    const sessions = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const payload = storeSchema.parse({ version: STORE_VERSION, sessions });
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsPromises.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fsPromises.rename(tmp, filePath);
    return sessions;
  };

  return {
    filePath,

    /** One entry by key, or null. Entries are copies; mutate via `upsert`. */
    get: async (key) => withMutation(async () => {
      const map = await loadUntracked();
      const entry = map.get(key);
      return entry ? clone(entry) : null;
    }),

    /**
     * Insert or merge an entry by key. `patch` wins field-by-field over the
     * stored entry (except `key`, which must match). An explicit
     * `undefined` value clears an optional field. Returns the stored entry.
     */
    upsert: async (key, patch) => withMutation(async () => {
      if (typeof key !== 'string' || !key) {
        throw Object.assign(new Error('ACP session key must be a non-empty string'), { code: 'ACP_INDEX_INVALID' });
      }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw Object.assign(new Error('ACP session entry must be an object'), { code: 'ACP_INDEX_INVALID' });
      }
      const map = await loadUntracked();
      const previous = map.get(key) ?? {};
      const merged = { ...previous, ...patch, key };
      for (const field of Object.keys(patch)) {
        if (patch[field] === undefined) delete merged[field];
      }
      const parsed = entrySchema.safeParse(merged);
      if (!parsed.success) {
        throw Object.assign(new Error('ACP session entry failed validation'), {
          code: 'ACP_INDEX_INVALID',
          issues: parsed.error.issues,
        });
      }
      map.set(key, parsed.data);
      await saveUntracked(map);
      return clone(parsed.data);
    }),

    /** Drop one entry. Returns true when an entry was removed. */
    remove: async (key) => withMutation(async () => {
      const map = await loadUntracked();
      if (!map.delete(key)) return false;
      await saveUntracked(map);
      return true;
    }),

    /** Every entry, sorted by id (key). */
    listAll: async () => withMutation(async () => {
      const map = await loadUntracked();
      return [...map.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map(clone);
    }),

    /** Entries for one directory (platform-aware comparison key), sorted by id. */
    listByDirectory: async (cwd) => withMutation(async () => {
      const wanted = directoryKey(cwd);
      const map = await loadUntracked();
      return [...map.values()]
        .filter((entry) => { try { return directoryKey(entry.cwd) === wanted; } catch { return false; } })
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map(clone);
    }),
  };
};
