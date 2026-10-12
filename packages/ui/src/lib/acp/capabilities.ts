/**
 * Capability gating for ACP sessions.
 *
 * ACP sessions support a subset of OpenCode's operations. The service layer
 * throws `AcpUnsupportedError` for the rest; these helpers let the UI hide
 * the corresponding controls up front instead of failing on click. Gating is
 * by session id shape, except fork, which additionally reads the session's
 * `metadata.acp.capabilities` so a backend that advertises fork can enable
 * it later (M1: no backend does).
 */

import { readAcpSessionMeta } from "./client"
import { isAcpSessionId } from "./session-key"
import type { Session } from "@/lib/opencode/model"

/** Operations an ACP session may not support. */
export type AcpGatedOperation = "revert" | "compact" | "shell" | "background" | "move" | "fork" | "diff"

/**
 * True when the session cannot do `operation`. Plain OpenCode sessions always
 * return false. Fork consults the session record when given: without it (or
 * without an advertised fork capability) fork counts as unsupported.
 */
export const isAcpUnsupported = (
  sessionId: string | null | undefined,
  operation: AcpGatedOperation,
  session?: Pick<Session, "metadata"> | null,
): boolean => {
  if (!sessionId || !isAcpSessionId(sessionId)) return false
  if (operation !== "fork") return true
  const capabilities = readAcpSessionMeta(session)?.capabilities
  return capabilities?.fork !== true
}
