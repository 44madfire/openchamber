import { afterEach, describe, expect, test } from "bun:test"
import type { MessagePage } from "@/lib/opencode/client"
import type { Message, Part } from "@/lib/opencode/model"
import type { SyncEvent } from "@/lib/opencode/events"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { getRuntimeKey } from "@/lib/runtime-switch"
import {
  SessionMessageLoader,
  getImperativeSessionMessageLoader,
  setImperativeSessionMessageLoader,
} from "../session-message-loader"
import { getSessionPrefetch, setSessionPrefetch } from "../session-prefetch-cache"

// An ACP canonical rebuild replaces live ids with canonical ones: the batch
// leads with `message.removed` for every replaced id, then the canonical
// records. The reducer drops the visible records; the loader must retire
// everything that would resurrect them — optimistic shadows, in-flight
// reads, cached prefetch, and pagination coverage — or the removed prompt
// and assistant reappear beside their canonical replacements.

const DIRECTORY = "/repo"
const ACP_SESSION = "ses_acp-omp_r1"
const OPENCODE_SESSION = "ses_01ABc2"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

const userMessage = (sessionID: string, id: string, text: string, created = 1): Message =>
  ({ id, sessionID, role: "user", time: { created } }) as Message

const assistantMessage = (sessionID: string, id: string, created = 2): Message =>
  ({ id, sessionID, role: "assistant", time: { created } }) as Message

const textPart = (sessionID: string, messageID: string, text: string): Part =>
  ({ id: `part_${messageID}`, sessionID, messageID, type: "text", text }) as Part

const record = (message: Message, parts: Part[] = []): { info: Message; parts: Part[] } => ({ info: message, parts })

const page = (items: Array<{ info: Message; parts: Part[] }>, cursor?: string): MessagePage => ({
  items,
  cursor: cursor ? { next: cursor } : {},
})

const removedEvent = (sessionID: string, messageID: string): SyncEvent => ({
  type: "message.removed",
  properties: { sessionID, messageID },
})

const updatedEvent = (message: Message): SyncEvent => ({
  type: "message.updated",
  properties: { info: message },
})

const partsEvent = (sessionID: string, messageID: string, parts: Part[]): SyncEvent => ({
  type: "message.parts.replaced",
  properties: { sessionID, messageID, parts },
})

const createHarness = (getPage: (cursor?: string) => Promise<MessagePage>) => {
  const childStores = new ChildStoreManager()
  childStores.ensureChild(DIRECTORY, { bootstrap: false })
  const requests: Array<{ cursor?: string }> = []
  const sdk = {
    getSessionMessages: (_sessionID: string, options?: { limit?: number; cursor?: string }, _directory?: string | null) => {
      requests.push({ cursor: options?.cursor })
      return getPage(options?.cursor)
    },
  }
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: getRuntimeKey() })
  setImperativeSessionMessageLoader(loader)
  const routingIndex = createEventRoutingIndex()
  const target = { directory: DIRECTORY, sessionID: ACP_SESSION }
  return {
    childStores,
    loader,
    routingIndex,
    requests,
    emit: (event: SyncEvent) => handleEvent(DIRECTORY, event, childStores, routingIndex, getRuntimeKey()),
    messages: () => childStores.getChild(DIRECTORY)?.getState().message[target.sessionID] ?? [],
    dispose: () => {
      if (getImperativeSessionMessageLoader() === loader) setImperativeSessionMessageLoader(null)
      loader.dispose()
      childStores.disposeAll()
    },
  }
}

const CANONICAL_USER = "msg_acp-tag-t0001-00"
const CANONICAL_ASSISTANT = "msg_acp-tag-t0001-01"

type RebuildHarness = {
  loader: SessionMessageLoader
  emit: (event: SyncEvent) => void
  messages: () => Message[]
  dispose: () => void
}

/** Feeds a rebuild batch for the ACP session: removals first, then canonical records. */
const emitRebuild = (harness: Pick<RebuildHarness, "emit">, removedIDs: string[]) => {
  for (const messageID of removedIDs) {
    harness.emit(removedEvent(ACP_SESSION, messageID))
  }
  const user = userMessage(ACP_SESSION, CANONICAL_USER, "canonical prompt", 1)
  const assistant = assistantMessage(ACP_SESSION, CANONICAL_ASSISTANT, 2)
  harness.emit(updatedEvent(user))
  harness.emit(partsEvent(ACP_SESSION, user.id, [textPart(ACP_SESSION, user.id, "canonical prompt")]))
  harness.emit(updatedEvent(assistant))
  harness.emit(partsEvent(ACP_SESSION, assistant.id, [textPart(ACP_SESSION, assistant.id, "canonical reply")]))
}

describe("ACP canonical rebuild loader integration", () => {
  let harness: RebuildHarness | null = null

  afterEach(() => {
    harness?.dispose()
    harness = null
  })

  test("a rebuild retires the optimistic shadow: no resurrection on refresh", async () => {
    harness = createHarness(async () =>
      page([record(userMessage(ACP_SESSION, CANONICAL_USER, "canonical prompt", 1))]),
    )
    const target = { directory: DIRECTORY, sessionID: ACP_SESSION }
    const client = userMessage(ACP_SESSION, "msg_client", "live prompt", 1)
    harness.loader.optimisticAdd({ ...target, message: client, parts: [textPart(ACP_SESSION, client.id, "live prompt")] })
    expect(harness.messages().map((message) => message.id)).toEqual(["msg_client"])

    emitRebuild(harness, ["msg_client", "msg_acp-live-assistant"])
    expect(harness.messages().map((message) => message.id)).toEqual([CANONICAL_USER, CANONICAL_ASSISTANT])

    // A refresh after the rebuild must not resurrect the removed client id.
    await harness.loader.refreshTail(target, 10)
    expect(harness.messages().map((message) => message.id)).toEqual([CANONICAL_USER, CANONICAL_ASSISTANT])
  })

  test("a deferred initial page resolving after the rebuild is dropped", async () => {
    const pending = deferred<MessagePage>()
    harness = createHarness(() => pending.promise)
    const target = { directory: DIRECTORY, sessionID: ACP_SESSION }
    const initial = harness.loader.ensure(target)

    emitRebuild(harness, ["msg_client", "msg_acp-live-assistant"])
    pending.resolve(
      page([
        record(userMessage(ACP_SESSION, "msg_client", "live prompt", 1)),
        record(assistantMessage(ACP_SESSION, "msg_acp-live-assistant", 2)),
      ]),
    )
    await initial

    expect(harness.messages().map((message) => message.id)).toEqual([CANONICAL_USER, CANONICAL_ASSISTANT])
  })

  test("a deferred refresh page resolving after the rebuild is dropped", async () => {
    const first = deferred<MessagePage>()
    const refresh = deferred<MessagePage>()
    let calls = 0
    harness = createHarness(() => {
      calls += 1
      return calls === 1 ? first.promise : refresh.promise
    })
    const target = { directory: DIRECTORY, sessionID: ACP_SESSION }
    const initial = harness.loader.ensure(target)
    first.resolve(
      page([
        record(userMessage(ACP_SESSION, "msg_client", "live prompt", 1)),
        record(assistantMessage(ACP_SESSION, "msg_acp-live-assistant", 2)),
      ]),
    )
    await initial
    expect(harness.messages().map((message) => message.id)).toEqual(["msg_client", "msg_acp-live-assistant"])

    const refreshing = harness.loader.refreshTail(target, 10)
    emitRebuild(harness, ["msg_client", "msg_acp-live-assistant"])
    refresh.resolve(
      page([
        record(userMessage(ACP_SESSION, "msg_client", "live prompt", 1)),
        record(assistantMessage(ACP_SESSION, "msg_acp-live-assistant", 2)),
      ]),
    )
    await refreshing

    expect(harness.messages().map((message) => message.id)).toEqual([CANONICAL_USER, CANONICAL_ASSISTANT])
  })

  test("a deferred older page resolving after the rebuild is dropped and coverage resets", async () => {
    const first = deferred<MessagePage>()
    const older = deferred<MessagePage>()
    let calls = 0
    harness = createHarness(() => {
      calls += 1
      return calls === 1 ? first.promise : older.promise
    })
    const target = { directory: DIRECTORY, sessionID: ACP_SESSION }
    const initial = harness.loader.ensure(target)
    // Ten user turns satisfy the cold-navigation window immediately, keeping
    // the cursor for the older-page leg below.
    first.resolve(
      page(
        Array.from({ length: 10 }, (_, index) =>
          record(userMessage(ACP_SESSION, `msg_client-${index}`, "live prompt", 3 + index)),
        ),
        "msg_older-cursor",
      ),
    )
    await initial
    expect(harness.loader.getSnapshot(target)).toMatchObject({ cursor: "msg_older-cursor", complete: false })

    const loadingOlder = harness.loader.loadOlder(target)
    const liveIDs = Array.from({ length: 10 }, (_, index) => `msg_client-${index}`)
    emitRebuild(harness, liveIDs)
    // The pre-removal cursor is gone: coverage resets to a fresh window.
    expect(harness.loader.getSnapshot(target)).toMatchObject({ cursor: undefined, complete: false, resolved: false })
    older.resolve(page([record(userMessage(ACP_SESSION, "msg_older", "older", 1))], "msg_even-older"))
    await loadingOlder

    expect(harness.messages().map((message) => message.id)).toEqual([CANONICAL_USER, CANONICAL_ASSISTANT])
    expect(harness.loader.getSnapshot(target)).toMatchObject({ cursor: undefined, complete: false })
  })

  test("a cached prefetch does not survive a rebuild", async () => {
    harness = createHarness(async () => page([]))
    setSessionPrefetch({ directory: DIRECTORY, sessionID: ACP_SESSION, limit: 10, cursor: "msg_client", complete: false })
    expect(getSessionPrefetch(DIRECTORY, ACP_SESSION)).toBeDefined()

    emitRebuild(harness, ["msg_client"])

    expect(getSessionPrefetch(DIRECTORY, ACP_SESSION)).toBeUndefined()
  })

  test("unrelated optimistic shadows survive a rebuild and merge into the fresh window", async () => {
    harness = createHarness(async () =>
      page([record(userMessage(ACP_SESSION, CANONICAL_USER, "canonical prompt", 1))]),
    )
    const target = { directory: DIRECTORY, sessionID: ACP_SESSION }
    harness.loader.optimisticAdd({
      ...target,
      message: userMessage(ACP_SESSION, "msg_client", "live prompt", 1),
      parts: [textPart(ACP_SESSION, "msg_client", "live prompt")],
    })
    harness.loader.optimisticAdd({
      ...target,
      message: userMessage(ACP_SESSION, "msg_other", "concurrent prompt", 5),
      parts: [textPart(ACP_SESSION, "msg_other", "concurrent prompt")],
    })

    emitRebuild(harness, ["msg_client"])
    await harness.loader.refreshTail(target, 10)

    // The removed shadow is gone; the concurrent prompt merges by identity.
    expect(harness.messages().map((message) => message.id)).toEqual([CANONICAL_USER, CANONICAL_ASSISTANT, "msg_other"])
  })

  test("removals on OpenCode sessions leave the loader untouched", async () => {
    const pending = deferred<MessagePage>()
    const childStores = new ChildStoreManager()
    childStores.ensureChild(DIRECTORY, { bootstrap: false })
    const sdk = {
      getSessionMessages: () => pending.promise,
    }
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: getRuntimeKey() })
    setImperativeSessionMessageLoader(loader)
    const routingIndex = createEventRoutingIndex()
    const target = { directory: DIRECTORY, sessionID: OPENCODE_SESSION }
    try {
      const loading = loader.ensure(target)
      loader.optimisticAdd({
        ...target,
        message: userMessage(OPENCODE_SESSION, "msg_native", "native prompt", 1),
        parts: [textPart(OPENCODE_SESSION, "msg_native", "native prompt")],
      })
      setSessionPrefetch({ directory: DIRECTORY, sessionID: OPENCODE_SESSION, limit: 10, complete: false })
      const generation = loader.getSnapshot(target).generation

      handleEvent(DIRECTORY, removedEvent(OPENCODE_SESSION, "msg_native"), childStores, routingIndex, getRuntimeKey())

      // No loader interaction: same generation, shadow and prefetch intact.
      expect(loader.getSnapshot(target).generation).toBe(generation)
      expect(getSessionPrefetch(DIRECTORY, OPENCODE_SESSION)).toBeDefined()
      pending.resolve(page([record(userMessage(OPENCODE_SESSION, "msg_native", "native prompt", 1))]))
      await loading
      expect(childStores.getChild(DIRECTORY)?.getState().message[OPENCODE_SESSION].map((message) => message.id)).toEqual([
        "msg_native",
      ])
    } finally {
      if (getImperativeSessionMessageLoader() === loader) setImperativeSessionMessageLoader(null)
      loader.dispose()
      childStores.disposeAll()
    }
  })
})
