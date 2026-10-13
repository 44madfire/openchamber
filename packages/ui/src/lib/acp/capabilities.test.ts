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
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp", capabilities: { fork: true } } } })).toBe(false)
  })
})
