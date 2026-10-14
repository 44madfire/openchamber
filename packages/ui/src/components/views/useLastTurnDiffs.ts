import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionMessages, useSessionStatus } from '@/sync/sync-context';

export type TurnSnapshotDiff = {
  file?: string;
  status?: string;
  before?: string;
  after?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
};

/**
 * The session's last turn as per-file diffs, refetched whenever the answer
 * can change: a new message arrives, or the session settles. The settle
 * refetch matters for ACP turns, whose end snapshot — and the assistant's
 * completion patch — lands on the existing records without minting a new
 * message id. While a turn streams, the lookup serves the newest finished
 * turn instead (see `OpencodeService.getSessionTurnDiff`).
 */
export const useLastTurnDiffs = (
  sessionId: string | null,
  directory: string | null | undefined,
  active: boolean,
  visible: boolean,
): TurnSnapshotDiff[] => {
  const [lastTurnDiffs, setLastTurnDiffs] = React.useState<TurnSnapshotDiff[]>([]);
  const sessionMessages = useSessionMessages(active ? sessionId ?? '' : '', directory ?? undefined);
  const lastMessageId = sessionMessages.length > 0 ? sessionMessages[sessionMessages.length - 1].id : '';
  const sessionStatus = useSessionStatus(active ? sessionId ?? '' : '', directory ?? undefined);
  const sessionStatusKey = sessionStatus?.type ?? '';
  React.useEffect(() => {
    if (!active || !sessionId || !visible) return;
    let cancelled = false;
    void opencodeClient.getSessionTurnDiff(sessionId, { directory: directory ?? undefined })
      .then((files) => {
        if (cancelled) return;
        setLastTurnDiffs(files.map((entry) => ({
          file: entry.file,
          patch: entry.patch,
          status: entry.status,
          additions: entry.additions,
          deletions: entry.deletions,
        })));
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[diff-view] turn diff unavailable:', error instanceof Error ? error.message : error);
        setLastTurnDiffs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, lastMessageId, directory, sessionStatusKey, visible]);
  return lastTurnDiffs;
};
