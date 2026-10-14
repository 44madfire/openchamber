import { beforeEach, describe, expect, mock, test } from "bun:test"

// The ACP client is transport-only: mock `runtimeFetch` and assert request
// fidelity (paths, query, headers, bodies) plus response handling.

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type CapturedRequest = {
  url: URL
  method: string
  headers: Headers
  body: unknown
}

const requests: CapturedRequest[] = []
const responses: Array<Response | Error> = []

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const runtimeFetchMock = mock<RuntimeFetch>(async (input, init) => {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url, "http://runtime.test")
  requests.push({
    url,
    method: String(init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  })
  const next = responses.shift()
  if (next instanceof Error) throw next
  return next ?? json({})
})

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: runtimeFetchMock,
}))

// mock.module installs above must take effect before this module loads, so the import stays dynamic.
 const { AcpApiError, acpClient, readAcpSessionMeta } = await import("./client")

const session = {
  id: "ses_acp-omp_r1",
  projectID: "proj_1",
  directory: "/repo",
  title: "ACP",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

beforeEach(() => {
  requests.length = 0
  responses.length = 0
})

describe("acpClient", () => {
  test("createSession posts backend, directory, and title; returns the session", async () => {
    responses.push(json({ session }))
    const created = await acpClient.createSession("omp", "/repo", "Hello")
    expect(created).toEqual(session)
    expect(requests).toHaveLength(1)
    expect(requests[0].url.pathname).toBe("/api/acp/sessions")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].body).toEqual({ backendId: "omp", directory: "/repo", title: "Hello" })
    expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo"))
  })

  test("listSessions scopes by directory in query and header", async () => {
    responses.push(json({ sessions: [session] }))
    const sessions = await acpClient.listSessions("/repo/app")
    expect(sessions).toEqual([session])
    expect(requests[0].url.pathname).toBe("/api/acp/sessions")
    expect(requests[0].url.searchParams.get("directory")).toBe("/repo/app")
    expect(requests[0].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/repo/app"))
  })

  test("getSession URL-encodes the key", async () => {
    responses.push(json({ session }))
    await acpClient.getSession("ses_acp-omp_r1", "/repo")
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1")
  })

  test("renameSession PATCHes the title and returns the updated session", async () => {
    const renamed = { ...session, title: "New" }
    responses.push(json({ session: renamed }))
    const result = await acpClient.renameSession("ses_acp-omp_r1", "New", "/repo")
    expect(result).toEqual(renamed)
    expect(requests[0].method).toBe("PATCH")
    expect(requests[0].body).toEqual({ title: "New" })
  })

  test("deleteSession resolves true on success", async () => {
    responses.push(json({ deleted: true }))
    expect(await acpClient.deleteSession("ses_acp-omp_r1", "/repo")).toBe(true)
    expect(requests[0].method).toBe("DELETE")
  })

  test("getSessionMessages passes limit/before and returns the page untouched", async () => {
    const page = { items: [{ info: { id: "msg_1" }, parts: [] }], cursor: { next: "msg_0" } }
    responses.push(json(page))
    const result = await acpClient.getSessionMessages("ses_acp-omp_r1", { limit: 50, before: "msg_9" }, "/repo")
    expect(result).toEqual(page)
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/message")
    expect(requests[0].url.searchParams.get("limit")).toBe("50")
    expect(requests[0].url.searchParams.get("before")).toBe("msg_9")
  })

  test("getSessionMessage reads one record by id", async () => {
    const record = { info: { id: "msg_old" }, parts: [{ id: "prt_1" }] }
    responses.push(json(record))
    const result = await acpClient.getSessionMessage("ses_acp-omp_r1", "msg_old", "/repo")
    expect(result).toEqual(record)
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/message/msg_old")
  })

  test("promptSession sends the client-minted message id with parts", async () => {
    responses.push(new Response(null, { status: 202 }))
    const parts = [{ type: "text", text: "hello" }] as const
    await acpClient.promptSession("ses_acp-omp_r1", "msg_client1", [...parts], "/repo")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/prompt")
    expect(requests[0].body).toEqual({ messageId: "msg_client1", parts: [{ type: "text", text: "hello" }] })
  })

  test("promptSession surfaces a busy 409 with its status", async () => {
    responses.push(json({ error: "turn running", code: "ACP_SESSION_BUSY" }, 409))
    const error = await acpClient.promptSession("ses_acp-omp_r1", "msg_1", [{ type: "text", text: "hi" }]).catch((e) => e)
    expect(error).toBeInstanceOf(AcpApiError)
    expect(error.status).toBe(409)
    expect(error.code).toBe("ACP_SESSION_BUSY")
  })

  test("cancelSession resolves true when a turn was interrupted, false on 204", async () => {
    responses.push(json({ cancelled: true }))
    expect(await acpClient.cancelSession("ses_acp-omp_r1", "/repo")).toBe(true)
    responses.push(new Response(null, { status: 204 }))
    expect(await acpClient.cancelSession("ses_acp-omp_r1", "/repo")).toBe(false)
  })

  test("setSessionConfig posts the config id and value", async () => {
    responses.push(json({ ok: true }))
    await acpClient.setSessionConfig("ses_acp-omp_r1", "model", "provider/model", "/repo")
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/config")
    expect(requests[0].body).toEqual({ configId: "model", value: "provider/model" })
  })

  test("getSessionStatuses returns the busy map", async () => {
    responses.push(json({ statuses: { "ses_acp-omp_r1": { type: "busy" } } }))
    const statuses = await acpClient.getSessionStatuses("/repo")
    expect(statuses).toEqual({ "ses_acp-omp_r1": { type: "busy" } })
    expect(requests[0].url.searchParams.get("directory")).toBe("/repo")
  })

  test("listBackends returns entries with live status", async () => {
    const backend = {
      id: "omp",
      state: "ready",
      protocolVersion: 1,
      agentInfo: { name: "omp" },
      agentCapabilities: {},
      authMethods: [],
      lastError: null,
      stderrTail: "",
    }
    responses.push(json({ backends: [backend] }))
    expect(await acpClient.listBackends()).toEqual([backend])
    expect(requests[0].url.pathname).toBe("/api/acp/backends")
  })

  test("replyToPermission posts the reply and optional message", async () => {
    responses.push(new Response(null, { status: 200 }))
    await acpClient.replyToPermission("ses_acp-omp_r1", "per_1", "once", { message: "ok", directory: "/repo" })
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/permissions/per_1/reply")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].body).toEqual({ reply: "once", message: "ok" })
  })

  test("replyToPermission surfaces a settled 404 with its code", async () => {
    responses.push(json({ error: "settled", code: "ACP_PERMISSION_UNKNOWN" }, 404))
    const error = await acpClient.replyToPermission("ses_acp-omp_r1", "per_1", "reject").catch((e) => e)
    expect(error).toBeInstanceOf(AcpApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe("ACP_PERMISSION_UNKNOWN")
  })

  test("fetchPermission returns the pending request", async () => {
    const permission = { id: "per_1", sessionID: "ses_acp-omp_r1", action: "shell", resources: ["ls"] }
    responses.push(json({ permission }))
    expect(await acpClient.fetchPermission("ses_acp-omp_r1", "per_1", "/repo")).toEqual(permission)
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/permissions/per_1")
  })

  test("listPendingPermissions scopes by directory", async () => {
    const permission = { id: "per_1", sessionID: "ses_acp-omp_r1", action: "shell", resources: [] }
    responses.push(json({ permissions: [permission] }))
    expect(await acpClient.listPendingPermissions("/repo")).toEqual([permission])
    expect(requests[0].url.pathname).toBe("/api/acp/permissions")
    expect(requests[0].url.searchParams.get("directory")).toBe("/repo")
  })

  test("replyToForm posts the answer; cancelForm posts to cancel", async () => {
    responses.push(new Response(null, { status: 200 }))
    await acpClient.replyToForm("ses_acp-omp_r1", "frm_1", { choice: "a" }, "/repo")
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/forms/frm_1/reply")
    expect(requests[0].body).toEqual({ answer: { choice: "a" } })
    responses.push(new Response(null, { status: 200 }))
    await acpClient.cancelForm("ses_acp-omp_r1", "frm_1", "/repo")
    expect(requests[1].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/forms/frm_1/cancel")
  })

  test("listPendingForms scopes by directory", async () => {
    const form = { id: "frm_1", sessionID: "ses_acp-omp_r1", title: "Q", fields: [] }
    responses.push(json({ forms: [form] }))
    expect(await acpClient.listPendingForms("/repo")).toEqual([form])
    expect(requests[0].url.pathname).toBe("/api/acp/forms")
  })

  test("getSessionCommands returns the cached commands", async () => {
    const commands = [{ name: "compact", description: "Compact" }]
    responses.push(json({ commands }))
    expect(await acpClient.getSessionCommands("ses_acp-omp_r1", "/repo")).toEqual(commands)
    expect(requests[0].url.pathname).toBe("/api/acp/sessions/ses_acp-omp_r1/commands")
  })

  test("getBackendConfigCache returns the last-seen options", async () => {
    const configOptions = [{ id: "model", current: "m" }]
    responses.push(json({ configOptions }))
    expect(await acpClient.getBackendConfigCache("omp")).toEqual(configOptions)
    expect(requests[0].url.pathname).toBe("/api/acp/backends/omp/config-cache")
  })

  test("a missing envelope field throws AcpApiError", async () => {
    responses.push(json({ sessions: [] }))
    const error = await acpClient.getSession("ses_acp-omp_r1").catch((e) => e)
    expect(error).toBeInstanceOf(AcpApiError)
    expect(String(error.message)).toContain('"session"')
  })

  test("transport failures propagate untouched", async () => {
    const failure = new Error("network down")
    responses.push(failure)
    expect(await acpClient.listSessions("/repo").catch((e) => e)).toBe(failure)
  })
})

describe("readAcpSessionMeta", () => {
  test("reads a well-formed acp block", () => {
    const meta = readAcpSessionMeta({
      metadata: {
        acp: {
          backendId: "omp",
          capabilities: { delete: false },
          configOptions: [{ id: "model", current: "m" }],
          modes: [{ id: "build" }],
          contextSize: 1000,
        },
      },
    })
    expect(meta).toEqual({
      backendId: "omp",
      capabilities: { delete: false },
      configOptions: [{ id: "model", current: "m" }],
      modes: [{ id: "build" }],
      contextSize: 1000,
    })
  })

  test("reads the plan block with entries", () => {
    const meta = readAcpSessionMeta({
      metadata: {
        acp: {
          backendId: "omp",
          plan: {
            entries: [
              { content: "Write code", priority: "high", status: "in_progress" },
              { content: "Test it", priority: "medium", status: "pending" },
            ],
            updatedAt: 42,
          },
        },
      },
    })
    expect(meta?.plan).toEqual({
      entries: [
        { content: "Write code", priority: "high", status: "in_progress" },
        { content: "Test it", priority: "medium", status: "pending" },
      ],
      updatedAt: 42,
    })
    expect(readAcpSessionMeta({ metadata: { acp: { backendId: "omp" } } })).not.toHaveProperty("plan")
  })

  test("defaults missing collections and returns null without a backend id", () => {
    expect(readAcpSessionMeta({ metadata: { acp: { backendId: "omp" } } })).toEqual({
      backendId: "omp",
      capabilities: {},
      configOptions: [],
      modes: [],
    })
    expect(readAcpSessionMeta({ metadata: {} })).toBeNull()
    expect(readAcpSessionMeta({})).toBeNull()
    expect(readAcpSessionMeta(null)).toBeNull()
    expect(readAcpSessionMeta({ metadata: { acp: { capabilities: {} } } })).toBeNull()
  })
})
