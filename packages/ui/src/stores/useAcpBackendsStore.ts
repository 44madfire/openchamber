/**
 * ACP backend registry UI state: the live statuses `GET /api/acp/backends`
 * reports, the selected backend for the detail editor, and the registry
 * writes (PUT whole registry after add/remove/edit/enable).
 *
 * Not persisted: the server owns the registry file; the store is a cache
 * that refreshes on page mount and after every mutation. Runtime-scoped:
 * every async read/mutation captures the runtime key and discards results
 * that land after an endpoint switch, and `resetForRuntimeSwitch` drops the
 * cached registry, the editor selection, and in-flight bookkeeping so
 * runtime A's backends (and secrets) can never render on — or PUT to — B.
 */

import { create } from "zustand"

import { AcpApiError, acpClient, type AcpBackendEntry, type AcpBackendStatus } from "@/lib/acp/client"
import { getRuntimeKey } from "@/lib/runtime-switch"

type AcpBackendsState = {
  /** Last fetched statuses, in registry order. Null means never fetched. */
  backends: AcpBackendStatus[] | null
  /** Load error of the last fetch, cleared on the next attempt. */
  loadError: string | null
  loading: boolean
  /** Selected backend id for the detail editor; null shows the grid. */
  selectedId: string | null
  /** True when the detail editor creates a new entry rather than editing. */
  creating: boolean
  load: () => Promise<void>
  select: (id: string | null, creating?: boolean) => void
  /** Replace the registry and refresh statuses from the response. */
  save: (entries: AcpBackendEntry[]) => Promise<AcpBackendStatus[]>
  restart: (id: string) => Promise<AcpBackendStatus>
  authenticate: (id: string, methodId: string) => Promise<AcpBackendStatus>
  /** Drops the cached registry, editor selection, and in-flight reads. */
  resetForRuntimeSwitch: () => void
}

let loadInFlight: Promise<void> | null = null
/** Bumped on every reset so late responses publish nothing. */
let storeGeneration = 0
export const useAcpBackendsStore = create<AcpBackendsState>()((set, get) => ({
  backends: null,
  loadError: null,
  loading: false,
  selectedId: null,
  creating: false,

  load: async () => {
    if (loadInFlight) return loadInFlight
    const generation = storeGeneration
    const runtimeKey = getRuntimeKey()
    const request = (async () => {
      set({ loading: true, loadError: null })
      try {
        const backends = await acpClient.listBackends()
        if (storeGeneration !== generation || getRuntimeKey() !== runtimeKey) return
        set({ backends })
      } catch (error) {
        if (storeGeneration !== generation || getRuntimeKey() !== runtimeKey) return
        set({
          loadError: error instanceof AcpApiError
            ? `${error.message} (HTTP ${error.status})`
            : error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (storeGeneration === generation && getRuntimeKey() === runtimeKey) set({ loading: false })
      }
    })()
    loadInFlight = request
    try {
      await request
    } finally {
      if (loadInFlight === request) loadInFlight = null
    }
  },

  select: (id, creating = false) => set({ selectedId: id, creating }),

  save: async (entries) => {
    const generation = storeGeneration
    const runtimeKey = getRuntimeKey()
    const backends = await acpClient.saveBackends(entries)
    if (storeGeneration !== generation || getRuntimeKey() !== runtimeKey) {
      throw new Error("Runtime changed during backend save")
    }
    set({ backends })
    // A removed backend drops the selection back to the grid.
    const { selectedId } = get()
    if (selectedId && !backends.some((backend) => backend.id === selectedId)) {
      set({ selectedId: null, creating: false })
    }
    return backends
  },

  restart: async (id) => {
    const generation = storeGeneration
    const runtimeKey = getRuntimeKey()
    const backend = await acpClient.restartBackend(id)
    if (storeGeneration !== generation || getRuntimeKey() !== runtimeKey) {
      throw new Error("Runtime changed during backend restart")
    }
    // Restart/authenticate answer a raw status snapshot without the registry
    // `entry` the list routes attach: merge over the held record so the
    // detail editor keeps its form source.
    const merged = { ...selectAcpBackend(get(), id), ...backend, entry: selectAcpBackend(get(), id)?.entry } as AcpBackendStatus
    set((state) => ({
      backends: (state.backends ?? []).map((entry) => (entry.id === id ? merged : entry)),
    }))
    return merged
  },

  authenticate: async (id, methodId) => {
    const generation = storeGeneration
    const runtimeKey = getRuntimeKey()
    const backend = await acpClient.authenticateBackend(id, methodId)
    if (storeGeneration !== generation || getRuntimeKey() !== runtimeKey) {
      throw new Error("Runtime changed during backend authentication")
    }
    const merged = { ...selectAcpBackend(get(), id), ...backend, entry: selectAcpBackend(get(), id)?.entry } as AcpBackendStatus
    set((state) => ({
      backends: (state.backends ?? []).map((entry) => (entry.id === id ? merged : entry)),
    }))
    return merged
  },

  resetForRuntimeSwitch: () => {
    storeGeneration += 1
    loadInFlight = null
    set({ backends: null, loadError: null, loading: false, selectedId: null, creating: false })
  },
}))

export const selectAcpBackend = (
  state: Pick<AcpBackendsState, "backends">,
  id: string | null | undefined,
): AcpBackendStatus | null => (id ? state.backends?.find((backend) => backend.id === id) ?? null : null)
