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
import type { Message, Metadata, Part, PermissionRequest, Session, SessionStatus } from "@/lib/opencode/model"

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

const errorBodySchema = z.looseObject({ error: z.unknown(), message: z.unknown(), code: z.unknown() })

const acpBackendStatusSchema = z.looseObject({
  id: z.string(),
  label: z.string().optional(),
  enabled: z.boolean().optional(),
  state: z.enum(["unconfigured", "idle", "starting", "ready", "error"]),
  protocolVersion: z.number().nullable(),
  agentInfo: z.looseObject({ name: z.string().optional(), version: z.string().optional() }).nullable(),
  agentCapabilities: z.record(z.string(), z.unknown()).nullable(),
  authMethods: z.array(z.looseObject({ id: z.string(), name: z.string().optional(), description: z.string().optional() })),
  lastError: z.string().nullable(),
  stderrTail: z.string(),
})

/** One ACP backend entry with its live status. */
export type AcpBackendStatus = z.infer<typeof acpBackendStatusSchema>

const backendsEnvelopeSchema = z.object({ backends: z.array(acpBackendStatusSchema) })

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

const acpSessionMetaSchema = z.looseObject({
  backendId: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  configOptions: z.array(acpConfigOptionSchema).optional(),
  modes: z.array(z.looseObject({ id: z.string(), name: z.string().optional() })).optional(),
  contextSize: z.number().optional(),
})

/** The `metadata.acp` block the server attaches to every ACP session. */
export type AcpSessionMeta = {
  backendId: string
  capabilities: Record<string, unknown>
  configOptions: AcpConfigOption[]
  modes: Array<{ id: string; name?: string }>
  contextSize?: number
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

  constructor(operation: string, status: number, message: string, options?: { code?: string; cause?: unknown }) {
    super(`${operation} failed (${status}): ${message}`, { cause: options?.cause })
    this.name = "AcpApiError"
    this.status = status
    this.code = options?.code
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
  }
}

export type { Message, Metadata, Part, PermissionRequest, Session }
