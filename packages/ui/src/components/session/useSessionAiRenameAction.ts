import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useIsSessionAiRenamePending, useSessionAiRename } from '@/sync/use-session-ai-rename';
import { useSmallModelAvailability } from '@/hooks/useSmallModelAvailability';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Menus and mobile swipe actions check history only while their controls are open. */
export function useSessionAiRenameAction(sessionID: string, directory: string | null | undefined, open: boolean) {
  const { t } = useI18n();
  // ACP sessions are absent from the global store (its full load is
  // global-only, so the per-directory ACP merge never applies), and callers
  // that resolve the directory from the global record pass nothing for them.
  // Fall back to the sync-layer resolution, which reads the session's own
  // record from its directory store.
  const resolvedDirectory = directory || useSessionUIStore.getState().getDirectoryForSession(sessionID) || null;
  const { prepare, rename } = useSessionAiRename(sessionID, resolvedDirectory);
  const pending = useIsSessionAiRenamePending(sessionID, resolvedDirectory);
  const [availability, setAvailability] = useState<'checking' | 'ready' | 'empty' | 'error'>('checking');
  const unsupported = isVSCodeRuntime();
  // Renaming runs on the small model; without one the item is disabled with
  // the reason rather than failing after the click.
  const smallModel = useSmallModelAvailability(resolvedDirectory, open && !unsupported);
  const noSmallModel = smallModel === 'unavailable';
  useEffect(() => {
    if (!open || !resolvedDirectory || unsupported || pending) return;
    const controller = new AbortController();
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => controller.abort());
    setAvailability('checking');
    void prepare(controller.signal).then(({ turns }) => {
      if (!controller.signal.aborted) setAvailability(turns.length ? 'ready' : 'empty');
    }).catch(() => {
      if (!controller.signal.aborted) setAvailability('error');
    });
    return () => { controller.abort(); unsubscribe(); };
  }, [resolvedDirectory, open, pending, prepare, unsupported]);

  const disabled = unsupported || !resolvedDirectory || pending || noSmallModel || availability === 'checking' || availability === 'empty';
  const hint = unsupported ? t('sessions.aiRename.unsupported')
    : pending ? t('sessions.aiRename.generating')
      : noSmallModel ? t('sessions.aiRename.noSmallModel')
        : availability === 'checking' ? t('sessions.aiRename.checking')
          : availability === 'empty' ? t('sessions.aiRename.noCompletedTurns')
            : t('sessions.sidebar.session.menuHint.aiRename');
  const run = useCallback(() => {
    void rename().catch(() => toast.error(t('sessions.aiRename.failed')));
  }, [rename, t]);

  return { pending, disabled, hint, run };
}
