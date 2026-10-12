import { beforeEach, describe, expect, mock, test } from "bun:test"

// The generated `@opencode/client` runs for real here; only the runtime
// transport (`runtimeFetch`) and runtime identity are replaced. That keeps
// request fidelity (paths, query, headers, bodies) under test rather than
// whatever a hand-written SDK stub would accept. ACP ids must reach the ACP
// routes and never the OpenCode SDK, and vice versa.

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type CapturedRequest = {
  url: URL
  method: string
  headers: Headers
  body: unknown
}

const requests: CapturedRequest[] = []
const responses: Array<Response | Error | ((request: CapturedRequest) => Response | Error | Promise<Response | Error>)> = []
let runtimeKey = "test-runtime"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const runtimeFetchMock = mock<RuntimeFetch>(async (input, init) => {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url, "http://runtime.test")
  const request: CapturedRequest = {
    url,
    method: String(init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  }
  requests.push(request)
  const next = responses.shift()
  const resolved = typeof next === "function" ? await next(request) : next
  if (resolved instanceof Error) throw resolved
  return resolved ?? json({})
})

mock.module("@/contexts/runtimeAPIRegistry", () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}))

mock.module("@/lib/runtime-url", () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: () => "http://runtime.test/api",
  })),
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeApiBaseUrl: mock(() => ""),
  getRuntimeKey: mock(() => runtimeKey),
}))

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: runtimeFetchMock,
}))

mock.module("@/lib/startupTrace", () => ({
  markStartupTrace: mock(() => undefined),
}))

// mock.module installs above must take effect before this module loads, so the import stays dynamic.
const { opencodeClient } = await import("./client")
const { AcpApiError, AcpUnsupportedError } = await import("@/lib/acp/client")

const ACP_ID = "ses_acp-omp_r1"
const OPENCODE_ID = "ses_01ABc2"

const acpSession = {
  id: ACP_ID,
  projectID: "proj_1",
  directory: "/repo/app",
  title: "ACP",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: { acp: { backendId: "omp", configOptions: [{ id: "model" }, { id: "mode" }] } },
}

const openCodeSessionInfo = {
  id: OPENCODE_ID,
  projectID: "proj_1",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "First",
  location: { directory: "/repo/app" },
}

const acpPathnames = () => requests.map((request) => request.url.pathname).filter((pathname) => pathname.startsWith("/api/acp/"))
const sdkPathnames = () => requests.map((request) => request.url.pathname).filter((pathname) => !pathname.startsWith("/api/acp/"))

beforeEach(() => {
  requests.length = 0
  responses.length = 0
  runtimeKey = "test-runtime"
  opencodeClient.setDirectory(undefined)
  opencodeClient.clearConfigCache()
})

describe("OpencodeService ACP routing", () => {
  test("getSession sends ACP ids to the ACP route, OpenCode ids to the SDK", async () => {
    responses.push(json({ session: acpSession }))
    expect((await opencodeClient.getSession(ACP_ID, "/repo/app")).id).toBe(ACP_ID)
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}`)

    responses.push(json({ data: openCodeSessionInfo }))
    expect((await opencodeClient.getSession(OPENCODE_ID, "/repo/app")).id).toBe(OPENCODE_ID)
  })

  test("deleteSession and renameSession route by id shape", async () => {
    responses.push(json({ deleted: true }))
    expect(await opencodeClient.deleteSession(ACP_ID, "/repo/app")).toBe(true)
    expect(requests[0].method).toBe("DELETE")
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}`)

    responses.push(json({ session: { ...acpSession, title: "New" } }))
    await opencodeClient.renameSession(ACP_ID, "New", "/repo/app")
    expect(requests[1].method).toBe("PATCH")
    expect(requests[1].body).toEqual({ title: "New" })

    responses.push(new Response(null, { status: 204 }))
    await opencodeClient.renameSession(OPENCODE_ID, "New", "/repo/app")
    expect(sdkPathnames()).toHaveLength(1)
  })

  test("getSessionMessages routes by id and passes the cursor as `before`", async () => {
    responses.push(json({ items: [], cursor: {} }))
    await opencodeClient.getSessionMessages(ACP_ID, { limit: 50, cursor: "msg_9" }, "/repo/app")
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}/message`)
    expect(requests[0].url.searchParams.get("limit")).toBe("50")
    expect(requests[0].url.searchParams.get("before")).toBe("msg_9")

    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.getSessionMessages(OPENCODE_ID, { limit: 50 }, "/repo/app")
    expect(sdkPathnames()).toHaveLength(1)
  })

  test("getSessionMessage reads one ACP record by id, whatever its age", async () => {
    const record = { info: { id: "msg_old", role: "user" }, parts: [] }
    responses.push(json(record))
    const result = await opencodeClient.getSessionMessage(ACP_ID, "msg_old", "/repo/app")
    expect(result).toEqual(record)
    expect(requests).toHaveLength(1)
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}/message/msg_old`)
  })

  test("getSessionMessage surfaces a genuine 404 for a missing ACP record", async () => {
    responses.push(json({ error: "unknown message", code: "ACP_MESSAGE_UNKNOWN" }, 404))
    const error = await opencodeClient.getSessionMessage(ACP_ID, "msg_nope", "/repo/app").catch((e) => e)
    expect(error).toBeInstanceOf(AcpApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe("ACP_MESSAGE_UNKNOWN")
  })

  test("sendMessage prompts the ACP route with the client-minted id and returns it", async () => {
    responses.push(new Response(null, { status: 202 }))
    const messageId = await opencodeClient.sendMessage({ id: ACP_ID, providerID: "test", text: "hello", messageId: "msg_client1", directory: "/repo/app" })
    expect(messageId).toBe("msg_client1")
    expect(requests).toHaveLength(1)
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}/prompt`)
    expect(requests[0].body).toEqual({ messageId: "msg_client1", parts: [{ type: "text", text: "hello" }] })
  })

  test("sendMessage switches the ACP session's config options before prompting", async () => {
    responses.push(
      json({ session: acpSession }),
      json({ ok: true }),
      json({ ok: true }),
      new Response(null, { status: 202 }),
    )
    await opencodeClient.sendMessage({
      id: ACP_ID,
      providerID: "test",
      text: "hello",
      model: { providerID: "prov", id: "model" },
      agent: "build",
      directory: "/repo/app",
    })
    // One metadata read serves both switches, then the prompt.
    expect(requests.map((request) => request.url.pathname)).toEqual([
      `/api/acp/sessions/${ACP_ID}`,
      `/api/acp/sessions/${ACP_ID}/config`,
      `/api/acp/sessions/${ACP_ID}/config`,
      `/api/acp/sessions/${ACP_ID}/prompt`,
    ])
    expect(requests[1].body).toEqual({ configId: "model", value: "prov/model" })
    expect(requests[2].body).toEqual({ configId: "mode", value: "build" })
  })

  test("sendMessage folds context ahead of the prompt text", async () => {
    responses.push(new Response(null, { status: 202 }))
    await opencodeClient.sendMessage({
      id: ACP_ID,
      providerID: "test",
      text: "question",
      context: [{ text: "context one" }, { text: "context two" }],
      directory: "/repo/app",
    })
    const body = requests[0].body as { messageId: unknown; parts: unknown }
    expect(typeof body.messageId).toBe("string")
    expect(body.parts).toEqual([{ type: "text", text: "context one\n\ncontext two\n\nquestion" }])
  })

  test("sendMessage surfaces a busy 409 without touching the SDK", async () => {
    responses.push(json({ error: "turn running", code: "ACP_SESSION_BUSY" }, 409))
    const error = await opencodeClient.sendMessage({ id: ACP_ID, providerID: "test", text: "hi", directory: "/repo/app" }).catch((e) => e)
    expect(error).toBeInstanceOf(AcpApiError)
    expect(error.status).toBe(409)
    expect(sdkPathnames()).toHaveLength(0)
  })

  test("abortSession cancels the ACP turn", async () => {
    responses.push(json({ cancelled: true }))
    expect(await opencodeClient.abortSession(ACP_ID, "/repo/app")).toBe(true)
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}/cancel`)
    expect(sdkPathnames()).toHaveLength(0)
  })

  test("switchSessionModel/agent go through the session's config option ids", async () => {
    responses.push(json({ session: acpSession }), json({ ok: true }))
    await opencodeClient.switchSessionModel(ACP_ID, { providerID: "prov", id: "model" }, "/repo/app")
    expect(requests[1].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}/config`)
    expect(requests[1].body).toEqual({ configId: "model", value: "prov/model" })

    responses.push(json({ session: acpSession }), json({ ok: true }))
    await opencodeClient.switchSessionAgent(ACP_ID, "plan", "/repo/app")
    expect(requests[3].body).toEqual({ configId: "mode", value: "plan" })
    expect(sdkPathnames()).toHaveLength(0)
  })

  test("a direct switch with no matching config option throws AcpUnsupportedError", async () => {
    responses.push(json({ session: { ...acpSession, metadata: { acp: { backendId: "omp", configOptions: [] } } } }))
    await expect(opencodeClient.switchSessionModel(ACP_ID, { providerID: "prov", id: "model" }, "/repo/app"))
      .rejects.toBeInstanceOf(AcpUnsupportedError)
    // Only the session read; no config write.
    expect(requests).toHaveLength(1)
  })

  test("a direct switch to a value the agent did not offer throws, but sends stay lenient", async () => {
    const meta = { acp: { backendId: "omp", configOptions: [{ id: "model", options: [{ id: "omp/offered" }] }] } }
    responses.push(json({ session: { ...acpSession, metadata: meta } }))
    await expect(opencodeClient.switchSessionModel(ACP_ID, { providerID: "prov", id: "model" }, "/repo/app"))
      .rejects.toBeInstanceOf(AcpUnsupportedError)
    expect(requests).toHaveLength(1)
    // An offered value writes through.
    responses.push(json({ session: { ...acpSession, metadata: meta } }), json({ ok: true }))
    await opencodeClient.switchSessionModel(ACP_ID, { providerID: "omp", id: "offered" }, "/repo/app")
    expect(requests).toHaveLength(3)
    expect(requests[2].body).toEqual({ configId: "model", value: "omp/offered" })
    // The send path no-ops the same unmappable switch and prompts anyway.
    responses.push(json({ session: { ...acpSession, metadata: meta } }), new Response(null, { status: 202 }))
    const messageId = await opencodeClient.sendMessage({
      id: ACP_ID,
      providerID: "test",
      text: "hello",
      model: { providerID: "prov", id: "model" },
      messageId: "msg_lenient",
      directory: "/repo/app",
    })
    expect(messageId).toBe("msg_lenient")
    expect(requests.slice(3).map((request) => request.url.pathname)).toEqual([
      `/api/acp/sessions/${ACP_ID}`,
      `/api/acp/sessions/${ACP_ID}/prompt`,
    ])
  })

  test("a runtime switch during the metadata read sends no config write or prompt", async () => {
    responses.push(() => {
      runtimeKey = "runtime-new"
      return json({ session: acpSession })
    })
    const error = await opencodeClient.sendMessage({
      runtimeKey: "test-runtime",
      id: ACP_ID,
      providerID: "test",
      text: "hello",
      model: { providerID: "prov", id: "model" },
      directory: "/repo/app",
    }).catch((e) => e)
    expect(String(error?.message ?? error)).toContain("runtime changed")
    // Only the metadata GET on the old runtime; no config POST, no prompt.
    expect(requests).toHaveLength(1)
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}`)
  })

  test("unsupported ops throw AcpUnsupportedError without any request", async () => {
    const unsupported = [
      () => opencodeClient.stageRevert(ACP_ID, "msg_1", { directory: "/repo/app" }),
      () => opencodeClient.clearRevert(ACP_ID, "/repo/app"),
      () => opencodeClient.compactSession(ACP_ID, "/repo/app"),
      () => opencodeClient.forkSession(ACP_ID, { directory: "/repo/app" }),
      () => opencodeClient.shellSession({ sessionId: ACP_ID, command: "ls", directory: "/repo/app" }),
      () => opencodeClient.backgroundSessionWork(ACP_ID, "/repo/app"),
      () => opencodeClient.moveSession(ACP_ID, "/other", {}),
      () => opencodeClient.getSessionTurnDiff(ACP_ID, { directory: "/repo/app" }),
    ]
    for (const run of unsupported) {
      await expect(run()).rejects.toBeInstanceOf(AcpUnsupportedError)
    }
    expect(requests).toHaveLength(0)
  })

  test("unsupported ops still work for OpenCode sessions", async () => {
    responses.push(json({ data: {} }))
    await opencodeClient.compactSession(OPENCODE_ID, "/repo/app")
    expect(sdkPathnames()).toHaveLength(1)
    expect(acpPathnames()).toHaveLength(0)
  })

  test("createSession with a backend id creates on the ACP route; without, on the SDK", async () => {
    responses.push(json({ session: acpSession }))
    expect((await opencodeClient.createSession({ title: "Hi", acpBackendId: "omp" }, "/repo/app")).id).toBe(ACP_ID)
    expect(requests[0].url.pathname).toBe("/api/acp/sessions")
    expect(requests[0].body).toEqual({ backendId: "omp", directory: "/repo/app", title: "Hi" })

    responses.push(json({ data: openCodeSessionInfo }))
    expect((await opencodeClient.createSession({ title: "Hi" }, "/repo/app")).id).toBe(OPENCODE_ID)
    expect(sdkPathnames()).toHaveLength(1)
  })

  test("a directory list appends ACP sessions after native records, sorted by id among themselves", async () => {
    responses.push(json({ data: [openCodeSessionInfo], cursor: {} }))
    responses.push(json({ sessions: [{ ...acpSession, id: "ses_acp-omp_r9" }, { ...acpSession, id: "ses_acp-omp_r1" }] }))
    const page = await opencodeClient.listSessionsPage({ directory: "/repo/app" })
    expect(page.sessions.map((session) => session.id)).toEqual(["ses_01ABc2", "ses_acp-omp_r1", "ses_acp-omp_r9"])
    expect(requests[1].url.pathname).toBe("/api/acp/sessions")
  })

  test("native page order, contents, and cursor survive the ACP append byte-for-byte", async () => {
    const second = { ...openCodeSessionInfo, id: "ses_00aaa0" }
    responses.push(json({ data: [openCodeSessionInfo, second], cursor: { next: "c2" } }))
    responses.push(json({ sessions: [acpSession] }))
    const page = await opencodeClient.listSessionsPage({ directory: "/repo/app", limit: 2 })
    // Native order untouched (descending here), ACP appended, cursor intact.
    expect(page.sessions.map((session) => session.id)).toEqual(["ses_01ABc2", "ses_00aaa0", ACP_ID])
    expect(page.cursor).toEqual({ next: "c2" })
  })

  test("an empty ACP list leaves the native page untouched", async () => {
    const second = { ...openCodeSessionInfo, id: "ses_00aaa0" }
    responses.push(json({ data: [openCodeSessionInfo, second], cursor: { next: "c2" } }))
    responses.push(json({ sessions: [] }))
    const page = await opencodeClient.listSessionsPage({ directory: "/repo/app" })
    expect(page.sessions.map((session) => session.id)).toEqual(["ses_01ABc2", "ses_00aaa0"])
    expect(page.cursor).toEqual({ next: "c2" })
  })

  test("a failed ACP list leaves the OpenCode page intact", async () => {
    responses.push(json({ data: [openCodeSessionInfo], cursor: {} }))
    responses.push(json({ error: "down" }, 500))
    const page = await opencodeClient.listSessionsPage({ directory: "/repo/app" })
    expect(page.sessions.map((session) => session.id)).toEqual([OPENCODE_ID])
  })

  test("global, search, cursor, child, and explicitly ordered pages skip the ACP merge", async () => {
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.listSessionsPage({ global: true })
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.listSessionsPage({ directory: "/repo/app", search: "x" })
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.listSessionsPage({ directory: "/repo/app", cursor: "c" })
    responses.push(json({ data: [], cursor: {} }))
    await opencodeClient.listSessionsPage({ directory: "/repo/app", parentID: "ses_1" })
    responses.push(json({ data: [{ ...openCodeSessionInfo, id: "ses_z" }, { ...openCodeSessionInfo, id: "ses_a" }], cursor: { next: "c2" } }))
    const ordered = await opencodeClient.listSessionsPage({ directory: "/repo/app", order: "desc", limit: 2 })
    expect(ordered.sessions.map((session) => session.id)).toEqual(["ses_z", "ses_a"])
    expect(ordered.cursor).toEqual({ next: "c2" })
    expect(acpPathnames()).toHaveLength(0)
  })

  test("the busy map merges ACP statuses with OpenCode's", async () => {
    responses.push(json({ data: { [OPENCODE_ID]: { type: "running" } } }))
    responses.push(json({ statuses: { [ACP_ID]: { type: "busy" } } }))
    const statuses = await opencodeClient.getActiveSessionStatuses("/repo/app")
    expect(statuses).toEqual({ [OPENCODE_ID]: { type: "busy" }, [ACP_ID]: { type: "busy" } })
    expect(requests[1].url.pathname).toBe("/api/acp/sessions/status")
  })

  test("a failed ACP status read keeps the OpenCode statuses", async () => {
    responses.push(json({ data: { [OPENCODE_ID]: { type: "running" } } }))
    responses.push(json({ error: "down" }, 500))
    expect(await opencodeClient.getActiveSessionStatuses("/repo/app")).toEqual({ [OPENCODE_ID]: { type: "busy" } })
  })

  test("replyToPermission routes ACP ids to the ACP reply route, OpenCode ids to the SDK", async () => {
    responses.push(new Response(null, { status: 200 }))
    expect(await opencodeClient.replyToPermission(ACP_ID, "per_1", "once", { directory: "/repo/app" })).toBe(true)
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}/permissions/per_1/reply`)
    expect(requests[0].body).toEqual({ reply: "once" })
    expect(sdkPathnames()).toHaveLength(0)

    responses.push(new Response(null, { status: 204 }))
    expect(await opencodeClient.replyToPermission(OPENCODE_ID, "per_2", "reject", { directory: "/repo/app" })).toBe(true)
    expect(sdkPathnames()).toHaveLength(1)
  })

  test("fetchPermission maps an ACP 404 to resolved and other failures to unknown", async () => {
    responses.push(json({ error: "settled", code: "ACP_PERMISSION_UNKNOWN" }, 404))
    expect(await opencodeClient.fetchPermission(ACP_ID, "per_1", "/repo/app")).toEqual({ state: "resolved" })
    responses.push(new Response("", { status: 502 }))
    expect(await opencodeClient.fetchPermission(ACP_ID, "per_1", "/repo/app")).toEqual({ state: "unknown" })
    const permission = { id: "per_1", sessionID: ACP_ID, action: "shell", resources: ["ls"] }
    responses.push(json({ permission }))
    expect(await opencodeClient.fetchPermission(ACP_ID, "per_1", "/repo/app")).toEqual({ state: "ok", permission })
    expect(sdkPathnames()).toHaveLength(0)
  })

  test("listPendingPermissions merges ACP requests after OpenCode's per directory", async () => {
    const openCode = { id: "per_oc", sessionID: OPENCODE_ID, action: "bash", resources: [] }
    const acp = { id: "per_acp", sessionID: ACP_ID, action: "shell", resources: ["ls"] }
    responses.push(json({ data: [openCode] }))
    responses.push(json({ permissions: [acp] }))
    const merged = await opencodeClient.listPendingPermissions({ directories: ["/repo/app"] })
    expect(merged).toEqual([openCode, acp])
    expect(requests[1].url.pathname).toBe("/api/acp/permissions")
  })

  test("a failed ACP pending-permissions read keeps the OpenCode list", async () => {
    const openCode = { id: "per_oc", sessionID: OPENCODE_ID, action: "bash", resources: [] }
    responses.push(json({ data: [openCode] }))
    responses.push(json({ error: "down" }, 500))
    expect(await opencodeClient.listPendingPermissions({ directories: ["/repo/app"] })).toEqual([openCode])
  })

  test("replyToForm and cancelForm route by id shape", async () => {
    responses.push(new Response(null, { status: 200 }))
    expect(await opencodeClient.replyToForm(ACP_ID, "frm_1", { choice: "a" }, "/repo/app")).toBe(true)
    expect(requests[0].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}/forms/frm_1/reply`)
    expect(requests[0].body).toEqual({ answer: { choice: "a" } })

    responses.push(new Response(null, { status: 200 }))
    expect(await opencodeClient.cancelForm(ACP_ID, "frm_1", "/repo/app")).toBe(true)
    expect(requests[1].url.pathname).toBe(`/api/acp/sessions/${ACP_ID}/forms/frm_1/cancel`)
    expect(sdkPathnames()).toHaveLength(0)

    responses.push(new Response(null, { status: 204 }))
    await opencodeClient.replyToForm(OPENCODE_ID, "frm_2", { choice: "b" }, "/repo/app")
    responses.push(new Response(null, { status: 204 }))
    await opencodeClient.cancelForm(OPENCODE_ID, "frm_2", "/repo/app")
    expect(sdkPathnames()).toHaveLength(2)
  })

  test("listPendingForms merges ACP forms after OpenCode's", async () => {
    const openCode = { id: "frm_oc", sessionID: OPENCODE_ID, title: "Q", fields: [] }
    const acp = { id: "frm_acp", sessionID: ACP_ID, title: "Q", fields: [] }
    responses.push(json({ data: [openCode] }))
    responses.push(json({ forms: [acp] }))
    expect(await opencodeClient.listPendingForms({ directories: ["/repo/app"] })).toEqual([openCode, acp])
  })
})
