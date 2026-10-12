/**
 * Backend registry: the configured ACP agents, persisted as
 * `<dataDir>/acp-backends.json`. Same shape as `remote-clients.json` /
 * `environment.json`: a versioned file, read and written atomically so a
 * crash never leaves half a registry behind.
 *
 * On first read, when no file exists, the three known agents are seeded —
 * but only the ones whose command resolves on PATH, so a fresh machine
 * shows exactly the agents it can actually run.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { findExecutableOnPath } from '../../tunnels/executable-search.js';
import { BACKEND_ID_PATTERN } from './session-key.js';

export const ACP_BACKENDS_FILE = 'acp-backends.json';
const STORE_VERSION = 1;

const backendIdSchema = z.string().regex(BACKEND_ID_PATTERN);

export const acpBackendEntrySchema = z.strictObject({
  id: backendIdSchema,
  label: z.string().min(1).max(80),
  command: z.string().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(64).default([]),
  env: z.record(z.string().max(256), z.string().max(32_000)).optional(),
  enabled: z.boolean().default(true),
  helper: z.strictObject({
    config: z.record(z.string().max(256), z.string().max(4096)),
  }).optional(),
  cache: z.strictObject({
    configOptions: z.array(z.unknown()),
    at: z.string().datetime({ offset: true }),
  }).optional(),
});

const storeSchema = z.strictObject({
  version: z.literal(STORE_VERSION),
  backends: z.array(acpBackendEntrySchema),
});

/**
 * @typedef {z.infer<typeof acpBackendEntrySchema>} AcpBackendEntry
 */

const DEFAULT_BACKENDS = [
  // In M1 the OpenCode HTTP path is still the default; `opencode acp`
  // becomes usable in M2, so it seeds disabled.
  { id: 'opencode', label: 'opencode', command: 'opencode', args: ['acp'], enabled: false },
  { id: 'omp', label: 'omp', command: 'omp', args: ['acp'], enabled: true },
  { id: 'pi-acp', label: 'pi-acp', command: 'pi-acp', args: [], enabled: true },
];

const seedBackends = ({ resolveCommand } = {}) => {
  const resolve = typeof resolveCommand === 'function'
    ? resolveCommand
    : (command) => findExecutableOnPath(command, { fsLike: fs });
  return DEFAULT_BACKENDS.filter((entry) => {
    try {
      return resolve(entry.command) !== null;
    } catch {
      return false;
    }
  }).map((entry) => ({ ...entry, args: [...entry.args] }));
};

const filePathFor = (dataDir) => path.join(dataDir, ACP_BACKENDS_FILE);

export const createAcpBackendRegistry = ({
  dataDir,
  fsPromises = fsp,
  resolveCommand,
} = {}) => {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new Error('createAcpBackendRegistry requires a dataDir');
  }
  const filePath = filePathFor(dataDir);
  // Serialize mutations so concurrent PUTs cannot interleave read/save.
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

  const saveUntracked = async (backends) => {
    const payload = storeSchema.parse({ version: STORE_VERSION, backends });
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsPromises.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fsPromises.rename(tmp, filePath);
    return payload.backends;
  };

  /** List entries, seeding defaults on first use when no file exists yet. */
  const list = async () => withMutation(async () => {
    const raw = await readRaw();
    if (raw === null) {
      return saveUntracked(seedBackends({ resolveCommand }));
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('ACP backends file is not valid JSON'), { code: 'ACP_REGISTRY_CORRUPT' });
    }
    const store = storeSchema.safeParse(parsed);
    if (!store.success) {
      throw Object.assign(new Error('ACP backends file failed validation'), {
        code: 'ACP_REGISTRY_CORRUPT',
        issues: store.error.issues,
      });
    }
    return store.data.backends;
  });

  /**
   * Replace the whole registry. Every entry is validated; unknown ids are
   * fine (users add their own agents), but ids must stay unique and
   * well-formed because session keys embed them.
   */
  const save = async (backends) => withMutation(async () => {
    if (!Array.isArray(backends)) {
      throw Object.assign(new Error('ACP backends must be an array'), { code: 'ACP_REGISTRY_INVALID' });
    }
    const seen = new Set();
    for (const entry of backends) {
      if (entry && typeof entry.id === 'string') {
        if (seen.has(entry.id)) {
          throw Object.assign(new Error(`Duplicate ACP backend id: ${entry.id}`), { code: 'ACP_REGISTRY_INVALID' });
        }
        seen.add(entry.id);
      }
    }
    try {
      return await saveUntracked(backends);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw Object.assign(new Error('ACP backends failed validation'), {
          code: 'ACP_REGISTRY_INVALID',
          issues: error.issues,
        });
      }
      throw error;
    }
  });

  const get = async (id) => {
    const entries = await list();
    return entries.find((entry) => entry.id === id) ?? null;
  };

  return { list, save, get, filePath };
};
