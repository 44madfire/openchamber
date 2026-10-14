import { beforeEach, describe, expect, mock, test } from "bun:test"

type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const requests: Array<{ body: unknown }> = []

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: mock<RuntimeFetch>(async (_input, init) => {
    requests.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body })
    return json({ text: "A distilled note." })
  }),
}))

// The runtimeFetch mock above must install before this module loads.
const { summarizeSelectionForNotes } = await import("./smallModel")
const { useConfigStore } = await import("@/stores/useConfigStore")

const longText = `In verify.ts the retry loop backs off exponentially between attempts, capped at thirty seconds, and surfaces the last provider error verbatim so the caller can decide whether the outage is transient or a quota problem worth escalating to the on-call engineer immediately without delay.`

beforeEach(() => {
  requests.length = 0
  useConfigStore.setState({ currentProviderId: null, currentModelId: null } as never)
})

describe("summarizeSelectionForNotes", () => {
  test("OpenCode body keeps the historical sessionID field and shape", async () => {
    expect(await summarizeSelectionForNotes(longText, "ses_01ABc2")).toBe("A distilled note.")
    expect(requests).toHaveLength(1)
    const body = requests[0].body as Record<string, unknown>
    expect(Object.keys(body)).toEqual([
      "prompt",
      "system",
      "sessionID",
      "restrictToPreferredProvider",
    ])
    expect(body.sessionID).toBe("ses_01ABc2")
    expect(body).not.toHaveProperty("sessionKey")
  })

  test("ACP sessions add sessionKey and skip the synthetic provider", async () => {
    expect(await summarizeSelectionForNotes(longText, "ses_acp-omp_r1")).toBe("A distilled note.")
    expect(requests).toHaveLength(1)
    const body = requests[0].body as Record<string, unknown>
    expect(body.sessionID).toBe("ses_acp-omp_r1")
    expect(body.sessionKey).toBe("ses_acp-omp_r1")
    expect(body).not.toHaveProperty("preferredProviderID")
  })
})
