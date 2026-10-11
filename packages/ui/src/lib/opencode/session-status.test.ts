import { describe, expect, test } from "bun:test"
import { hostSessionStatusSnapshotSchema } from "./session-status"

describe("hostSessionStatusSnapshotSchema", () => {
  test("keeps a pending form's question count and drops its field definitions", () => {
    const parsed = hostSessionStatusSnapshotSchema.parse({
      sessions: {},
      serverTime: 1,
      pending: {
        s1: {
          permissions: [],
          forms: [
            {
              id: "f1",
              sessionID: "s1",
              title: "Questions",
              fields: [
                { key: "a", type: "boolean" },
                { key: "b", type: "external", url: "https://example.com" },
                { key: "c", type: "string", when: [{ key: "a", op: "eq", value: true }] },
              ],
            },
            { id: "f2", sessionID: "s1", title: "Empty", fields: [] },
          ],
        },
      },
    })

    // The gated question joins only after an answer; a form with no fields
    // still waits on the user.
    expect(parsed.pending?.s1.forms).toEqual([
      { id: "f1", sessionID: "s1", title: "Questions", questionCount: 2 },
      { id: "f2", sessionID: "s1", title: "Empty", questionCount: 1 },
    ])
  })
})
