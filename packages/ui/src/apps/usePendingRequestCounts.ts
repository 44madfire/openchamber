import React from 'react';

import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';

export type PendingRequestCounts = { permissionCount: number; formCount: number };

/**
 * Waiting permission requests and form questions for a row: a form counts
 * each question it asks, as the docked form numbers them. Counts come from the
 * cross-directory request index, so a project the phone never opened still
 * shows them. `sessionIds` is the row's own session plus any subsessions it
 * hides: a subagent's request blocks the whole family.
 */
export const usePendingRequestCounts = (sessionIds: readonly string[]): PendingRequestCounts => {
  const permissionCount = useGlobalBlockingRequestsStore(React.useCallback((state) => {
    let count = 0;
    for (const id of sessionIds) count += state.bySession.get(id)?.permissions.length ?? 0;
    return count;
  }, [sessionIds]));
  const formCount = useGlobalBlockingRequestsStore(React.useCallback((state) => {
    let count = 0;
    for (const id of sessionIds) {
      for (const form of state.bySession.get(id)?.forms ?? []) count += form.questionCount;
    }
    return count;
  }, [sessionIds]));
  return { permissionCount, formCount };
};
