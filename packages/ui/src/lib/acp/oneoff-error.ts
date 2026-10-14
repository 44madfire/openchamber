import { toast } from 'sonner';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { AcpApiError } from '@/lib/acp/client';

/**
 * One-off failure toast (F2): when a throwaway generation fails on the
 * agent's error, the toast names that error and points at the per-backend
 * helper model setting instead of the generic small-model message.
 *
 * `error` is the thrown failure; `fallback` renders the historical toast
 * when the failure is not a recognized one-off error. Returns true when
 * the one-off toast was shown.
 */
export const toastOneOffError = (error: unknown, fallback: () => void): boolean => {
  const oneOff = readOneOffFailure(error);
  if (!oneOff) {
    fallback();
    return false;
  }
  const dictionary = useI18nStore.getState().dictionary;
  toast.error(formatMessage(dictionary, 'acp.oneoff.failed'), {
    description: formatMessage(dictionary, 'acp.oneoff.failedDescription', {
      detail: oneOff.detail,
      backend: oneOff.backendId ?? formatMessage(dictionary, 'acp.oneoff.unknownBackend'),
    }),
  });
  return true;
};

/** A recognized one-off failure: the agent's error text plus its backend. */
export type OneOffFailure = { detail: string; backendId?: string };

/**
 * Reads a one-off failure from the shapes the one-off callers throw:
 * `AcpApiError` from `POST /api/acp/oneoff` (code/detail/backendId), or a
 * small-model/walkthrough error carrying the same `code`/`message` fields.
 * Anything else returns null so the caller keeps its historical toast.
 */
export const readOneOffFailure = (error: unknown): OneOffFailure | null => {
  if (error instanceof AcpApiError) {
    if (error.code !== 'ACP_ONEOFF_FAILED' && error.code !== 'ACP_ONEOFF_TIMEOUT') return null;
    const detail = error.detail?.trim();
    if (!detail) return null;
    return { detail, ...(error.backendId ? { backendId: error.backendId } : {}) };
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const record = error as { code?: unknown; message?: unknown; backendId?: unknown; detail?: unknown };
    if (record.code !== 'ACP_ONEOFF_FAILED' && record.code !== 'ACP_ONEOFF_TIMEOUT') return null;
    const detail = typeof record.detail === 'string' && record.detail.trim()
      ? record.detail.trim()
      : typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : null;
    if (!detail) return null;
    return {
      detail,
      ...(typeof record.backendId === 'string' && record.backendId ? { backendId: record.backendId } : {}),
    };
  }
  return null;
};
