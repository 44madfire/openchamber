import { describe, expect, test } from "bun:test"
import type { Message } from "@/lib/opencode/model"
import { acpTurnOf, canRevertTurn, completeCheckpoints, revertDidFork, skippedPathLines } from "./revert"

const ACP_ID = "ses_acp-omp_r1"

const user = (id: string, acpTurn?: number): Message => ({
  id,
  sessionID: ACP_ID,
  role: "user",
  time: { created: 1 },
  ...(acpTurn === undefined ? {} : { metadata: { acpTurn } }),
})
const assistant = (id: string): Message => ({
  id,
  sessionID: ACP_ID,
  role: "assistant",
  agent: "build",
  providerID: "p",
  modelID: "m",
  time: { created: 2, completed: 3 },
})

describe("acpTurnOf", () => {
  test("reads the server-stamped canonical ordinal", () => {
    expect(acpTurnOf(user("u1", 1))).toBe(1)
    expect(acpTurnOf(user("u60", 60))).toBe(60)
  })

  test("returns null without a valid stamp", () => {
    expect(acpTurnOf(user("u1"))).toBeNull()
    expect(acpTurnOf(user("u1", 0))).toBeNull()
    expect(acpTurnOf(user("u1", -2))).toBeNull()
    expect(acpTurnOf(user("u1", 1.5))).toBeNull()
    expect(acpTurnOf(assistant("a1"))).toBeNull()
    expect(acpTurnOf(null)).toBeNull()
    expect(acpTurnOf(undefined)).toBeNull()
  })

  test("a paginated window cannot misnumber a stamped turn (projector regression)", async () => {
    // The projector is the server's word on the canonical ordinal: 60 live
    // turns, then read only a 50-user tail window. Counting that window
    // would number u60 as turn 50; the stamp says 60.
    const { createSessionProjector } = await import("../../../../web/server/lib/acp/core/projector.js")
    const projector = createSessionProjector({ key: ACP_ID, backendId: "omp", directory: "/repo" })
    for (let turn = 1; turn <= 60; turn += 1) {
      projector.acceptPrompt(`u${turn}`, [{ type: "text", text: `prompt ${turn}` }])
      projector.applyPromptResult({ stopReason: "end_turn" })
    }
    expect(projector.turnNumberOf("u60")).toBe(60)
    const full = projector.page({ limit: 500 }).items.map((item) => item.info) as Message[]
    const users = full.filter((message) => message.role === "user")
    // The UI loads newest-first pages; the tail window holds the newest 50.
    const loaded = users.slice(0, 50)
    const target = loaded.find((message) => message.id === "u60")
    expect(loaded.findIndex((message) => message.id === "u60")).toBe(0)
    expect(acpTurnOf(target)).toBe(projector.turnNumberOf("u60"))
  })
})

describe("canRevertTurn", () => {
  const checkpoints = [
    { turn: 1, complete: true },
    { turn: 2, complete: false },
  ]

  test("requires an ACP session, a positive turn, and a complete row", () => {
    expect(canRevertTurn(ACP_ID, 1, checkpoints)).toBe(true)
    expect(canRevertTurn(ACP_ID, 2, checkpoints)).toBe(false)
    expect(canRevertTurn(ACP_ID, 3, checkpoints)).toBe(false)
    expect(canRevertTurn(ACP_ID, 1, [])).toBe(false)
    expect(canRevertTurn(ACP_ID, 1, null)).toBe(false)
    expect(canRevertTurn(ACP_ID, null, checkpoints)).toBe(false)
    expect(canRevertTurn(ACP_ID, 0, checkpoints)).toBe(false)
    expect(canRevertTurn("ses_01ABc2", 1, checkpoints)).toBe(false)
    expect(canRevertTurn(null, 1, checkpoints)).toBe(false)
  })

  test("completeCheckpoints keeps complete rows only", () => {
    expect(completeCheckpoints(checkpoints)).toEqual([{ turn: 1, complete: true }])
  })
})

describe("revertDidFork / skippedPathLines", () => {
  const session = (id: string) => ({ id }) as { id: string }

  test("a response naming a new key forked; the same key stayed in place", () => {
    expect(revertDidFork(ACP_ID, { session: session("ses_acp-omp_r2") } as never)).toBe(true)
    expect(revertDidFork(ACP_ID, { session: session(ACP_ID) } as never)).toBe(false)
  })

  test("skipped paths render as file — reason lines", () => {
    expect(skippedPathLines({ skipped: [{ file: "a.ts", reason: "obstructed" }] } as never)).toEqual([
      "a.ts — obstructed",
    ])
    expect(skippedPathLines({ skipped: [] } as never)).toEqual([])
  })
})
