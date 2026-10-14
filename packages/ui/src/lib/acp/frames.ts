/**
 * `openchamber:acp-sync` frame validation (D4).
 *
 * The server publishes one UI frame per ACP session batch:
 * `{ type: "openchamber:acp-sync", properties: { directory, events } }`, where
 * `events` are domain `SyncEvent`s in the same vocabulary the reducer
 * consumes. The frame is validated with zod and its events pass unchanged
 * into the existing queue/reducer (`classifyStreamPayload`).
 *
 * The boundary validates everything the reducer, router, and renderers
 * consume without guards: discriminators, routing fields (`sessionID`,
 * `messageID`, part identity), ordering fields (`time.created`), status and
 * transition enums with their kind-specific payloads, and the permission
 * action / form fields the docks dereference. Unknown additional fields
 * pass through untouched, so the server can extend records without breaking
 * older clients — but a known record missing a consumed field is rejected,
 * and with it the whole batch (a partial batch would desync the transcript).
 */

import { z } from "zod"
import type { SyncEvent } from "@/lib/opencode/events"

const sessionIdSchema = z.string().min(1)
const messageIdSchema = z.string().min(1)

const messageRoleSchema = z.enum([
  "user",
  "assistant",
  "synthetic",
  "system",
  "skill",
  "shell",
  "compaction",
  "agent-switched",
  "model-switched",
  "location-switched",
  "idle",
  "agent-notice",
])

const sessionSchema = z.looseObject({
  id: sessionIdSchema,
  directory: z.string().min(1),
  title: z.string(),
  time: z.looseObject({ created: z.number(), updated: z.number() }),
})

const messageSchema = z.looseObject({
  id: messageIdSchema,
  sessionID: sessionIdSchema,
  role: messageRoleSchema,
  time: z.looseObject({ created: z.number() }),
})

const partBase = {
  id: z.string().min(1),
  sessionID: sessionIdSchema,
  messageID: messageIdSchema,
}

const textPartSchema = z.looseObject({ ...partBase, type: z.enum(["text", "reasoning"]), text: z.string() })
const filePartSchema = z.looseObject({ ...partBase, type: z.literal("file"), mime: z.string(), url: z.string() })
const agentPartSchema = z.looseObject({ ...partBase, type: z.literal("agent"), name: z.string() })
const toolPartSchema = z.looseObject({
  ...partBase,
  type: z.literal("tool"),
  tool: z.string(),
  state: z.looseObject({ status: z.enum(["pending", "running", "completed", "error"]) }),
})
const partSchema = z.discriminatedUnion("type", [textPartSchema, filePartSchema, agentPartSchema, toolPartSchema])

const anyRecordSchema = z.record(z.string(), z.unknown())

const sessionStatusSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("idle") }),
  z.looseObject({ type: z.literal("busy") }),
  z.looseObject({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number() }),
])

const toolTransitionSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("input"), raw: z.string() }),
  z.looseObject({ kind: z.literal("called"), input: anyRecordSchema, executed: z.boolean(), start: z.number() }),
  z.looseObject({ kind: z.literal("progress"), metadata: anyRecordSchema }),
  z.looseObject({
    kind: z.literal("success"),
    output: z.string(),
    executed: z.boolean(),
    end: z.number(),
  }),
  z.looseObject({ kind: z.literal("failed"), error: z.string(), executed: z.boolean() }),
])

const permissionSchema = z.looseObject({ id: z.string().min(1), sessionID: sessionIdSchema, action: z.string() })

const formFieldSchema = z.looseObject({ key: z.string(), type: z.string() })
const formSchema = z.looseObject({ id: z.string().min(1), sessionID: sessionIdSchema, fields: z.array(formFieldSchema) })

const catalogKindSchema = z.enum([
  "config",
  "agent",
  "command",
  "skill",
  "plugin",
  "provider",
  "model",
  "credential",
  "project",
  "websearch",
])

const shellSchema = z.looseObject({ id: z.string().min(1), sessionID: sessionIdSchema, command: z.string() })
const shellEndSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("exited"), status: z.enum(["exited", "timeout", "killed"]) }),
  z.looseObject({ kind: z.literal("removed") }),
])

const syncEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("server.connected"), properties: z.looseObject({}) }),
  z.looseObject({ type: z.literal("installation.update-available"), properties: z.looseObject({ version: z.string() }) }),
  z.looseObject({ type: z.literal("session.created"), properties: z.looseObject({ info: sessionSchema }) }),
  z.looseObject({
    type: z.literal("session.patched"),
    properties: z.looseObject({ sessionID: sessionIdSchema, patch: anyRecordSchema }),
  }),
  z.looseObject({ type: z.literal("session.deleted"), properties: z.looseObject({ sessionID: sessionIdSchema }) }),
  z.looseObject({
    type: z.literal("session.forked"),
    properties: z.looseObject({ sessionID: sessionIdSchema, parentID: z.string().min(1) }),
  }),
  z.looseObject({
    type: z.literal("session.revert.committed"),
    properties: z.looseObject({ sessionID: sessionIdSchema, to: messageIdSchema }),
  }),
  z.looseObject({
    type: z.literal("session.status"),
    properties: z.looseObject({ sessionID: sessionIdSchema, status: sessionStatusSchema }),
  }),
  z.looseObject({
    type: z.literal("session.idle"),
    properties: z.looseObject({
      sessionID: sessionIdSchema,
      outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
    }),
  }),
  z.looseObject({
    type: z.literal("session.error"),
    properties: z.looseObject({ sessionID: sessionIdSchema, error: anyRecordSchema }),
  }),
  z.looseObject({ type: z.literal("message.updated"), properties: z.looseObject({ info: messageSchema }) }),
  z.looseObject({
    type: z.literal("message.patched"),
    properties: z.looseObject({ sessionID: sessionIdSchema, messageID: messageIdSchema, patch: anyRecordSchema }),
  }),
  z.looseObject({
    type: z.literal("message.removed"),
    properties: z.looseObject({ sessionID: sessionIdSchema, messageID: messageIdSchema }),
  }),
  z.looseObject({
    type: z.literal("message.part.updated"),
    properties: z.looseObject({ sessionID: sessionIdSchema, part: partSchema }),
  }),
  z.looseObject({
    type: z.literal("message.part.delta"),
    properties: z.looseObject({
      sessionID: sessionIdSchema,
      messageID: messageIdSchema,
      partID: z.string().min(1),
      field: z.enum(["text", "raw"]),
      delta: z.string(),
    }),
  }),
  z.looseObject({
    type: z.literal("message.tool.transition"),
    properties: z.looseObject({
      sessionID: sessionIdSchema,
      messageID: messageIdSchema,
      partID: z.string().min(1),
      transition: toolTransitionSchema,
    }),
  }),
  z.looseObject({
    type: z.literal("message.parts.replaced"),
    properties: z.looseObject({ sessionID: sessionIdSchema, messageID: messageIdSchema, parts: z.array(partSchema) }),
  }),
  z.looseObject({
    type: z.literal("message.compaction.delta"),
    properties: z.looseObject({ sessionID: sessionIdSchema, delta: z.string() }),
  }),
  z.looseObject({ type: z.literal("permission.asked"), properties: permissionSchema }),
  z.looseObject({
    type: z.literal("permission.replied"),
    properties: z.looseObject({ sessionID: sessionIdSchema, requestID: z.string().min(1) }),
  }),
  z.looseObject({ type: z.literal("form.created"), properties: z.looseObject({ form: formSchema }) }),
  z.looseObject({
    type: z.literal("form.settled"),
    properties: z.looseObject({ sessionID: sessionIdSchema, formID: z.string().min(1) }),
  }),
  z.looseObject({ type: z.literal("shell.started"), properties: z.looseObject({ shell: shellSchema }) }),
  z.looseObject({
    type: z.literal("shell.ended"),
    properties: z.looseObject({ shellID: z.string().min(1), end: shellEndSchema, endedAt: z.number() }),
  }),
  z.looseObject({ type: z.literal("vcs.branch.updated"), properties: z.looseObject({ branch: z.string().optional() }) }),
  z.looseObject({ type: z.literal("mcp.status.changed"), properties: z.looseObject({ server: z.string() }) }),
  z.looseObject({ type: z.literal("catalog.updated"), properties: z.looseObject({ kind: catalogKindSchema }) }),
  z.looseObject({ type: z.literal("location.shutdown"), properties: z.looseObject({}) }),
  z.looseObject({ type: z.literal("openchamber.notification"), properties: anyRecordSchema }),
  z.looseObject({
    type: z.literal("openchamber.permission-auto-accept"),
    properties: z.looseObject({ sessions: z.record(z.string(), z.boolean()) }),
  }),
  z.looseObject({
    type: z.literal("openchamber.permission-left-for-user"),
    properties: z.looseObject({
      permissionId: z.string().min(1),
      sessionId: z.string().min(1),
      directory: z.string().nullable(),
    }),
  }),
])

export const acpSyncFrameSchema = z.looseObject({
  type: z.literal("openchamber:acp-sync"),
  properties: z.looseObject({
    directory: z.string().min(1),
    events: z.array(syncEventSchema),
  }),
})

export type AcpSyncFrame = z.infer<typeof acpSyncFrameSchema>

/**
 * Validates one raw stream payload as an ACP sync frame. Returns the frame's
 * directory plus its events, or `null` when the payload is not a valid frame
 * (wrong type or shape — never throws).
 */
export function parseAcpSyncFrame(payload: unknown): { directory: string; events: SyncEvent[] } | null {
  const parsed = acpSyncFrameSchema.safeParse(payload)
  if (!parsed.success) return null
  // The schemas above check the discriminator plus every field the reducer,
  // router, and renderers consume without guards; the nested records are
  // the server's domain JSON, consumed as SyncEvent input.
  const events = parsed.data.properties.events as unknown as SyncEvent[]
  return { directory: parsed.data.properties.directory, events }
}
