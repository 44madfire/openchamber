import { beforeEach, describe, expect, mock, test } from "bun:test"

// The store is cache-only: mock the ACP client and assert fetch-once,
// invalidation, and failure semantics.

type CommandList = Array<{ name: string; description?: string }>
const commandLists: Array<CommandList | Promise<CommandList> | Error> = []
const fetchCalls: string[] = []

mock.module("@/lib/acp/client", () => ({
  acpClient: {
    getSessionCommands: mock(async (key: string) => {
      fetchCalls.push(key)
      const next = await commandLists.shift()
      if (next instanceof Error) throw next
      return next ?? []
    }),
  },
}))

// mock.module installs above must take effect before this module loads, so the import stays dynamic.
const { invalidateAcpCommands, selectAcpCommandsForSession, useAcpCommandsStore } = await import("./useAcpCommandsStore")

beforeEach(() => {
  commandLists.length = 0
  fetchCalls.length = 0
  useAcpCommandsStore.setState({ commandsBySession: {} })
})

describe("useAcpCommandsStore", () => {
  test("fetches once per session and serves the cache after", async () => {
    commandLists.push([{ name: "compact", description: "Compact" }])
    const first = await useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r1", "/repo")
    expect(first).toEqual([{ name: "compact", description: "Compact" }])
    expect(fetchCalls).toEqual(["ses_acp-omp_r1"])
    const second = await useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r1", "/repo")
    expect(second).toBe(first)
    expect(fetchCalls).toHaveLength(1)
    expect(selectAcpCommandsForSession(useAcpCommandsStore.getState(), "ses_acp-omp_r1")).toBe(first)
  })

  test("a failed fetch resolves empty without caching", async () => {
    commandLists.push(new Error("down"))
    expect(await useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r1")).toEqual([])
    expect(selectAcpCommandsForSession(useAcpCommandsStore.getState(), "ses_acp-omp_r1")).toEqual([])
    commandLists.push([{ name: "compact" }])
    expect(await useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r1")).toEqual([{ name: "compact" }])
    expect(fetchCalls).toHaveLength(2)
  })

  test("invalidateAcpCommands drops one session or everything", async () => {
    commandLists.push([{ name: "a" }], [{ name: "b" }])
    await useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r1")
    await useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r2")
    invalidateAcpCommands("ses_acp-omp_r1")
    expect(selectAcpCommandsForSession(useAcpCommandsStore.getState(), "ses_acp-omp_r1")).toEqual([])
    expect(selectAcpCommandsForSession(useAcpCommandsStore.getState(), "ses_acp-omp_r2")).toEqual([{ name: "b" }])
    invalidateAcpCommands()
    expect(selectAcpCommandsForSession(useAcpCommandsStore.getState(), "ses_acp-omp_r2")).toEqual([])
  })

  test("a late old-runtime response cannot repopulate after a runtime reset", async () => {
    let releaseOld!: (value: CommandList) => void
    commandLists.push(
      new Promise<CommandList>((resolve) => {
        releaseOld = resolve
      }),
    )
    const pending = useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r1")
    useAcpCommandsStore.getState().resetForRuntimeSwitch()
    releaseOld([{ name: "old-runtime" }])
    await pending
    expect(selectAcpCommandsForSession(useAcpCommandsStore.getState(), "ses_acp-omp_r1")).toEqual([])
  })

  test("invalidation during a fetch drops the stale response", async () => {
    let releaseStale!: (value: CommandList) => void
    commandLists.push(
      new Promise<CommandList>((resolve) => {
        releaseStale = resolve
      }),
    )
    const pending = useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r2")
    invalidateAcpCommands("ses_acp-omp_r2")
    releaseStale([{ name: "old-catalog" }])
    await pending
    expect(selectAcpCommandsForSession(useAcpCommandsStore.getState(), "ses_acp-omp_r2")).toEqual([])
  })

  test("an older fetch cannot overwrite a newer catalog fetch", async () => {
    const releases: Array<(value: CommandList) => void> = []
    const gate = () =>
      new Promise<CommandList>((resolve) => {
        releases.push(resolve)
      })
    commandLists.push(gate())
    const first = useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r3")
    invalidateAcpCommands("ses_acp-omp_r3")
    commandLists.push(gate())
    const second = useAcpCommandsStore.getState().loadCommands("ses_acp-omp_r3")
    releases[0]([{ name: "stale" }])
    await first
    releases[1]([{ name: "fresh" }])
    expect(await second).toEqual([{ name: "fresh" }])
    expect(selectAcpCommandsForSession(useAcpCommandsStore.getState(), "ses_acp-omp_r3")).toEqual([{ name: "fresh" }])
  })
})
