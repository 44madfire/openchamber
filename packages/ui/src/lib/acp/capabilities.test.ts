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

  test("ACP sessions reject every gated op except a capable fork", () => {
    for (const operation of ["revert", "compact", "shell", "background", "move", "diff"] as const) {
      expect(isAcpUnsupported(ACP_ID, operation)).toBe(true)
    }
    expect(isAcpUnsupported(ACP_ID, "fork")).toBe(true)
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp" } } })).toBe(true)
    expect(isAcpUnsupported(ACP_ID, "fork", { metadata: { acp: { backendId: "omp", capabilities: { fork: true } } } })).toBe(false)
  })
})
