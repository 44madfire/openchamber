import { describe, expect, test } from "bun:test"
import { parseAcpSyncFrame } from "./frames"

const sessionCreated = {
  type: "session.created",
  properties: {
    info: {
      id: "ses_acp-omp_r1",
      projectID: "proj_1",
      directory: "/repo",
      title: "Hello",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    },
  },
}

const userMessage = {
  id: "msg_1",
  sessionID: "ses_acp-omp_r1",
  role: "user",
  time: { created: 1 },
}

describe("parseAcpSyncFrame", () => {
  test("accepts a frame and returns its directory and events unchanged", () => {
    const delta = {
      type: "message.part.delta",
      properties: { sessionID: "ses_acp-omp_r1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "hi" },
    }
    const parsed = parseAcpSyncFrame({ type: "openchamber:acp-sync", properties: { directory: "/repo", events: [sessionCreated, delta] } })
    expect(parsed?.directory).toBe("/repo")
    expect(parsed?.events).toHaveLength(2)
    expect(parsed?.events[0]).toEqual(sessionCreated)
    expect(parsed?.events[1]).toEqual(delta)
  })

  test("accepts an empty event batch", () => {
    const parsed = parseAcpSyncFrame({ type: "openchamber:acp-sync", properties: { directory: "/repo", events: [] } })
    expect(parsed).toEqual({ directory: "/repo", events: [] })
  })

  test("keeps unknown fields on valid domain records (forward-compatible)", () => {
    const parsed = parseAcpSyncFrame({
      type: "openchamber:acp-sync",
      properties: {
        directory: "/repo",
        events: [{ type: "message.updated", properties: { info: { ...userMessage, futureField: { deep: true } } } }],
      },
    })
    expect(parsed?.events[0]).toEqual({
      type: "message.updated",
      properties: { info: { ...userMessage, futureField: { deep: true } } },
    })
  })

  test("rejects non-frame payloads", () => {
    expect(parseAcpSyncFrame(null)).toBeNull()
    expect(parseAcpSyncFrame({})).toBeNull()
    expect(parseAcpSyncFrame({ type: "openchamber:notification", properties: {} })).toBeNull()
    expect(parseAcpSyncFrame({ type: "session.created", properties: {} })).toBeNull()
  })

  test("rejects frames with a missing directory or non-array events", () => {
    expect(parseAcpSyncFrame({ type: "openchamber:acp-sync", properties: { events: [] } })).toBeNull()
    expect(parseAcpSyncFrame({ type: "openchamber:acp-sync", properties: { directory: "", events: [] } })).toBeNull()
    expect(parseAcpSyncFrame({ type: "openchamber:acp-sync", properties: { directory: "/repo" } })).toBeNull()
    expect(parseAcpSyncFrame({ type: "openchamber:acp-sync", properties: { directory: "/repo", events: {} } })).toBeNull()
  })

  test("rejects a batch when any event is malformed", () => {
    const parsed = parseAcpSyncFrame({
      type: "openchamber:acp-sync",
      properties: {
        directory: "/repo",
        events: [sessionCreated, { type: "message.part.delta", properties: { sessionID: "ses_1" } }],
      },
    })
    expect(parsed).toBeNull()
  })

  test("rejects unknown event types", () => {
    const parsed = parseAcpSyncFrame({
      type: "openchamber:acp-sync",
      properties: { directory: "/repo", events: [{ type: "session.future", properties: {} }] },
    })
    expect(parsed).toBeNull()
  })

  describe("records missing fields the reducer consumes", () => {
    const frame = (event: unknown) => ({ type: "openchamber:acp-sync", properties: { directory: "/repo", events: [event] } })

    test("message without sessionID, role, or time is rejected (no state.message['undefined'])", () => {
      expect(parseAcpSyncFrame(frame({ type: "message.updated", properties: { info: { id: "msg_bad" } } }))).toBeNull()
      const { sessionID: _droppedSession, ...noSession } = userMessage
      expect(parseAcpSyncFrame(frame({ type: "message.updated", properties: { info: noSession } }))).toBeNull()
      const { role: _droppedRole, ...noRole } = userMessage
      expect(parseAcpSyncFrame(frame({ type: "message.updated", properties: { info: noRole } }))).toBeNull()
      const { time: _droppedTime, ...noTime } = userMessage
      expect(parseAcpSyncFrame(frame({ type: "message.updated", properties: { info: noTime } }))).toBeNull()
      expect(parseAcpSyncFrame(
        frame({ type: "message.updated", properties: { info: { ...userMessage, role: "future-role" } } }),
      )).toBeNull()
    })

    test("parts without identity, type, or type fields are rejected", () => {
      const text = { id: "prt_1", sessionID: "ses_acp-omp_r1", messageID: "msg_1", type: "text", text: "hi" }
      expect(parseAcpSyncFrame(
        frame({ type: "message.part.updated", properties: { sessionID: "ses_acp-omp_r1", part: text } }),
      )).not.toBeNull()
      const { messageID: _droppedMessage, ...noMessage } = text
      expect(parseAcpSyncFrame(
        frame({ type: "message.part.updated", properties: { sessionID: "ses_acp-omp_r1", part: noMessage } }),
      )).toBeNull()
      const { text: _droppedText, ...noText } = text
      expect(parseAcpSyncFrame(
        frame({ type: "message.part.updated", properties: { sessionID: "ses_acp-omp_r1", part: noText } }),
      )).toBeNull()
      expect(parseAcpSyncFrame(
        frame({ type: "message.part.updated", properties: { sessionID: "ses_acp-omp_r1", part: { ...text, type: "future" } } }),
      )).toBeNull()
      expect(parseAcpSyncFrame(
        frame({
          type: "message.part.updated",
          properties: { sessionID: "ses_acp-omp_r1", part: { id: "prt_2", sessionID: "s", messageID: "m", type: "tool" } },
        }),
      )).toBeNull()
    })

    test("permissions without routing fields or action are rejected", () => {
      expect(parseAcpSyncFrame(
        frame({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", action: "bash" } }),
      )).not.toBeNull()
      expect(parseAcpSyncFrame(frame({ type: "permission.asked", properties: { id: "per_1" } }))).toBeNull()
      expect(parseAcpSyncFrame(
        frame({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1" } }),
      )).toBeNull()
    })

    test("forms without routing fields or fields are rejected", () => {
      const form = { id: "form_1", sessionID: "ses_1", fields: [{ key: "q", type: "string" }] }
      expect(parseAcpSyncFrame(frame({ type: "form.created", properties: { form } }))).not.toBeNull()
      expect(parseAcpSyncFrame(frame({ type: "form.created", properties: { form: { id: "form_1" } } }))).toBeNull()
      expect(parseAcpSyncFrame(
        frame({ type: "form.created", properties: { form: { id: "form_1", sessionID: "ses_1" } } }),
      )).toBeNull()
    })

    test("invalid statuses, outcomes, transitions, and catalog kinds are rejected", () => {
      const status = (s: unknown) => frame({ type: "session.status", properties: { sessionID: "ses_1", status: s } })
      expect(parseAcpSyncFrame(status({ type: "busy" }))).not.toBeNull()
      expect(parseAcpSyncFrame(status({ type: "working" }))).toBeNull()
      expect(parseAcpSyncFrame(status({ type: "retry", attempt: 1 }))).toBeNull()
      expect(parseAcpSyncFrame(status({ type: "retry", attempt: 1, message: "m", next: 2 }))).not.toBeNull()
      const idle = (o: unknown) => frame({ type: "session.idle", properties: { sessionID: "ses_1", outcome: o } })
      expect(parseAcpSyncFrame(idle("completed"))).toBeNull()
      expect(parseAcpSyncFrame(idle("interrupted"))).not.toBeNull()
      const transition = (t: unknown) =>
        frame({
          type: "message.tool.transition",
          properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", transition: t },
        })
      expect(parseAcpSyncFrame(transition({ kind: "stream", chunk: "x" }))).toBeNull()
      expect(parseAcpSyncFrame(transition({ kind: "called", input: {}, executed: true }))).toBeNull()
      expect(parseAcpSyncFrame(transition({ kind: "called", input: {}, executed: true, start: 1 }))).not.toBeNull()
      expect(parseAcpSyncFrame(
        frame({ type: "catalog.updated", properties: { kind: "theme" } }),
      )).toBeNull()
      expect(parseAcpSyncFrame(
        frame({ type: "catalog.updated", properties: { kind: "command" } }),
      )).not.toBeNull()
    })

    test("sessions without routing/display fields are rejected", () => {
      const session = (info: unknown) => frame({ type: "session.created", properties: { info } })
      expect(parseAcpSyncFrame(session({ id: "ses_1" }))).toBeNull()
      expect(parseAcpSyncFrame(
        session({ id: "ses_1", directory: "/repo", title: "t", time: { created: 1, updated: 1 } }),
      )).not.toBeNull()
    })
  })
})
