import { normalizePath } from "@/lib/pathNormalization"
import { getRuntimeKey, isTransientRuntimeKey } from "@/lib/runtime-switch"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"

// The ACP backend the new-session picker last offered — per project directory,
// falling back to the last one picked anywhere — so a new draft reopens on the
// agent the user last chose instead of always resetting to OpenCode. A stored
// `null` is an explicit OpenCode pick, not an absence, and wins the same way.
// This is a convenience default ONLY: callers must still confirm the backend
// is usable (listed, enabled, not erroring) before offering it.
//
// Backend IDs and project directories belong to the connected runtime (ACP
// requests go through runtimeFetch), so every entry is namespaced by runtime
// key: two endpoints can expose the same backend ID for different registry
// entries and the same directory string for unrelated projects.
const STORAGE_KEY = "oc.draftBackend.v1"
const MAX_RUNTIME_ENTRIES = 8
const MAX_DIRECTORY_ENTRIES = 50

type PersistedEntry = {
  backendId: string | null
  updatedAt: number
}

type RuntimePreferences = {
  global: PersistedEntry | null
  byDirectory: Record<string, PersistedEntry>
}

type PersistedEnvelope = {
  version: 1
  runtimes: Record<string, RuntimePreferences>
}

const emptyPreferences = (): RuntimePreferences => ({ global: null, byDirectory: {} })
const emptyEnvelope = (): PersistedEnvelope => ({ version: 1, runtimes: {} })

const readEntry = (value: unknown): PersistedEntry | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const { backendId, updatedAt } = value as { backendId?: unknown; updatedAt?: unknown }
  if (backendId !== null && (typeof backendId !== "string" || backendId.length === 0)) return null
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null
  return { backendId, updatedAt }
}

const readDirectoryEntries = (value: unknown): Record<string, PersistedEntry> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const byDirectory: Record<string, PersistedEntry> = {}
  for (const [directory, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!directory) continue
    const clean = readEntry(entry)
    if (clean) byDirectory[directory] = clean
  }
  return byDirectory
}

const readPreferences = (value: unknown): RuntimePreferences | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const { global, byDirectory } = value as { global?: unknown; byDirectory?: unknown }
  const directories = readDirectoryEntries(byDirectory)
  if (!directories) return null
  // `global` is optional (older/partial writes); a present-but-malformed one
  // reads as absent so one bad entry cannot poison the directory map.
  const fallback = global === undefined ? null : readEntry(global)
  if (global !== undefined && global !== null && fallback === null) return { global: null, byDirectory: directories }
  return { global: fallback, byDirectory: directories }
}

const readEnvelope = (storage: Storage): PersistedEnvelope => {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyEnvelope()
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>
    if (parsed.version !== 1) return emptyEnvelope()
    if (typeof parsed.runtimes !== "object" || parsed.runtimes === null || Array.isArray(parsed.runtimes)) return emptyEnvelope()
    const runtimes: Record<string, RuntimePreferences> = {}
    for (const [runtimeKey, preferences] of Object.entries(parsed.runtimes as Record<string, unknown>)) {
      if (!runtimeKey) continue
      const clean = readPreferences(preferences)
      if (clean) runtimes[runtimeKey] = clean
    }
    return { version: 1, runtimes }
  } catch {
    // Malformed persisted data is a read failure, not empty success — but for
    // a pure convenience default the correct recovery is the same: fall back
    // to OpenCode.
    return emptyEnvelope()
  }
}

const newestTimestamp = (preferences: RuntimePreferences): number => {
  let newest = preferences.global?.updatedAt ?? 0
  for (const entry of Object.values(preferences.byDirectory)) {
    newest = Math.max(newest, entry.updatedAt)
  }
  return newest
}

const writeEnvelope = (storage: Storage, envelope: PersistedEnvelope): void => {
  const retainedRuntimes = Object.entries(envelope.runtimes)
    .sort(([, left], [, right]) => newestTimestamp(right) - newestTimestamp(left))
    .slice(0, MAX_RUNTIME_ENTRIES)
  const runtimes: Record<string, RuntimePreferences> = {}
  for (const [runtimeKey, preferences] of retainedRuntimes) {
    const retainedDirectories = Object.entries(preferences.byDirectory)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_DIRECTORY_ENTRIES)
    runtimes[runtimeKey] = { global: preferences.global, byDirectory: Object.fromEntries(retainedDirectories) }
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, runtimes }))
  } catch {
    // Best-effort default — a full/blocked storage must never break the picker.
  }
}

/**
 * Records a backend picked in the new-session picker on `runtimeKey`: for
 * `directory` when it names one (a chat draft has none), and always as the
 * last pick anywhere on that runtime. `null` records an explicit OpenCode
 * pick. Transient keys (no instance connected) are never persisted: nothing
 * is remembered there, and reads under them always miss.
 */
export function rememberDraftBackend(
  runtimeKey: string,
  directory: string | null | undefined,
  backendId: string | null,
  storage: Storage = getDeferredSafeStorage(),
): void {
  if (!runtimeKey || isTransientRuntimeKey(runtimeKey)) return
  const cleanBackendId = typeof backendId === "string" && backendId.length > 0 ? backendId : null
  const envelope = readEnvelope(storage)
  const preferences = envelope.runtimes[runtimeKey] ?? emptyPreferences()
  // Monotonic vs every stored entry: same-millisecond writes must not tie,
  // or retention trimming would evict an arbitrary runtime or directory.
  const newestStored = Object.values(envelope.runtimes).reduce((max, existing) => Math.max(max, newestTimestamp(existing)), 0)
  const entry: PersistedEntry = { backendId: cleanBackendId, updatedAt: Math.max(Date.now(), newestStored + 1) }
  preferences.global = entry
  const key = normalizePath(directory ?? null)
  if (key) preferences.byDirectory[key] = entry
  envelope.runtimes[runtimeKey] = preferences
  writeEnvelope(storage, envelope)
}

/**
 * The backend a new draft in `directory` on `runtimeKey` should default to:
 * the one last picked there, else the one last picked anywhere on that
 * runtime, else OpenCode (`null`). Defaults to the current runtime.
 */
export function resolveDraftBackend(
  directory: string | null | undefined,
  runtimeKey: string = getRuntimeKey(),
  storage: Storage = getDeferredSafeStorage(),
): string | null {
  if (!runtimeKey || isTransientRuntimeKey(runtimeKey)) return null
  const preferences = readEnvelope(storage).runtimes[runtimeKey]
  if (!preferences) return null
  const key = normalizePath(directory ?? null)
  if (key) {
    const entry = preferences.byDirectory[key]
    if (entry) return entry.backendId
  }
  return preferences.global?.backendId ?? null
}
