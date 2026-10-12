/**
 * Slash commands of ACP sessions: the agent's `available_commands`, cached
 * per session key. Unlike OpenCode commands (directory-scoped, config-backed),
 * ACP commands belong to one session and arrive over the agent connection;
 * the server caches them on `available_commands_update` and announces changes
 * with `catalog.updated{kind:'command'}`.
 *
 * Not persisted: a cold session re-reports its commands on `session/load`.
 * `catalogRefresh` invalidates through `invalidateAcpCommands` on the command
 * kind (shared with the OpenCode commands refresh).
 */

import { create } from "zustand"

import { acpClient, type AcpCommandInfo } from "@/lib/acp/client"

type AcpCommandsState = {
  /** Session key → last fetched commands. Absent means never fetched. */
  commandsBySession: Record<string, AcpCommandInfo[]>
  loadCommands: (sessionKey: string, directory?: string | null) => Promise<AcpCommandInfo[]>
  invalidateSession: (sessionKey: string) => void
  resetForRuntimeSwitch: () => void
}

// Request identity per session: only the newest request may publish. Both
// invalidation and runtime reset bump the generation, so a late response from
// an older runtime or catalog can neither repopulate the cache nor overwrite
// a newer fetch; clearing loadInFlight alone could not stop that.
const requestGeneration = new Map<string, number>()

const loadInFlight = new Map<string, Promise<AcpCommandInfo[]>>()

const bumpKey = (sessionKey: string): void => {
  requestGeneration.set(sessionKey, (requestGeneration.get(sessionKey) ?? 0) + 1)
}

const bumpAll = (): void => {
  for (const key of requestGeneration.keys()) bumpKey(key)
}

export const invalidateAcpCommands = (sessionKey?: string): void => {
  if (sessionKey) {
    bumpKey(sessionKey)
    loadInFlight.delete(sessionKey)
    useAcpCommandsStore.setState((state) => {
      if (!(sessionKey in state.commandsBySession)) return state
      const next = { ...state.commandsBySession }
      delete next[sessionKey]
      return { commandsBySession: next }
    })
    return
  }
  bumpAll()
  loadInFlight.clear()
  useAcpCommandsStore.setState({ commandsBySession: {} })
}

export const useAcpCommandsStore = create<AcpCommandsState>()((set, get) => ({
  commandsBySession: {},

  loadCommands: async (sessionKey, directory) => {
    const cached = get().commandsBySession[sessionKey]
    if (cached) return cached
    const inFlight = loadInFlight.get(sessionKey)
    if (inFlight) return inFlight
    const generation = (requestGeneration.get(sessionKey) ?? 0) + 1
    requestGeneration.set(sessionKey, generation)
    const request = acpClient
      .getSessionCommands(sessionKey, directory)
      .then((commands) => {
        if (requestGeneration.get(sessionKey) !== generation) return commands
        set((state) => ({ commandsBySession: { ...state.commandsBySession, [sessionKey]: commands } }))
        return commands
      })
      .catch(() => [] as AcpCommandInfo[])
      .finally(() => {
        if (loadInFlight.get(sessionKey) === request) loadInFlight.delete(sessionKey)
      })
    loadInFlight.set(sessionKey, request)
    return request
  },

  invalidateSession: (sessionKey) => invalidateAcpCommands(sessionKey),

  resetForRuntimeSwitch: () => {
    bumpAll()
    loadInFlight.clear()
    set({ commandsBySession: {} })
  },
}))

const EMPTY_COMMANDS: AcpCommandInfo[] = []

export const selectAcpCommandsForSession = (
  state: Pick<AcpCommandsState, "commandsBySession">,
  sessionKey: string | null | undefined,
): AcpCommandInfo[] => {
  if (!sessionKey) return EMPTY_COMMANDS
  return state.commandsBySession[sessionKey] ?? EMPTY_COMMANDS
}
