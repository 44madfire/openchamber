import React from "react"
import { isAcpSessionId } from "@/lib/acp/session-key"
import { loadCheckpoints } from "@/lib/acp/revert"
import type { AcpCheckpointSummary } from "@/lib/acp/client"
import type { Message } from "@/lib/opencode/model"
import { useSessionMessagesSelector } from "@/sync/sync-context"

/**
 * Checkpoint rows for one session. Non-ACP sessions and failed reads yield
 * null (callers treat null as "unknown", not "none").
 *
 * Refreshed whenever the session's transcript changes: a turn's row flips
 * incomplete→complete when the turn ends, and new turns append rows. A
 * fetch-once hook would freeze turns that were still running at mount as
 * ungated forever.
 */
export function useAcpCheckpoints(
  sessionId: string | null | undefined,
  directory?: string | null,
): AcpCheckpointSummary[] | null {
  const [checkpoints, setCheckpoints] = React.useState<AcpCheckpointSummary[] | null>(null)
  const transcriptKey = useSessionMessagesSelector(
    sessionId ?? "",
    directory ?? undefined,
    React.useCallback((messages: Message[]) => {
      const last = messages.length > 0 ? messages[messages.length - 1].id : ""
      return `${messages.length}:${last}`
    }, []),
  )
  React.useEffect(() => {
    if (!sessionId || !isAcpSessionId(sessionId)) {
      setCheckpoints(null)
      return
    }
    let cancelled = false
    void loadCheckpoints(sessionId, directory).then((rows) => {
      if (!cancelled) setCheckpoints(rows)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, directory, transcriptKey])
  return checkpoints
}
