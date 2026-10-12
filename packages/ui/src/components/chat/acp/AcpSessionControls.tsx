/**
 * Model/effort/mode controls for ACP sessions: generic selects over the
 * session's `metadata.acp.configOptions` (D9 — config options are the only
 * model/effort/mode surface), with a modes-only fallback single select when
 * the agent offers modes without config options.
 *
 * Shown instead of ModelControls' OpenCode pickers for ACP sessions and ACP
 * drafts. For a live session the selects read `metadata.acp` and write
 * through the config route; a change applies on the next turn. For a draft
 * (no session yet) they read the backend's config cache and stage values in
 * the draft, reconciled onto the session after create (see
 * `materializeOpenDraftSession`). An invalid value answers with the agent's
 * message as a toast.
 *
 * Two variants: desktop selects in the composer footer, and a compact mobile
 * row that opens the same options in a bottom sheet.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { acpClient, readAcpSessionMeta, type AcpConfigOption } from '@/lib/acp/client';
import { isAcpSessionId } from '@/lib/acp/session-key';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSession } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSessionSelection } from '../chatColumnSession';

/** A select the controls render: one per config option, or the modes fallback. */
type ControlOption = {
    /** Config option id, or `mode` for the modes fallback (routed to `set_mode` server-side). */
    configId: string;
    label: string;
    current: string | undefined;
    values: Array<{ id: string; name: string; description?: string }>;
};

const optionLabel = (option: AcpConfigOption): string => option.name?.trim() || option.id;

const valueName = (value: { id: string; name?: string }): string => value.name?.trim() || value.id;

/**
 * The selects for a live session: one per config option with offered values.
 * Options without a value list (free text/number/boolean) have no select —
 * there is nothing to pick from. The modes fallback applies only when the
 * agent offers no config options at all (matching the server's set_mode
 * dispatch, which requires `configOptions.length === 0`): an agent with an
 * opaque option plus modes gets its (empty) option controls, not a mode
 * selector the server route would refuse as a config id.
 */
const controlsForMeta = (
    configOptions: AcpConfigOption[],
    modes: Array<{ id: string; name?: string; current?: boolean }>,
): ControlOption[] => {
    if (configOptions.length > 0) {
        return configOptions
            .filter((option) => Array.isArray(option.options) && option.options.length > 0)
            .map((option) => ({
                configId: option.id,
                label: optionLabel(option),
                current: option.current === undefined || option.current === null ? undefined : String(option.current),
                values: (option.options ?? []).map((value) => ({ id: value.id, name: valueName(value) })),
            }));
    }
    if (modes.length === 0) return [];
    return [{
        configId: 'mode',
        label: 'Mode',
        current: modes.find((mode) => mode.current)?.id,
        values: modes.map((mode) => ({ id: mode.id, name: mode.name?.trim() || mode.id })),
    }];
};

const useLiveControls = (sessionId: string | null, directory: string | null): ControlOption[] => {
    const session = useSession(sessionId ?? '', directory ?? undefined);
    return React.useMemo(() => {
        if (!sessionId || !isAcpSessionId(sessionId)) return [];
        const meta = readAcpSessionMeta(session);
        if (!meta) return [];
        return controlsForMeta(meta.configOptions, meta.modes);
    }, [session, sessionId]);
};

const useDraftControls = (backendId: string | null): { controls: ControlOption[]; loaded: boolean } => {
    // The cache is keyed by backend: while a switch to a new backend is
    // pending, the old backend's values must neither render nor stage.
    const [cached, setCached] = React.useState<{ backendId: string; options: AcpConfigOption[] } | null>(null);
    React.useEffect(() => {
        if (!backendId) {
            setCached(null);
            return;
        }
        let cancelled = false;
        acpClient.getBackendConfigCache(backendId).then(
            (options) => { if (!cancelled) setCached({ backendId, options }); },
            () => { if (!cancelled) setCached({ backendId, options: [] }); },
        );
        return () => { cancelled = true; };
    }, [backendId]);
    return React.useMemo(() => {
        if (!backendId || cached === null || cached.backendId !== backendId) {
            return { controls: [], loaded: false };
        }
        return { controls: controlsForMeta(cached.options, []), loaded: true };
    }, [backendId, cached]);
};

type Props = {
    className?: string;
    /** Compact row for the mobile composer (opens a bottom sheet); default is footer selects. */
    variant?: 'desktop' | 'mobile';
    /** Explicit session (footer/mobile row pass the composer's own); falls back to the column selection. */
    sessionId?: string | null;
    directory?: string | null;
};

const SELECT_TRIGGER_CLASS = 'h-7 min-w-0 w-fit max-w-[48vw] border-transparent bg-transparent px-1.5 hover:[background-image:none] data-[popup-open]:[background-image:none] sm:max-w-[20rem]';

export const AcpSessionControls: React.FC<Props> = ({ className, variant = 'desktop', sessionId: sessionIdProp, directory: directoryProp }) => {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    // The column's session, not the live store value: a pinned column (or a
    // URL-opened session) shows its own session while the store lags or
    // points elsewhere (see chatColumnSession.ts). Callers pass the
    // composer's own session explicitly, which wins when defined.
    const column = useChatSessionSelection();
    const sessionId = sessionIdProp !== undefined ? sessionIdProp : column.sessionId;
    const directory = directoryProp !== undefined ? directoryProp : column.directory;
    const draftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
    const draftBackendId = useSessionUIStore((state) => state.newSessionDraft.acpBackendId ?? null);
    const draftConfig = useSessionUIStore((state) => state.newSessionDraft.acpConfig ?? null);
    const setDraftAcpConfig = useSessionUIStore((state) => state.setDraftAcpConfig);

    const isDraft = !sessionId && draftOpen && draftBackendId !== null;
    const liveControls = useLiveControls(isDraft ? null : sessionId, directory);
    const { controls: draftControls, loaded: draftLoaded } = useDraftControls(isDraft ? draftBackendId : null);
    const controls = isDraft ? draftControls : liveControls;

    const [pending, setPending] = React.useState<string | null>(null);
    const [sheetOpen, setSheetOpen] = React.useState(false);

    const changeLive = React.useCallback(async (configId: string, value: string) => {
        if (!sessionId) return;
        setPending(configId);
        try {
            await acpClient.setSessionConfig(sessionId, configId, value, directory);
        } catch (error) {
            // The agent rejected the value: surface its message, keep the old one.
            const message = error instanceof Error ? error.message.replace(/^[a-z0-9_.]+\s+failed\s*\(\d+\):\s*/i, '') : '';
            toast.error(t('chat.acpSessionControls.changeFailed'), { description: message || undefined });
        } finally {
            setPending((current) => (current === configId ? null : current));
        }
    }, [directory, sessionId, t]);

    const changeDraft = React.useCallback((configId: string, value: string) => {
        setDraftAcpConfig(configId, value);
    }, [setDraftAcpConfig]);

    const currentOf = React.useCallback((control: ControlOption): string | undefined => {
        if (isDraft) {
            const staged = draftConfig?.[control.configId];
            if (staged !== undefined) return String(staged);
        }
        return control.current;
    }, [draftConfig, isDraft]);

    const change = isDraft ? changeDraft : changeLive;

    if (!isDraft && (!sessionId || !isAcpSessionId(sessionId))) return null;
    if (isDraft && !draftLoaded) return null;
    if (controls.length === 0) return null;

    if (variant === 'mobile' || isMobile) {
        const summary = controls
            .map((control) => {
                const current = currentOf(control);
                const named = control.values.find((value) => value.id === current);
                return named?.name ?? current ?? null;
            })
            .filter((label): label is string => label !== null)
            .join(' · ');
        return (
            <>
                <button
                    type="button"
                    onClick={() => setSheetOpen(true)}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerDownCapture={(event) => {
                        if (event.pointerType === 'touch') event.preventDefault();
                    }}
                    className={cn(
                        'inline-flex h-[26px] min-h-0 min-w-0 items-stretch rounded-lg',
                        'typography-micro font-medium text-foreground/80',
                        'focus:outline-none hover:bg-[var(--interactive-hover)]',
                        className,
                    )}
                    title={summary || undefined}
                    aria-label={t('chat.acpSessionControls.openLabel')}
                >
                    <span className="flex h-full w-full min-w-0 items-center gap-1">
                        <Icon name="settings-3" className="size-4 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate">{summary || t('chat.acpSessionControls.openLabel')}</span>
                    </span>
                </button>
                <MobileOverlayPanel
                    open={sheetOpen}
                    onClose={() => setSheetOpen(false)}
                    title={t('chat.acpSessionControls.sheetTitle')}
                >
                    <div className="flex flex-col gap-3">
                        {controls.map((control) => {
                            const current = currentOf(control);
                            const groupId = `acp-config-${control.configId}`;
                            return (
                                <div key={control.configId} role="radiogroup" aria-labelledby={`${groupId}-label`}>
                                    <div id={`${groupId}-label`} className="typography-meta mb-1 font-medium text-muted-foreground">{control.label}</div>
                                    <div className="flex flex-col gap-1.5">
                                        {control.values.map((value) => {
                                            const selected = current === value.id;
                                            return (
                                                <button
                                                    key={value.id}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={selected}
                                                    disabled={pending === control.configId}
                                                    className={cn(
                                                        'flex w-full items-center justify-between gap-2 rounded-xl border px-2 py-1.5 text-left',
                                                        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                                        selected ? 'border-border bg-interactive-selection text-interactive-selection-foreground' : 'border-border/40',
                                                    )}
                                                    onClick={() => { void change(control.configId, value.id); }}
                                                >
                                                    <span className="typography-meta min-w-0 truncate font-medium text-inherit">{value.name}</span>
                                                    {selected && <Icon name="check" className="size-4 flex-shrink-0 text-inherit" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </MobileOverlayPanel>
            </>
        );
    }

    return (
        <div className={cn('flex min-w-0 items-center justify-end gap-x-2', className)}>
            {controls.map((control) => (
                <Select
                    key={control.configId}
                    value={currentOf(control) ?? ''}
                    onValueChange={(value) => { void change(control.configId, value); }}
                    disabled={pending === control.configId}
                    disableGlobalShortcuts
                >
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <SelectTrigger
                                size="sm"
                                aria-label={control.label}
                                className={SELECT_TRIGGER_CLASS}
                            >
                                <SelectValue>{(() => {
                                    const current = currentOf(control);
                                    return control.values.find((value) => value.id === current)?.name ?? current ?? control.label;
                                })()}</SelectValue>
                            </SelectTrigger>
                        </TooltipTrigger>
                        <TooltipContent showArrow side="top" sideOffset={8}>
                            {control.label}
                        </TooltipContent>
                    </Tooltip>
                    <SelectContent side="bottom" align="end" sideOffset={4} collisionAvoidance={{ side: 'none' }} constrainToMain className="w-max min-w-48">
                        {control.values.map((value) => (
                            <SelectItem key={value.id} value={value.id} showSelectedBackground={false} className="max-w-[24rem] truncate">
                                {value.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ))}
        </div>
    );
};
