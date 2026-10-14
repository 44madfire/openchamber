import React from 'react';
import { selectSmallModelAvailability, useSmallModelStore, type SmallModelAvailability } from '@/stores/useSmallModelStore';

/**
 * Whether the background model can run for `directory`. Fetches on mount and
 * whenever `active` flips to true (a menu opening, a dialog showing), so a
 * closed menu never polls. `sessionKey` scopes the answer to an ACP
 * session's backend; OpenCode callers omit it.
 */
export function useSmallModelAvailability(directory: string | null | undefined, active = true, sessionKey?: string | null): SmallModelAvailability {
  const availability = useSmallModelStore(
    React.useCallback((state) => selectSmallModelAvailability(state, directory, sessionKey), [directory, sessionKey]),
  );
  const ensureFresh = useSmallModelStore((state) => state.ensureFresh);
  React.useEffect(() => {
    if (!active) return;
    void ensureFresh(directory, sessionKey);
  }, [active, directory, ensureFresh, sessionKey]);
  return availability;
}
