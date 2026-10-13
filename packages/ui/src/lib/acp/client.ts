/**
 * Typed client for the OpenChamber ACP routes (`/api/acp/*`).
 *
 * Transport conventions mirror `OpencodeService`: every request goes through
 * `runtimeFetch` (runtime base URL, auth, relay/space routing), and
 * directory-scoped reads carry the URI-encoded `x-opencode-directory` header
 * the server resolves a Location from. Responses are plain JSON of the UI
 * domain shapes (`Session`, `Message`, `Part`, ...); every response is parsed
 * once at the boundary with zod (see the envelope schemas below) and only
 * the named output type is consumed past it.
 *
 * Route contract: `web/server/lib/acp/http/routes.d.ts`.
 */

import { z } from "zod"
import { runtimeFetch } from "@/lib/runtime-fetch"
import { normalizePath } from "@/lib/pathNormalization"
import type { MessagePage } from "@/lib/opencode/client"
import type { FormRequest, Message, Metadata, Part, PermissionRequest, Session, SessionStatus } from "@/lib/opencode/model"

// ---------------------------------------------------------------------------
// Response schemas (parse once at the boundary)
// ---------------------------------------------------------------------------

/**
 * Structural check for a domain record the server already emits in the UI's
 * own shape (`Session`, `Message`, ...): the boundary verifies the record is
 * present and carries its id, not every nested field — deep-validating the
 * domain model here would duplicate it and reject fields the server
 * legitimately adds.
 */
const domainRecord = <T>(value: unknown): value is T =>
  typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"

const sessionSchema = z.custom<Session>(domainRecord)
const sessionEnvelopeSchema = z.object({ session: sessionSchema })
const sessionsEnvelopeSchema = z.object({ sessions: z.array(sessionSchema) })

const messagePageSchema = z.custom<MessagePage>(
  (value): value is MessagePage => typeof value === "object" && value !== null && "items" in value && Array.isArray(value.items),
)

const messageRecordSchema = z.custom<{ info: Message; parts: Part[] }>(
  (value): value is { info: Message; parts: Part[] } => {
    if (typeof value !== "object" || value === null || !("info" in value) || !("parts" in value)) return false
    return Array.isArray(value.parts)
  },
)

const sessionStatusSchema = z.custom<SessionStatus>(
  (value): value is SessionStatus =>
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string",
)
const statusesEnvelopeSchema = z.object({ statuses: z.record(z.string(), sessionStatusSchema) })

const permissionSchema = z.custom<PermissionRequest>(domainRecord)
const permissionEnvelopeSchema = z.object({ permission: permissionSchema })
const permissionsEnvelopeSchema = z.object({ permissions: z.array(permissionSchema) })

const formSchema = z.custom<FormRequest>(domainRecord)
const formsEnvelopeSchema = z.object({ forms: z.array(formSchema) })

const commandSchema = z.looseObject({ name: z.string(), description: z.string().optional() })
const commandsEnvelopeSchema = z.object({ commands: z.array(commandSchema) })

/** A slash command of one ACP session (`metadata`-free `CommandInfo`-compatible shape). */
export type AcpCommandInfo = z.infer<typeof commandSchema>
/** One filled-in form: every field the agent declared, keyed by field key. */
export type AcpFormAnswer = Record<string, string | number | boolean | string[]>

const errorBodySchema = z.looseObject({ error: z.unknown(), message: z.unknown(), code: z.unknown() })

const acpBackendEntrySchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  helper: z.looseObject({ config: z.record(z.string(), z.string()) }).optional(),
})

/** A registry entry as the backends route embeds it under `entry`. */
export type AcpBackendEntry = z.infer<typeof acpBackendEntrySchema>

const acpBackendStatusSchema = z.looseObject({
  id: z.string(),
  label: z.string().optional(),
  enabled: z.boolean().optional(),
  state: z.enum(["unconfigured", "idle", "starting", "ready", "error"]),
  protocolVersion: z.number().nullable(),
  agentInfo: z.looseObject({ name: z.string().optional(), version: z.string().optional() }).nullable(),
  agentCapabilities: z.record(z.string(), z.unknown()).nullable(),
  authMethods: z.array(z.looseObject({ id: z.string(), name: z.string().optional(), description: z.string().optional(), type: z.string().optional() })),
  lastError: z.string().nullable(),
  stderrTail: z.string(),
  entry: acpBackendEntrySchema.optional(),
})

/** One ACP backend entry with its live status. */
export type AcpBackendStatus = z.infer<typeof acpBackendStatusSchema>

const backendsEnvelopeSchema = z.object({ backends: z.array(acpBackendStatusSchema) })
const backendEnvelopeSchema = z.object({ backend: acpBackendStatusSchema })

const acpCheckpointSchema = z.looseObject({ turn: z.number().int().positive(), complete: z.boolean() })

/** One checkpoint summary of `GET .../checkpoints` (D12). */
export type AcpCheckpointSummary = z.infer<typeof acpCheckpointSchema>

const acpFileDiffSchema = z.looseObject({
  file: z.string(),
  patch: z.string(),
  additions: z.number(),
  deletions: z.number(),
  status: z.enum(["added", "deleted", "modified"]),
})

/** One file entry of `GET .../diff` (D14), in the `FileDiffInfo` shape DiffView consumes. */
export type AcpFileDiff = z.infer<typeof acpFileDiffSchema>

const acpRevertResponseSchema = z.looseObject({
  restored: z.array(z.string()),
  removed: z.array(z.string()),
  skipped: z.array(z.looseObject({ file: z.string(), reason: z.string() })),
  session: sessionSchema,
})

/** The `POST .../revert` answer (D13): file outcome plus the session to continue in. */
export type AcpRevertResponse = z.infer<typeof acpRevertResponseSchema>

const acpAuthTerminalSchema = z.looseObject({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  methodId: z.string(),
})

/** Spawn details for a terminal auth method (Phase 1.6). */
export type AcpAuthTerminal = z.infer<typeof acpAuthTerminalSchema>

const acpOneOffResponseSchema = z.looseObject({ text: z.string() })

/** The `POST /api/acp/oneoff` answer; the UI consumes only `text`. */
export type AcpOneOffResponse = z.infer<typeof acpOneOffResponseSchema>
const acpConfigOptionSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  type: z.string().optional(),
  current: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  options: z.array(z.looseObject({ id: z.string(), name: z.string().optional() })).optional(),
})

/** An ACP config option as the session's `metadata.acp` carries it. */
export type AcpConfigOption = z.infer<typeof acpConfigOptionSchema>

const configCacheEnvelopeSchema = z.object({ configOptions: z.array(acpConfigOptionSchema) })
const acpPlanEntrySchema = z.looseObject({
  content: z.string().optional(),
  priority: z.string().optional(),
  status: z.string().optional(),
})

/** One entry of the agent's plan (`session.metadata.acp.plan`), rendered read-only by `AcpPlanPanel`. */
export type AcpPlanEntry = z.infer<typeof acpPlanEntrySchema>

const acpSessionMetaSchema = z.looseObject({
  backendId: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  configOptions: z.array(acpConfigOptionSchema).optional(),
  modes: z.array(z.looseObject({ id: z.string(), name: z.string().optional() })).optional(),
  contextSize: z.number().optional(),
  plan: z.looseObject({ entries: z.array(acpPlanEntrySchema).optional(), updatedAt: z.number().optional() }).optional(),
  revertedFromTurn: z.number().int().positive().optional(),
})

/** The `metadata.acp` block the server attaches to every ACP session. */
export type AcpSessionMeta = {
  backendId: string
  capabilities: Record<string, unknown>
  configOptions: AcpConfigOption[]
  modes: Array<{ id: string; name?: string }>
  contextSize?: number
  plan?: { entries: AcpPlanEntry[]; updatedAt?: number }
  /** Checkpoint turn this session was reverted from, when it last reverted (D13). */
  revertedFromTurn?: number
}

/** A prompt part in `POST /api/acp/sessions/:key/prompt`. */
export type AcpPromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; url: string; filename?: string }

const DIRECTORY_HEADER = "x-opencode-directory"

const directoryHeader = (directory?: string | null): Record<string, string> => {
  const normalized = directory ? (normalizePath(directory) ?? directory) : undefined
  return normalized ? { [DIRECTORY_HEADER]: encodeURIComponent(normalized) } : {}
}

/**
 * HTTP status for ACP failures that are not transport problems. The prompt
 * route answers 409 while a turn runs; callers branch on it to avoid
 * queueing a second turn behind a running one.
 */
export class AcpApiError extends Error {
  readonly status: number
  readonly code?: string
  /** The server's raw error message, without the operation/status prefix in `message`. */
  readonly detail: string

  constructor(operation: string, status: number, message: string, options?: { code?: string; cause?: unknown }) {
    super(`${operation} failed (${status}): ${message}`, { cause: options?.cause })
    this.name = "AcpApiError"
    this.status = status
    this.code = options?.code
    this.detail = message
  }
}

/** An OpenCode-side operation that has no ACP equivalent for this session. */
export class AcpUnsupportedError extends Error {
  readonly operation: string
  readonly sessionId: string

  constructor(operation: string, sessionId: string) {
    super(`${operation} is not supported for ACP sessions`)
    this.name = "AcpUnsupportedError"
    this.operation = operation
    this.sessionId = sessionId
  }
}

const invalidEnvelope = (operation: string, field: string): AcpApiError =>
  new AcpApiError(operation, 200, `response is missing "${field}"`)

const throwForStatus = async (operation: string, response: Response): Promise<void> => {
  if (response.ok) return
  const body = errorBodySchema.safeParse(await response.json().catch(() => null))
  const detail = body.success ? (body.data.error ?? body.data.message) : null
  const message = typeof detail === "string" && detail ? detail : response.statusText || "request failed"
  const code = body.success && typeof body.data.code === "string" ? body.data.code : undefined
  throw new AcpApiError(operation, response.status, message, code ? { code } : undefined)
}

const readJson = async (operation: string, response: Response): Promise<unknown> => {
  await throwForStatus(operation, response)
  if (response.status === 204) return null
  try {
    return (await response.json()) as unknown
  } catch (error) {
    throw new AcpApiError(operation, response.status, "invalid JSON response", { cause: error })
  }
}

const buildUrl = (path: string, query?: Record<string, string | undefined>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, value)
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  return `${path}${suffix}`
}

export class AcpClient {
  /** Live statuses of every registered backend. */
  async listBackends(): Promise<AcpBackendStatus[]> {
    const response = await runtimeFetch("/api/acp/backends", { headers: { Accept: "application/json" } })
    const parsed = backendsEnvelopeSchema.safeParse(await readJson("acp.backends.list", response))
    if (!parsed.success) throw invalidEnvelope("acp.backends.list", "backends")
    return parsed.data.backends
  }

  /** Creates a session on `backendId` in `directory`. */
  async createSession(backendId: string, directory: string, title?: string): Promise<Session> {
    const operation = "acp.sessions.create"
    const response = await runtimeFetch("/api/acp/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json", ...directoryHeader(directory) },
      body: JSON.stringify({ backendId, directory, ...(title !== undefined ? { title } : {}) }),
    })
    const parsed = sessionEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "session")
    return parsed.data.session
  }

  /** Sessions of one directory, sorted by id. */
  async listSessions(directory: string): Promise<Session[]> {
    const operation = "acp.sessions.list"
    const response = await runtimeFetch(buildUrl("/api/acp/sessions", { directory }), {
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    const parsed = sessionsEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "sessions")
    return parsed.data.sessions
  }

  /** Opens (loading when cold) and returns one session. */
  async getSession(key: string, directory?: string | null): Promise<Session> {
    const operation = "acp.sessions.get"
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}`, {
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    const parsed = sessionEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "session")
    return parsed.data.session
  }

  /** Renames a session (persisted as the index `userTitle`). */
  async renameSession(key: string, title: string, directory?: string | null): Promise<Session> {
    const operation = "acp.sessions.rename"
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Accept: "application/json", ...directoryHeader(directory) },
      body: JSON.stringify({ title }),
    })
    const parsed = sessionEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "session")
    return parsed.data.session
  }

  /** Deletes (or closes, when the agent has no delete) a session. */
  async deleteSession(key: string, directory?: string | null): Promise<boolean> {
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    await throwForStatus("acp.sessions.delete", response)
    return true
  }

  /**
   * One page of a session's messages — the same shape
   * `OpencodeService.getSessionMessages` returns (`MessagePage`).
   */
  async getSessionMessages(
    key: string,
    options?: { limit?: number; before?: string },
    directory?: string | null,
  ): Promise<MessagePage> {
    const operation = "acp.sessions.messages"
    const response = await runtimeFetch(
      buildUrl(`/api/acp/sessions/${encodeURIComponent(key)}/message`, {
        ...(options?.limit !== undefined ? { limit: String(options.limit) } : {}),
        ...(options?.before !== undefined ? { before: options.before } : {}),
      }),
      { headers: { Accept: "application/json", ...directoryHeader(directory) } },
    )
    const parsed = messagePageSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "items")
    return parsed.data
  }

  /** One message record by id; 404 `ACP_MESSAGE_UNKNOWN` when absent. */
  async getSessionMessage(key: string, messageID: string, directory?: string | null): Promise<{ info: Message; parts: Part[] }> {
    const operation = "acp.sessions.message"
    const response = await runtimeFetch(
      `/api/acp/sessions/${encodeURIComponent(key)}/message/${encodeURIComponent(messageID)}`,
      { headers: { Accept: "application/json", ...directoryHeader(directory) } },
    )
    const parsed = messageRecordSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "info")
    return parsed.data
  }

  /**
   * Sends one user turn. `messageId` is client-minted; the projector echoes
   * it back so the optimistic message reconciles in place. Throws
   * `AcpApiError` with status 409 while a turn runs.
   */
  async promptSession(key: string, messageId: string, parts: AcpPromptPart[], directory?: string | null): Promise<void> {
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json", ...directoryHeader(directory) },
      body: JSON.stringify({ messageId, parts }),
    })
    await throwForStatus("acp.sessions.prompt", response)
  }

  /** Interrupts the running turn. Resolves false when nothing was running. */
  async cancelSession(key: string, directory?: string | null): Promise<boolean> {
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}/cancel`, {
      method: "POST",
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    if (response.status === 204) return false
    await throwForStatus("acp.sessions.cancel", response)
    return true
  }

  /** Sets one config option on the session (model, effort, mode, ...). */
  async setSessionConfig(key: string, configId: string, value: string | number | boolean, directory?: string | null): Promise<void> {
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}/config`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json", ...directoryHeader(directory) },
      body: JSON.stringify({ configId, value }),
    })
    await throwForStatus("acp.sessions.config", response)
  }

  /** Busy map for one directory: session key → status. */
  async getSessionStatuses(directory: string): Promise<Record<string, SessionStatus>> {
    const operation = "acp.sessions.status"
    const response = await runtimeFetch(buildUrl("/api/acp/sessions/status", { directory }), {
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    const parsed = statusesEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "statuses")
    return parsed.data.statuses
  }

  /**
   * Last-seen config options of a backend (D9 pre-session picker). Empty when
   * the backend never reported options; the draft picker then renders nothing
   * and the session reconciles from its own `metadata.acp` after create.
   */
  async getBackendConfigCache(backendId: string): Promise<AcpConfigOption[]> {
    const operation = "acp.backends.configCache"
    const response = await runtimeFetch(`/api/acp/backends/${encodeURIComponent(backendId)}/config-cache`, {
      headers: { Accept: "application/json" },
    })
    const parsed = configCacheEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "configOptions")
    return parsed.data.configOptions
  }

  /**
   * Answers one pending permission. 404 `ACP_PERMISSION_UNKNOWN` when the
   * request already settled; callers read that as "nothing left to answer".
   */
  async replyToPermission(
    key: string,
    requestId: string,
    reply: "once" | "always" | "reject",
    options?: { message?: string; directory?: string | null },
  ): Promise<void> {
    const response = await runtimeFetch(
      `/api/acp/sessions/${encodeURIComponent(key)}/permissions/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json", ...directoryHeader(options?.directory) },
        body: JSON.stringify({ reply, ...(options?.message !== undefined ? { message: options.message } : {}) }),
      },
    )
    await throwForStatus("acp.permissions.reply", response)
  }

  /** Fetches one pending permission; 404 `ACP_PERMISSION_UNKNOWN` when settled. */
  async fetchPermission(key: string, requestId: string, directory?: string | null): Promise<PermissionRequest> {
    const operation = "acp.permissions.get"
    const response = await runtimeFetch(
      `/api/acp/sessions/${encodeURIComponent(key)}/permissions/${encodeURIComponent(requestId)}`,
      { headers: { Accept: "application/json", ...directoryHeader(directory) } },
    )
    const parsed = permissionEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "permission")
    return parsed.data.permission
  }

  /** Pending permissions of one directory, for bootstrap merge. */
  async listPendingPermissions(directory: string): Promise<PermissionRequest[]> {
    const operation = "acp.permissions.list"
    const response = await runtimeFetch(buildUrl("/api/acp/permissions", { directory }), {
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    const parsed = permissionsEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "permissions")
    return parsed.data.permissions
  }

  /** Answers an elicitation or choice-prompt form. */
  async replyToForm(key: string, formId: string, answer: AcpFormAnswer, directory?: string | null): Promise<void> {
    const response = await runtimeFetch(
      `/api/acp/sessions/${encodeURIComponent(key)}/forms/${encodeURIComponent(formId)}/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json", ...directoryHeader(directory) },
        body: JSON.stringify({ answer }),
      },
    )
    await throwForStatus("acp.forms.reply", response)
  }

  /** Dismisses an elicitation or choice-prompt form. */
  async cancelForm(key: string, formId: string, directory?: string | null): Promise<void> {
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}/forms/${encodeURIComponent(formId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json", ...directoryHeader(directory) },
    })
    await throwForStatus("acp.forms.cancel", response)
  }

  /** Pending forms of one directory, for bootstrap merge. */
  async listPendingForms(directory: string): Promise<FormRequest[]> {
    const operation = "acp.forms.list"
    const response = await runtimeFetch(buildUrl("/api/acp/forms", { directory }), {
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    const parsed = formsEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "forms")
    return parsed.data.forms
  }

  /** Cached slash commands of one session. Empty when the agent reported none. */
  async getSessionCommands(key: string, directory?: string | null): Promise<AcpCommandInfo[]> {
    const operation = "acp.sessions.commands"
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}/commands`, {
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    const parsed = commandsEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "commands")
    return parsed.data.commands
  }

  /** One checkpoint summary per turn, oldest first (D12). Bare JSON array on the wire. */
  async getSessionCheckpoints(key: string, directory?: string | null): Promise<AcpCheckpointSummary[]> {
    const operation = "acp.sessions.checkpoints"
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}/checkpoints`, {
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    const parsed = z.array(acpCheckpointSchema).safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "checkpoints")
    return parsed.data
  }

  /**
   * Per-file diffs of one turn's working-tree changes vs its checkpoint
   * (D14), in the `FileDiffInfo` shape DiffView consumes. Bare JSON array on
   * the wire. 422 `ACP_CHECKPOINT_INCOMPLETE` when the turn never landed a
   * usable start snapshot.
   */
  async getSessionTurnDiff(key: string, turn: number, directory?: string | null): Promise<AcpFileDiff[]> {
    const operation = "acp.sessions.diff"
    const response = await runtimeFetch(
      buildUrl(`/api/acp/sessions/${encodeURIComponent(key)}/diff`, { turn: String(turn) }),
      { headers: { Accept: "application/json", ...directoryHeader(directory) } },
    )
    const parsed = z.array(acpFileDiffSchema).safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "diff")
    return parsed.data
  }

  /**
   * One-step file revert to before `turn` (D13): restores the checkpoint,
   * then either forks (the returned session is the new fork to navigate to)
   * or marks the session reverted in place (the returned session is the same
   * key, with `metadata.acp.revertedFromTurn` and a `revert` boundary). 409
   * while busy, 422 for an incomplete turn. No staged/clear: ACP has no
   * two-phase revert.
   */
  async revertSession(key: string, turn: number, directory?: string | null): Promise<AcpRevertResponse> {
    const operation = "acp.sessions.revert"
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json", ...directoryHeader(directory) },
      body: JSON.stringify({ turn }),
    })
    const parsed = acpRevertResponseSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "session")
    return parsed.data
  }

  /**
   * Whole-transcript fork (§3.2, T6: no fork-at-message, so no body). The
   * returned session carries the new key and is warm. 409
   * `ACP_FORK_UNSUPPORTED` when the backend does not advertise fork, 409
   * `ACP_SESSION_BUSY` while a turn runs.
   */
  async forkSession(key: string, directory?: string | null): Promise<Session> {
    const operation = "acp.sessions.fork"
    const response = await runtimeFetch(`/api/acp/sessions/${encodeURIComponent(key)}/fork`, {
      method: "POST",
      headers: { Accept: "application/json", ...directoryHeader(directory) },
    })
    const parsed = sessionEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "session")
    return parsed.data.session
  }
  /** Replaces the backend registry (validated server-side); returns fresh statuses. */
  async saveBackends(backends: AcpBackendEntry[]): Promise<AcpBackendStatus[]> {
    const operation = "acp.backends.save"
    const response = await runtimeFetch("/api/acp/backends", {
      method: "PUT",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ backends }),
    })
    const parsed = backendsEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "backends")
    return parsed.data.backends
  }

  /** Stops a backend and starts it fresh; returns its new status. */
  async restartBackend(id: string): Promise<AcpBackendStatus> {
    const operation = "acp.backends.restart"
    const response = await runtimeFetch(`/api/acp/backends/${encodeURIComponent(id)}/restart`, {
      method: "POST",
      headers: { Accept: "application/json" },
    })
    const parsed = backendEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "backend")
    return parsed.data.backend
  }

  /** Runs `authenticate` for an agent auth method; terminal methods reject here. */
  async authenticateBackend(id: string, methodId: string): Promise<AcpBackendStatus> {
    const operation = "acp.backends.authenticate"
    const response = await runtimeFetch(`/api/acp/backends/${encodeURIComponent(id)}/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ methodId }),
    })
    const parsed = backendEnvelopeSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "backend")
    return parsed.data.backend
  }

  /**
   * Spawn details for an interactive terminal auth method. The route never
   * calls `authenticate`; the UI opens the command in the terminal panel and
   * offers a restart afterwards.
   */
  async getBackendAuthTerminal(id: string, methodId?: string): Promise<AcpAuthTerminal> {
    const operation = "acp.backends.authTerminal"
    const response = await runtimeFetch(`/api/acp/backends/${encodeURIComponent(id)}/auth/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...(methodId !== undefined ? { methodId } : {}) }),
    })
    const parsed = acpAuthTerminalSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "command")
    return parsed.data
  }

  /**
   * One completion on a resolved backend (D15): a throwaway session running
   * the backend's helper model/effort, then deleted/closed. `sessionKey`
   * resolves to the session's own backend. The UI consumes only `text`.
   */
  async generateOneOff(input: {
    backendId?: string
    sessionKey?: string
    instruction: string
    input: string
    maxChars?: number
  }): Promise<AcpOneOffResponse> {
    const operation = "acp.oneoff.generate"
    const response = await runtimeFetch("/api/acp/oneoff", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    })
    const parsed = acpOneOffResponseSchema.safeParse(await readJson(operation, response))
    if (!parsed.success) throw invalidEnvelope(operation, "text")
    return parsed.data
  }
}

export const acpClient = new AcpClient()

/** Reads the `metadata.acp` block the server attaches to ACP sessions, or null when absent/malformed. */
export const readAcpSessionMeta = (session: Pick<Session, "metadata"> | null | undefined): AcpSessionMeta | null => {
  const metadata: Metadata | undefined = session?.metadata
  const parsed = acpSessionMetaSchema.safeParse(metadata?.acp)
  if (!parsed.success) return null
  return {
    backendId: parsed.data.backendId,
    capabilities: parsed.data.capabilities ?? {},
    configOptions: parsed.data.configOptions ?? [],
    modes: parsed.data.modes ?? [],
    ...(parsed.data.contextSize !== undefined ? { contextSize: parsed.data.contextSize } : {}),
    ...(parsed.data.plan ? { plan: { entries: parsed.data.plan.entries ?? [], ...(parsed.data.plan.updatedAt !== undefined ? { updatedAt: parsed.data.plan.updatedAt } : {}) } } : {}),
    ...(parsed.data.revertedFromTurn !== undefined ? { revertedFromTurn: parsed.data.revertedFromTurn } : {}),
  }
}

export type { FormRequest, Message, Metadata, Part, PermissionRequest, Session }
