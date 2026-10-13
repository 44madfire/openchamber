import { beforeEach, describe, expect, mock, test } from "bun:test"

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

let runtimeKey = "runtime-a"
const requests: Array<{ url: URL; method: string; body: unknown }> = []
let respondListBackends: ((value: unknown) => void) | null = null
let respondSaveBackends: ((value: unknown) => void) | null = null

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

// Full surface: bun shares mocked modules across test files in one process,
// so a narrow mock breaks files that import other members (AcpPage needs the
// subscribe fns; client.acp.test needs the base URL).
mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => runtimeKey,
  getRuntimeApiBaseUrl: () => "",
  isSshForwardedRuntime: () => false,
  MOBILE_DISCONNECTED_RUNTIME_KEY: "mobile-disconnected",
  isTransientRuntimeKey: () => false,
  initializeRuntimeEndpoint: () => {},
  switchRuntimeEndpoint: () => {},
  subscribeRuntimeEndpointWillChange: () => () => {},
  subscribeRuntimeEndpointChanged: () => () => {},
}))

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: mock<RuntimeFetch>(async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url, "http://runtime.test")
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    })
    if (url.pathname === "/api/acp/backends" && (init?.method ?? "GET") === "GET") {
      return new Promise<Response>((resolve) => {
        respondListBackends = (value) => resolve(json({ backends: value }))
      })
    }
    if (url.pathname === "/api/acp/backends" && init?.method === "PUT") {
      return new Promise<Response>((resolve) => {
        respondSaveBackends = (value) => resolve(json({ backends: value }))
      })
    }
    return json({})
  }),
}))

const { useAcpBackendsStore } = await import("./useAcpBackendsStore")

const backend = (id: string, label: string) => ({
  id,
  label,
  enabled: true,
  state: "ready",
  protocolVersion: 1,
  agentInfo: null,
  agentCapabilities: null,
  authMethods: [],
  lastError: null,
  stderrTail: "",
  entry: { id, label, command: "agent", args: [] as string[] },
})

beforeEach(() => {
  runtimeKey = "runtime-a"
  requests.length = 0
  respondListBackends = null
  respondSaveBackends = null
  useAcpBackendsStore.getState().resetForRuntimeSwitch()
})

describe("useAcpBackendsStore runtime scoping", () => {
  test("a late A load publishes nothing after a switch to B", async () => {
    const store = useAcpBackendsStore.getState()
    const pending = store.load()
    expect(respondListBackends).not.toBeNull()
    // Switch endpoints while A's list is in flight.
    runtimeKey = "runtime-b"
    useAcpBackendsStore.getState().resetForRuntimeSwitch()
    respondListBackends!([backend("a-backend", "A backend")])
    await pending
    expect(useAcpBackendsStore.getState().backends).toBeNull()
    expect(useAcpBackendsStore.getState().loading).toBe(false)
  })

  test("a save started on A throws after a switch instead of publishing A's registry", async () => {
    const entries = [{ id: "a-backend", label: "A", command: "agent", args: [] as string[] }]
    const pending = useAcpBackendsStore.getState().save(entries)
    expect(respondSaveBackends).not.toBeNull()
    runtimeKey = "runtime-b"
    useAcpBackendsStore.getState().resetForRuntimeSwitch()
    respondSaveBackends!([backend("a-backend", "A backend")])
    await expect(pending).rejects.toThrow("Runtime changed during backend save")
    expect(useAcpBackendsStore.getState().backends).toBeNull()
  })

  test("reset drops the cached registry and closes the editor", async () => {
    const pending = useAcpBackendsStore.getState().load()
    respondListBackends!([backend("omp", "omp")])
    await pending
    useAcpBackendsStore.setState({ selectedId: "omp", creating: false })
    useAcpBackendsStore.getState().resetForRuntimeSwitch()
    const state = useAcpBackendsStore.getState()
    expect(state.backends).toBeNull()
    expect(state.selectedId).toBeNull()
    expect(state.creating).toBe(false)
    expect(state.loading).toBe(false)
    expect(state.loadError).toBeNull()
  })
})
