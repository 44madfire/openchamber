/**
 * Read-only rendering of the agent's plan (`metadata.acp.plan` entries).
 *
 * The projector writes the plan on every ACP `plan` update; this panel reads
 * it from the session record, so it follows `session.patched` with no extra
 * subscription. Mounted as a work-status section for ACP sessions only (see
 * `WorkStatusPanel`); renders nothing without a plan or without entries.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { readAcpSessionMeta, type AcpPlanEntry } from '@/lib/acp/client';
import { isAcpSessionId } from '@/lib/acp/session-key';
import { useSession } from '@/sync/sync-context';
import { cn } from '@/lib/utils';
import { useReportWorkStatusPresence } from '../work-status/presenceContext';
import { WorkStatusCollapsibleSection, WorkStatusRow } from '../work-status/WorkStatusPrimitives';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const STATUS_ICON: Record<string, IconName> = {
  completed: 'checkbox-circle',
  in_progress: 'loader-4',
  pending: 'circle',
};

const statusIcon = (status: string | undefined): IconName => STATUS_ICON[status ?? ''] ?? 'circle';

const PRIORITY_TONE: Record<string, 'muted' | 'default' | 'warning'> = {
  low: 'muted',
  medium: 'default',
  high: 'warning',
};

const priorityTone = (priority: string | undefined): 'muted' | 'default' | 'warning' =>
  PRIORITY_TONE[priority ?? ''] ?? 'default';

const entryKey = (entry: AcpPlanEntry, index: number): string => `${index}:${entry.content ?? ''}`;

export const AcpPlanPanel: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? '', directory ?? undefined);
  const plan = React.useMemo(() => {
    if (!sessionId || !isAcpSessionId(sessionId)) return undefined;
    return readAcpSessionMeta(session)?.plan;
  }, [session, sessionId]);
  const entries = plan?.entries ?? [];
  const hasEntries = entries.length > 0;

  useReportWorkStatusPresence('acp-plan', hasEntries);
  if (!hasEntries) return null;

  const done = entries.filter((entry) => entry.status === 'completed').length;
  return (
    <WorkStatusCollapsibleSection
      id="acp-plan"
      title={t('chat.workStatus.section.acpPlan')}
      icon="file-list-2"
      summary={t('chat.workStatus.acpPlan.progress', { done, total: entries.length })}
      defaultExpanded
    >
      {entries.map((entry, index) => (
        <WorkStatusRow
          key={entryKey(entry, index)}
          leading={(
            <Icon
              name={statusIcon(entry.status)}
              className={cn(
                'size-4 shrink-0',
                entry.status === 'completed' && 'text-[var(--status-success)]',
                entry.status === 'in_progress' && 'animate-spin text-[var(--status-info)]',
                (entry.status === undefined || entry.status === 'pending') && 'text-muted-foreground',
              )}
            />
          )}
          label={<span className={cn(entry.status === 'completed' && 'text-muted-foreground line-through')}>{entry.content || t('chat.workStatus.acpPlan.emptyEntry')}</span>}
          value={entry.priority ? (
            <span className={cn(
              'typography-micro uppercase',
              priorityTone(entry.priority) === 'muted' && 'text-muted-foreground',
              priorityTone(entry.priority) === 'warning' && 'text-[var(--status-warning)]',
            )}>
              {entry.priority}
            </span>
          ) : undefined}
        />
      ))}
    </WorkStatusCollapsibleSection>
  );
};
