/**
 * Capability gating for ACP sessions.
 *
 * ACP sessions support a subset of OpenCode's operations. The service layer
 * throws `AcpUnsupportedError` for the rest; these helpers let the UI hide
 * the corresponding controls up front instead of failing on click. Gating is
 * by session id shape, except fork, which additionally reads the session's
 * `metadata.acp.capabilities` so a backend that advertises fork can enable it.
 *
 * Revert and diff are checkpoint operations, not capability operations: they
 * are available whenever the session's turn has a complete checkpoint
 * (`GET .../checkpoints`), which the UI reads on demand. The static gate here
 * reports them as always available for ACP sessions so the entries render;
 * callers then check checkpoints before offering a turn (`lib/acp/revert.ts`).
 */

import { readAcpSessionMeta } from "./client"
import { isAcpSessionId } from "./session-key"
import type { Session } from "@/lib/opencode/model"

/** Operations an ACP session may not support. */
export type AcpGatedOperation = "revert" | "compact" | "shell" | "background" | "move" | "fork" | "diff"

/**
 * True when the session cannot do `operation`. Plain OpenCode sessions always
 * return false. Fork consults the session record when given: without it (or
 * without an advertised fork capability) fork counts as unsupported. Revert
 * and diff are checkpoint-gated (see above) and always return false here.
 */
export const isAcpUnsupported = (
  sessionId: string | null | undefined,
  operation: AcpGatedOperation,
  session?: Pick<Session, "metadata"> | null,
): boolean => {
  if (!sessionId || !isAcpSessionId(sessionId)) return false
  if (operation === "revert" || operation === "diff") return false
  if (operation !== "fork") return true
  const capabilities = readAcpSessionMeta(session)?.capabilities
  return capabilities?.fork !== true
}
