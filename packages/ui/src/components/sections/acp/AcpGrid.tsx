import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardChip,
  SettingsCardIcon,
  SettingsCardPill,
  SettingsCardSearch,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { useI18n } from '@/lib/i18n';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { useAcpBackendsStore } from '@/stores/useAcpBackendsStore';
import type { AcpBackendStatus } from '@/lib/acp/client';

const nextBackendId = (existing: readonly { id: string }[]): string => {
  const baseName = 'new-agent';
  let name = baseName;
  let counter = 1;
  while (existing.some((backend) => backend.id === name)) {
    name = `${baseName}-${counter}`;
    counter += 1;
  }
  return name;
};

const toneForState = (state: AcpBackendStatus['state'], enabled: boolean): SettingsCardTone => {
  if (!enabled) return 'neutral';
  switch (state) {
    case 'ready': return 'success';
    case 'starting': return 'info';
    case 'error': return 'error';
    case 'idle': return 'neutral';
    default: return 'warning';
  }
};

/** Browse view of the ACP page: one card per configured backend with its live status. */
export const AcpGrid: React.FC = () => {
  const { t } = useI18n();
  const { backends, loading, loadError, load, select, save } = useAcpBackendsStore(useShallow((state) => ({
    backends: state.backends,
    loading: state.loading,
    loadError: state.loadError,
    load: state.load,
    select: state.select,
    save: state.save,
  })));
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async () => {
    if (!deleteTarget || !backends) return;
    setIsDeleting(true);
    try {
      const entries = backends
        .filter((backend) => backend.id !== deleteTarget)
        .map((backend) => backend.entry)
        .filter((entry): entry is NonNullable<typeof entry> => !!entry);
      await save(entries);
      toast.success(t('settings.acp.page.toast.deleted'));
      setDeleteTarget(null);
    } catch {
      toast.error(t('settings.acp.page.toast.deleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const servers = backends ?? [];
  const filtered = rankByQuery([...servers], query, (backend) => [
    backend.id,
    backend.label ?? '',
    backend.entry ? `${backend.entry.command} ${(backend.entry.args ?? []).join(' ')}` : '',
  ]);
  const hasQuery = query.trim().length > 0;

  return (
    <SettingsPageLayout
      title={t('settings.page.acp.title')}
      description={t('settings.acp.grid.description')}
      headerEnd={(
        <div className="flex w-full items-center gap-2 @xl:w-auto">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted-foreground"
            disabled={loading}
            onClick={() => void load()}
            aria-label={t('settings.acp.grid.refreshAria')}
            title={t('settings.acp.grid.refreshTitle')}
          >
            <Icon name="refresh" className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>
      )}
    >
      {loading && !backends ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.acp.grid.state.loading')}</p>
      ) : loadError && !backends ? (
        <div className="space-y-3 py-6">
          <p className="typography-meta text-[var(--status-error)]">{t('settings.acp.grid.state.loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('settings.acp.grid.state.retry')}
          </Button>
        </div>
      ) : (
        <>
          {servers.length > 0 ? (
            <SettingsCardSearch value={query} onChange={setQuery} placeholder={t('settings.acp.grid.searchPlaceholder')} />
          ) : null}

          {servers.length === 0 ? (
            <p className="py-6 typography-meta text-muted-foreground">{t('settings.acp.grid.empty')}</p>
          ) : filtered.length === 0 ? (
            <p className="py-6 typography-meta text-muted-foreground">{t('settings.acp.grid.noMatches', { query: query.trim() })}</p>
          ) : null}

          <div className={SETTINGS_CARD_GRID_CLASS}>
            {hasQuery ? null : (
              <SettingsAddCard
                label={t('settings.acp.grid.add')}
                hint={t('settings.acp.grid.addHint')}
                onClick={() => select(nextBackendId(servers), true)}
                settingsItem="acp.create"
              />
            )}
            {filtered.map((backend) => {
              const enabled = backend.enabled !== false;
              const target = backend.entry ? `${backend.entry.command} ${(backend.entry.args ?? []).join(' ')}`.trim() : '';
              return (
                <SettingsCard
                  key={backend.id}
                  icon={<SettingsCardIcon name="robot-2" />}
                  title={backend.label || backend.id}
                  subtitle={target || undefined}
                  badges={(
                    <SettingsCardPill tone={toneForState(backend.state, enabled)}>
                      {enabled ? t(`settings.acp.status.${backend.state}`) : t('settings.acp.status.disabled')}
                    </SettingsCardPill>
                  )}
                  muted={!enabled}
                  footer={(
                    <>
                      <span>{backend.id}</span>
                      {backend.protocolVersion !== null ? (
                        <SettingsCardChip>v{backend.protocolVersion}</SettingsCardChip>
                      ) : null}
                      {backend.agentInfo?.name ? (
                        <SettingsCardChip>{backend.agentInfo.name}{backend.agentInfo.version ? ` ${backend.agentInfo.version}` : ''}</SettingsCardChip>
                      ) : null}
                    </>
                  )}
                  onOpen={() => select(backend.id)}
                  actionsLabel={t('settings.acp.grid.actionsAria', { name: backend.label || backend.id })}
                  actions={[{
                    label: t('settings.common.actions.delete'),
                    icon: 'delete-bin',
                    destructive: true,
                    onSelect: () => setDeleteTarget(backend.id),
                  }]}
                />
              );
            })}
          </div>
        </>
      )}

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.acp.page.deleteDialog.title', { name: deleteTarget ?? '' })}</DialogTitle>
            <DialogDescription>{t('settings.acp.page.deleteDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={isDeleting}>
              {isDeleting ? t('settings.mcp.page.actions.deleting') : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};
