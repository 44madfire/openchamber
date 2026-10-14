import { describe, expect, test } from "bun:test"
import { isAcpUnsupported } from "./capabilities"

const ACP_ID = "ses_acp-omp_r1"

describe("isAcpUnsupported", () => {
  test("OpenCode sessions support everything", () => {
    for (const operation of ["revert", "compact", "shell", "background", "move", "fork", "diff"] as const) {
      expect(isAcpUnsupported("ses_01ABc2", operation)).toBe(false)
    }
    expect(isAcpUnsupported(null, "fork")).toBe(false)
    expect(isAcpUnsupported(undefined, "revert")).toBe(false)
  })

  test("ACP sessions reject static gated ops; revert/diff are checkpoint-gated instead", () => {
    for (const operation of ["compact", "shell", "background", "move"] as const) {
      expect(isAcpUnsupported(ACP_ID, operation)).toBe(true)
    }
    // Revert and diff always pass the static gate: callers check the
    // session's checkpoint rows for a complete turn instead.
    expect(isAcpUnsupported(ACP_ID, "revert")).toBe(false)
    expect(isAcpUnsupported(ACP_ID, "diff")).toBe(false)
    expect(isAcpUnsupported(ACP_ID, "fork")).toBe(true)
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp" } } })).toBe(true)
    // The real projected shape: the full initialize capabilities object with
    // fork under sessionCapabilities as a capability object.
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp", capabilities: { sessionCapabilities: { fork: {} } } } } })).toBe(false)
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp", capabilities: { sessionCapabilities: {} } } } })).toBe(true)
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp", capabilities: { sessionCapabilities: { fork: false } } } } })).toBe(true)
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp", capabilities: { sessionCapabilities: { fork: null } } } } })).toBe(true)
    // A root-level fork boolean is not the wire shape and must not enable fork.
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp", capabilities: { fork: true } } } })).toBe(true)
  })

  test("the UI reads the fork flag the projector actually emits", async () => {
    const { createSessionProjector } = await import("../../../../web/server/lib/acp/core/projector.js")
    const projector = createSessionProjector({ key: ACP_ID, backendId: "omp", directory: "/repo" })
    projector.seed(
      { modes: [{ id: "default" }], configOptions: [] },
      { sessionCapabilities: { fork: {} } },
    )
    const session = projector.session()
    expect(isAcpUnsupported(ACP_ID, "fork", session as unknown as Parameters<typeof isAcpUnsupported>[2])).toBe(false)
    expect(isAcpUnsupported(ACP_ID, "fork")).toBe(true)
  })
})
