import { normalizePath } from "@/lib/pathNormalization"
import { getDeferredSafeStorage } from "@/stores/utils/safeStorage"

// The ACP backend the new-session picker last offered — per project directory,
// falling back to the last one picked anywhere — so a new draft reopens on the
// agent the user last chose instead of always resetting to OpenCode. A stored
// `null` is an explicit OpenCode pick, not an absence, and wins the same way.
// This is a convenience default ONLY: callers must still confirm the backend
// is usable (listed, enabled, not erroring) before offering it.
const STORAGE_KEY = "oc.draftBackend.v1"
const MAX_DIRECTORY_ENTRIES = 50

type PersistedEntry = {
  backendId: string | null
  updatedAt: number
}

type PersistedEnvelope = {
  version: 1
  global: PersistedEntry | null
  byDirectory: Record<string, PersistedEntry>
}

const emptyEnvelope = (): PersistedEnvelope => ({ version: 1, global: null, byDirectory: {} })

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

const readEnvelope = (storage: Storage): PersistedEnvelope => {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyEnvelope()
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>
    if (parsed.version !== 1) return emptyEnvelope()
    const byDirectory = readDirectoryEntries(parsed.byDirectory)
    if (!byDirectory) return emptyEnvelope()
    return { version: 1, global: readEntry(parsed.global), byDirectory }
  } catch {
    // Malformed persisted data is a read failure, not empty success — but for
    // a pure convenience default the correct recovery is the same: fall back
    // to OpenCode.
    return emptyEnvelope()
  }
}

const writeEnvelope = (storage: Storage, envelope: PersistedEnvelope): void => {
  const retained = Object.entries(envelope.byDirectory)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_DIRECTORY_ENTRIES)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...envelope, byDirectory: Object.fromEntries(retained) }))
  } catch {
    // Best-effort default — a full/blocked storage must never break the picker.
  }
}

const newestTimestamp = (envelope: PersistedEnvelope): number => {
  let newest = envelope.global?.updatedAt ?? 0
  for (const entry of Object.values(envelope.byDirectory)) {
    newest = Math.max(newest, entry.updatedAt)
  }
  return newest
}

/**
 * Records a backend picked in the new-session picker: for `directory` when it
 * names one (a chat draft has none), and always as the last pick anywhere.
 * `null` records an explicit OpenCode pick.
 */
export function rememberDraftBackend(
  directory: string | null | undefined,
  backendId: string | null,
  storage: Storage = getDeferredSafeStorage(),
): void {
  const cleanBackendId = typeof backendId === "string" && backendId.length > 0 ? backendId : null
  const envelope = readEnvelope(storage)
  // Monotonic vs the stored entries: same-millisecond writes must not tie,
  // or retention trimming would evict an arbitrary directory.
  const entry: PersistedEntry = { backendId: cleanBackendId, updatedAt: Math.max(Date.now(), newestTimestamp(envelope) + 1) }
  envelope.global = entry
  const key = normalizePath(directory ?? null)
  if (key) envelope.byDirectory[key] = entry
  writeEnvelope(storage, envelope)
}

/**
 * The backend a new draft in `directory` should default to: the one last
 * picked there, else the one last picked anywhere, else OpenCode (`null`).
 */
export function resolveDraftBackend(
  directory: string | null | undefined,
  storage: Storage = getDeferredSafeStorage(),
): string | null {
  const envelope = readEnvelope(storage)
  const key = normalizePath(directory ?? null)
  if (key) {
    const entry = envelope.byDirectory[key]
    if (entry) return entry.backendId
  }
  return envelope.global?.backendId ?? null
}
