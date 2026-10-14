/**
 * ACP revert helpers (D13): canonical turn ordinals, checkpoint gating, and
 * the fork answer to "did this revert land in a new session?".
 *
 * Turn ordinals are authoritative server metadata: the projector stamps every
 * user message with `metadata.acpTurn`, the 1-based index in its accepted-turn
 * list, for live and replayed turns alike. The UI reads the stamp — it never
 * counts its loaded window, which is only the transcript's tail and would
 * number paginated turns wrong.
 */

import { acpClient, type AcpCheckpointSummary, type AcpRevertResponse } from "./client"
import { isAcpSessionId } from "./session-key"
import type { Message } from "@/lib/opencode/model"

/**
 * Canonical turn ordinal of a user message, stamped by the server projector
 * (`metadata.acpTurn`). Null when the message carries no stamp (non-ACP
 * messages, or records predating the stamp).
 */
export const acpTurnOf = (message: Pick<Message, "metadata" | "role"> | null | undefined): number | null => {
  if (!message || message.role !== "user") return null
  const turn = (message.metadata as Record<string, unknown> | undefined)?.acpTurn
  return typeof turn === "number" && Number.isInteger(turn) && turn > 0 ? turn : null
}

/** Complete checkpoint rows, oldest first. */
export const completeCheckpoints = (checkpoints: readonly AcpCheckpointSummary[]): AcpCheckpointSummary[] =>
  checkpoints.filter((row) => row.complete)

/**
 * Whether `turn` may be reverted/diffed: the session must be an ACP session
 * and the turn must have a complete checkpoint row.
 */
export const canRevertTurn = (
  sessionId: string | null | undefined,
  turn: number | null,
  checkpoints: readonly AcpCheckpointSummary[] | null | undefined,
): boolean => {
  if (!sessionId || !isAcpSessionId(sessionId)) return false
  if (!Number.isInteger(turn) || (turn as number) <= 0) return false
  return (checkpoints ?? []).some((row) => row.turn === turn && row.complete)
}

/** Reads the session's checkpoint rows, or null when the read fails/never ran. */
export const loadCheckpoints = async (
  sessionId: string,
  directory?: string | null,
): Promise<AcpCheckpointSummary[] | null> => {
  try {
    return await acpClient.getSessionCheckpoints(sessionId, directory)
  } catch {
    return null
  }
}

/**
 * True when the revert response forked: the session to continue in is a new
 * key, not the reverted one. The fork becomes the live session; the source
 * keeps its transcript and greys its undone turns.
 */
export const revertDidFork = (sourceKey: string, response: AcpRevertResponse): boolean =>
  response.session.id !== sourceKey

/** Human-readable lines for the response's skipped paths, for a toast/dialog. */
export const skippedPathLines = (response: AcpRevertResponse): string[] =>
  response.skipped.map((entry) => `${entry.file} — ${entry.reason}`)

/**
 * The `metadata.acp.revertedFromTurn` stamp: the first undone turn after an
 * in-place revert. Null for OpenCode sessions and never-reverted ones.
 */
export const acpRevertedFromTurnOf = (session: Pick<Message, "metadata"> | { metadata?: unknown } | null | undefined): number | null => {
  const meta = (session?.metadata as Record<string, unknown> | undefined)?.acp as Record<string, unknown> | undefined
  const turn = meta?.revertedFromTurn
  return typeof turn === "number" && Number.isInteger(turn) && turn > 0 ? turn : null
}

/**
 * The message id the revert marker cuts before. The server stamps the
 * boundary with the turn's client-minted message id, which the transcript
 * does not always carry (the projector mints its own ids) — so a boundary
 * that names no loaded message falls back to the first stamped message of
 * `revertedFromTurn`. No boundary at all means no cut, even with a stale
 * turn stamp (sending after a revert clears the marker first). OpenCode
 * sessions (no turn stamp) always keep their boundary untouched.
 */
export const resolveRevertBoundaryMessageID = (
  messages: readonly Pick<Message, "id" | "metadata" | "role">[],
  boundaryMessageID: string | undefined,
  revertedFromTurn: number | null | undefined,
): string | undefined => {
  if (!boundaryMessageID) return undefined
  if (messages.some((message) => message.id === boundaryMessageID)) return boundaryMessageID
  if (revertedFromTurn === null || revertedFromTurn === undefined) return boundaryMessageID
  return messages.find((message) => {
    const turn = acpTurnOf(message)
    return turn !== null && turn >= revertedFromTurn
  })?.id
}
