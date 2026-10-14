import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsStackedField,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AcpApiError, acpClient, type AcpAuthTerminal, type AcpBackendEntry } from '@/lib/acp/client';
import { selectAcpBackend, useAcpBackendsStore } from '@/stores/useAcpBackendsStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';
import { useShallow } from 'zustand/react/shallow';

const BACKEND_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type KeyValueRow = { key: string; value: string };

const entriesToRows = (record: Record<string, string> | undefined): KeyValueRow[] =>
  Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));

const rowsToRecord = (rows: readonly KeyValueRow[]): Record<string, string> | undefined => {
  const record: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim()) record[row.key.trim()] = row.value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
};

/**
 * The auth-terminal invocation as the terminal spawns it: argv verbatim plus
 * the overlaid env layer. Displayed in the dialog exactly as executed (the
 * `direct` terminal mode takes no shell string), one argv word per line with
 * indices so empty words and whitespace stay visible.
 */
export const authTerminalDisplayLines = (invocation: AcpAuthTerminal): string[] => [
  ...Object.entries(invocation.env).map(([key, value]) => `${key}=${value}`),
  ...[invocation.command, ...invocation.args].map((word, index) => `[${index}] ${word}`),
];

const KeyValueEditor: React.FC<{
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyLabel: string;
  valueLabel: string;
  addLabel: string;
  removeAria: string;
  emptyLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}> = ({ rows, onChange, keyLabel, valueLabel, addLabel, removeAria, emptyLabel, keyPlaceholder, valuePlaceholder }) => (
  <div className="space-y-2">
    {rows.length === 0 ? (
      <p className={SETTINGS_HELPER_CLASS}>{emptyLabel}</p>
    ) : (
      rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={row.key}
            aria-label={keyLabel}
            placeholder={keyPlaceholder}
            spellCheck={false}
            className="h-8 max-w-[16rem] font-mono typography-meta"
            onChange={(event) => onChange(rows.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))}
          />
          <Input
            value={row.value}
            aria-label={valueLabel}
            placeholder={valuePlaceholder}
            spellCheck={false}
            className="h-8 min-w-0 flex-1 font-mono typography-meta"
            onChange={(event) => onChange(rows.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground"
            aria-label={removeAria}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Icon name="close" className="size-4" />
          </Button>
        </div>
      ))
    )}
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => onChange([...rows, { key: '', value: '' }])}
    >
      {addLabel}
    </Button>
  </div>
);

const StatusRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1 @xl:flex-row @xl:gap-8">
    <div className={cn(SETTINGS_FIELD_LABEL_CLASS, 'shrink-0 @xl:w-40')}>{label}</div>
    <div className="min-w-0 flex-1 typography-ui-label text-foreground">{children}</div>
  </div>
);

/** Detail editor for one ACP backend: invocation, env, helper config, live status, sign-in. */
export const AcpDetail: React.FC<{ backendId: string | null; creating: boolean }> = ({ backendId, creating }) => {
  const { t } = useI18n();
  const { terminal } = useRuntimeAPIs();
  const settingsDirectory = useSettingsDirectory();
  const backend = useAcpBackendsStore((state) => selectAcpBackend(state, backendId));
  const { backends, select, save, restart, authenticate } = useAcpBackendsStore(useShallow((state) => ({
    backends: state.backends,
    select: state.select,
    save: state.save,
    restart: state.restart,
    authenticate: state.authenticate,
  })));

  const source: AcpBackendEntry | null = backend?.entry ?? (creating ? { id: backendId ?? '', label: '', command: '', args: [] } : null);

  const [id, setId] = React.useState(source?.id ?? '');
  const [label, setLabel] = React.useState(source?.label ?? '');
  const [enabled, setEnabled] = React.useState((source?.enabled ?? true) !== false);
  const [command, setCommand] = React.useState(source?.command ?? '');
  const [argsText, setArgsText] = React.useState((source?.args ?? []).join('\n'));
  const [envRows, setEnvRows] = React.useState<KeyValueRow[]>(() => entriesToRows(source?.env));
  const [helperRows, setHelperRows] = React.useState<KeyValueRow[]>(() => entriesToRows(source?.helper?.config));
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [restarting, setRestarting] = React.useState(false);
  const [authWorking, setAuthWorking] = React.useState<string | null>(null);
  const [terminalInvocation, setTerminalInvocation] = React.useState<AcpAuthTerminal | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);

  // Re-hydrate when the selection (or a restart/auth refresh) lands.
  const hydrateKey = JSON.stringify([backendId, creating, backend?.state, backend?.lastError]);
  const hydratedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (hydratedRef.current === hydrateKey) return;
    hydratedRef.current = hydrateKey;
    if (!source) return;
    setId(source.id);
    setLabel(source.label);
    setEnabled((source.enabled ?? true) !== false);
    setCommand(source.command);
    setArgsText((source.args ?? []).join('\n'));
    setEnvRows(entriesToRows(source.env));
    setHelperRows(entriesToRows(source.helper?.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrateKey]);

  if (!source) return null;

  const validate = (): AcpBackendEntry | null => {
    const trimmedId = id.trim();
    if (!trimmedId) {
      toast.error(t('settings.acp.page.toast.idRequired'));
      return null;
    }
    if (!BACKEND_ID_PATTERN.test(trimmedId)) {
      toast.error(t('settings.acp.page.toast.idInvalid'));
      return null;
    }
    if (creating && (backends ?? []).some((entry) => entry.id === trimmedId)) {
      toast.error(t('settings.acp.page.toast.idTaken'));
      return null;
    }
    if (!label.trim()) {
      toast.error(t('settings.acp.page.toast.labelRequired'));
      return null;
    }
    if (!command.trim()) {
      toast.error(t('settings.acp.page.toast.commandRequired'));
      return null;
    }
    const args = argsText.split('\n').map((line) => line.trim()).filter(Boolean);
    const env = rowsToRecord(envRows);
    const helperConfig = rowsToRecord(helperRows);
    return {
      id: trimmedId,
      label: label.trim(),
      command: command.trim(),
      args,
      ...(env ? { env } : {}),
      enabled,
      ...(helperConfig ? { helper: { config: helperConfig } } : {}),
    };
  };

  const handleSave = async () => {
    const entry = validate();
    if (!entry || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const entries = (backends ?? [])
        .map((item) => item.entry)
        .filter((item): item is AcpBackendEntry => !!item)
        .filter((item) => creating || item.id !== entry.id);
      await save([...entries, entry]);
      toast.success(t(creating ? 'settings.acp.page.toast.created' : 'settings.acp.page.toast.saved'));
      select(entry.id);
    } catch (error) {
      // The server validates what the form does not (arg/env/helper limits):
      // keep its message visible next to the form, not just in a toast.
      const detail = error instanceof AcpApiError ? error.detail : error instanceof Error ? error.message : null;
      if (detail) setSaveError(detail);
      toast.error(t('settings.acp.page.toast.saveFailed'), detail ? { description: detail } : undefined);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!backends || isDeleting) return;
    setIsDeleting(true);
    try {
      await save(
        backends
          .map((item) => item.entry)
          .filter((item): item is AcpBackendEntry => !!item)
          .filter((item) => item.id !== source.id),
      );
      toast.success(t('settings.acp.page.toast.deleted'));
      select(null);
    } catch {
      toast.error(t('settings.acp.page.toast.deleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRestart = async () => {
    if (restarting || creating) return;
    setRestarting(true);
    try {
      await restart(source.id);
      toast.success(t('settings.acp.page.toast.restarted'));
    } catch {
      toast.error(t('settings.acp.page.toast.restartFailed'));
    } finally {
      setRestarting(false);
    }
  };

  const handleAuthenticate = async (methodId: string) => {
    if (authWorking) return;
    setAuthWorking(methodId);
    try {
      await authenticate(source.id, methodId);
      toast.success(t('settings.acp.page.toast.authenticated'));
    } catch {
      toast.error(t('settings.acp.page.toast.authFailed'));
    } finally {
      setAuthWorking(null);
    }
  };

  const handleTerminalAuth = async (methodId?: string) => {
    if (authWorking) return;
    setAuthWorking(methodId ?? '__terminal__');
    try {
      setTerminalInvocation(await acpClient.getBackendAuthTerminal(source.id, methodId));
    } catch {
      toast.error(t('settings.acp.page.toast.terminalFailed'));
    } finally {
      setAuthWorking(null);
    }
  };

  const handleOpenTerminal = async () => {
    if (!terminalInvocation) return;
    // Auth runs in the settings project checkout: the agent binary resolves
    // from the same PATH the backend manager spawns with, and the login is
    // interactive.
    const cwd = settingsDirectory;
    if (!cwd) return;
    const store = useTerminalStore.getState();
    store.ensureDirectory(cwd);
    const tabId = store.createTab(cwd);
    store.setActiveTab(cwd, tabId);
    store.setTabLabel(cwd, tabId, `auth:${source.id}`);
    try {
      const session = await terminal.createSession({
        cwd,
        sessionId: tabId,
        mode: 'direct',
        argv: [terminalInvocation.command, ...terminalInvocation.args],
        ...(Object.keys(terminalInvocation.env).length > 0 ? { env: terminalInvocation.env } : {}),
      });
      store.setTabSessionId(cwd, tabId, session.sessionId);
    } catch {
      toast.error(t('settings.acp.page.toast.terminalFailed'));
      return;
    }
    useUIStore.getState().openContextPanelTab(cwd, { mode: 'terminal', targetDirectory: null });
  };

  const capabilities = backend?.agentCapabilities ? Object.keys(backend.agentCapabilities) : [];

  return (
    <SettingsPageLayout
      title={(
        <span className="flex items-center gap-2">
          <SettingsBackButton label={t('settings.acp.page.back')} onClick={() => select(null)} />
          {creating ? t('settings.acp.grid.add') : (backend?.label || source.id)}
        </span>
      )}
    >
      <SettingsSection title={t('settings.acp.page.section.identity')} divider={false} contentClassName="space-y-4">
        <SettingsFieldRow label={t('settings.acp.page.field.id')} description={t('settings.acp.page.field.idHint')} settingsItem="acp.id">
          <Input
            value={id}
            disabled={!creating}
            aria-label={t('settings.acp.page.field.id')}
            placeholder={t('settings.acp.page.field.idPlaceholder')}
            spellCheck={false}
            className="h-8 max-w-[24rem] font-mono"
            onChange={(event) => setId(event.target.value)}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.acp.page.field.label')} settingsItem="acp.label">
          <Input
            value={label}
            aria-label={t('settings.acp.page.field.label')}
            placeholder={t('settings.acp.page.field.labelPlaceholder')}
            spellCheck={false}
            className="h-8 max-w-[24rem]"
            onChange={(event) => setLabel(event.target.value)}
          />
        </SettingsFieldRow>
        <SettingsCheckboxRow
          settingsItem="acp.enabled"
          checked={enabled}
          onChange={setEnabled}
          label={t('settings.acp.page.field.enabled')}
          ariaLabel={t('settings.acp.page.field.enabledAria')}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.acp.page.section.invocation')} contentClassName="space-y-4">
        <SettingsFieldRow label={t('settings.acp.page.field.command')} settingsItem="acp.command">
          <Input
            value={command}
            aria-label={t('settings.acp.page.field.command')}
            placeholder={t('settings.acp.page.field.commandPlaceholder')}
            spellCheck={false}
            className="h-8 max-w-[24rem] font-mono"
            onChange={(event) => setCommand(event.target.value)}
          />
        </SettingsFieldRow>
        <SettingsStackedField label={t('settings.acp.page.field.args')} description={t('settings.acp.page.field.argsHint')} settingsItem="acp.args">
          <Textarea
            value={argsText}
            aria-label={t('settings.acp.page.field.args')}
            spellCheck={false}
            rows={Math.max(3, argsText.split('\n').length + 1)}
            className="font-mono typography-meta"
            onChange={(event) => setArgsText(event.target.value)}
          />
        </SettingsStackedField>
      </SettingsSection>

      <SettingsSection title={t('settings.acp.page.section.environment')} contentClassName="space-y-4">
        <KeyValueEditor
          rows={envRows}
          onChange={setEnvRows}
          keyLabel={t('settings.acp.page.field.envKey')}
          valueLabel={t('settings.acp.page.field.envValue')}
          addLabel={t('settings.acp.page.field.envAdd')}
          removeAria={t('settings.acp.page.field.envRemoveAria')}
          emptyLabel={t('settings.acp.page.field.envEmpty')}
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.acp.page.section.helper')}
        description={t('settings.acp.page.field.helperHint')}
        contentClassName="space-y-4"
      >
        <KeyValueEditor
          rows={helperRows}
          onChange={setHelperRows}
          keyLabel={t('settings.acp.page.field.helperKey')}
          valueLabel={t('settings.acp.page.field.helperValue')}
          addLabel={t('settings.acp.page.field.helperAdd')}
          removeAria={t('settings.acp.page.field.helperRemoveAria')}
          emptyLabel={t('settings.acp.page.field.helperEmpty')}
        />
      </SettingsSection>

      {backend && !creating ? (
        <SettingsSection
          title={t('settings.acp.page.section.status')}
          headerAction={(
            <Button type="button" variant="outline" size="sm" disabled={restarting} onClick={() => void handleRestart()}>
              {restarting ? t('settings.acp.page.actions.restarting') : t('settings.acp.page.actions.restart')}
            </Button>
          )}
          contentClassName="space-y-3"
        >
          <StatusRow label={t('settings.acp.page.status.state')}>
            {t(`settings.acp.status.${backend.state}`)}
          </StatusRow>
          <StatusRow label={t('settings.acp.page.status.protocol')}>
            {backend.protocolVersion === null ? '—' : `v${backend.protocolVersion}`}
          </StatusRow>
          <StatusRow label={t('settings.acp.page.status.agent')}>
            {backend.agentInfo ? `${backend.agentInfo.name ?? ''}${backend.agentInfo.version ? ` ${backend.agentInfo.version}` : ''}`.trim() || '—' : '—'}
          </StatusRow>
          <StatusRow label={t('settings.acp.page.status.capabilities')}>
            {capabilities.length === 0 ? (
              <span className="text-muted-foreground">{t('settings.acp.page.status.capabilitiesEmpty')}</span>
            ) : (
              capabilities.join(', ')
            )}
          </StatusRow>
          {backend.lastError ? (
            <StatusRow label={t('settings.acp.page.status.lastError')}>
              <span className="text-[var(--status-error)]">{backend.lastError}</span>
            </StatusRow>
          ) : null}
          <StatusRow label={t('settings.acp.page.status.stderr')}>
            {backend.stderrTail ? (
              <pre className="max-h-40 overflow-auto rounded-md bg-[var(--surface-elevated)] px-3 py-2 font-mono typography-micro text-foreground/80 whitespace-pre-wrap">
                {backend.stderrTail}
              </pre>
            ) : (
              <span className="text-muted-foreground">{t('settings.acp.page.status.stderrEmpty')}</span>
            )}
          </StatusRow>
        </SettingsSection>
      ) : null}

      {backend && !creating ? (
        <SettingsSection title={t('settings.acp.page.section.auth')} contentClassName="space-y-3">
          {backend.authMethods.length === 0 ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.acp.page.auth.empty')}</p>
          ) : (
            backend.authMethods.map((method) => {
              const isTerminal = method.type === 'terminal';
              const busy = authWorking === method.id || authWorking === '__terminal__';
              return (
                <div key={method.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="typography-ui-label text-foreground">{method.name || method.id}</div>
                    {method.description ? (
                      <div className={cn(SETTINGS_HELPER_CLASS, 'truncate')}>{method.description}</div>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={t(isTerminal ? 'settings.acp.page.auth.terminalAria' : 'settings.acp.page.auth.authenticateAria', { name: method.name || method.id })}
                    onClick={() => void (isTerminal ? handleTerminalAuth(method.id) : handleAuthenticate(method.id))}
                  >
                    {busy ? t('settings.acp.page.auth.working') : t(isTerminal ? 'settings.acp.page.auth.terminal' : 'settings.acp.page.auth.authenticate')}
                  </Button>
                </div>
              );
            })
          )}
        </SettingsSection>
      ) : null}

      <SettingsSection contentClassName="space-y-2">
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
            {saving
              ? t(creating ? 'settings.acp.page.actions.creating' : 'settings.acp.page.actions.saving')
              : t(creating ? 'settings.acp.page.actions.create' : 'settings.acp.page.actions.save')}
          </Button>
          {creating ? null : (
            <Button type="button" variant="destructive" size="sm" onClick={() => setShowDeleteConfirm(true)}>
              {t('settings.acp.page.actions.delete')}
            </Button>
          )}
        </div>
        {saveError ? (
          <p role="alert" className="typography-meta text-[var(--status-error)]">{saveError}</p>
        ) : null}
      </SettingsSection>

      <Dialog open={showDeleteConfirm} onOpenChange={(open) => { if (!open && !isDeleting) setShowDeleteConfirm(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.acp.page.deleteDialog.title', { name: source.label || source.id })}</DialogTitle>
            <DialogDescription>{t('settings.acp.page.deleteDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={isDeleting}>
              {isDeleting ? t('settings.mcp.page.actions.deleting') : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={terminalInvocation !== null} onOpenChange={(open) => { if (!open) setTerminalInvocation(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.acp.page.terminalDialog.title')}</DialogTitle>
            <DialogDescription>{t('settings.acp.page.terminalDialog.description')}</DialogDescription>
          </DialogHeader>
          {terminalInvocation ? (
            <div className="space-y-2">
              <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.acp.page.terminalDialog.command')}</div>
              <pre className="max-h-32 overflow-auto rounded-md bg-[var(--surface-elevated)] px-3 py-2 font-mono typography-micro text-foreground/80 whitespace-pre-wrap">
                {authTerminalDisplayLines(terminalInvocation).join('\n')}
              </pre>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setTerminalInvocation(null)}>
              {t('settings.acp.page.terminalDialog.close')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void handleOpenTerminal()}>
              {t('settings.acp.page.terminalDialog.openTerminal')}
            </Button>
            <Button
              size="sm"
              disabled={restarting}
              onClick={() => { setTerminalInvocation(null); void handleRestart(); }}
            >
              {restarting ? t('settings.acp.page.actions.restarting') : t('settings.acp.page.terminalDialog.restart')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageLayout>
  );
};
