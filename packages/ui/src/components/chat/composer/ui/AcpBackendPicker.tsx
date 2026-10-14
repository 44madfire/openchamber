/**
 * Which agent a new session runs on: the default OpenCode agent or a ready
 * ACP backend. Renders in the new-session draft next to the project/branch
 * selectors, and nothing at all when no ACP backend is ready (or the list
 * cannot be read) — OpenCode stays the only, default option.
 */

import React from 'react';

import { acpClient, type AcpBackendStatus } from '@/lib/acp/client';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const OPENCODE_VALUE = '';

export function AcpBackendPicker() {
    const { t } = useI18n();
    const draftOpen = useSessionUIStore((s) => s.newSessionDraft.open);
    const acpBackendId = useSessionUIStore((s) => s.newSessionDraft.acpBackendId ?? null);
    const setDraftAcpBackendId = useSessionUIStore((s) => s.setDraftAcpBackendId);
    const [backends, setBackends] = React.useState<AcpBackendStatus[] | null>(null);

    React.useEffect(() => {
        if (!draftOpen) return;
        let cancelled = false;
        acpClient.listBackends().then(
            (listed) => {
                // Backends spawn lazily (D7), so a usable backend is usually
                // idle until the first session starts it. Only broken or
                // disabled entries stay out of the picker.
                if (!cancelled) setBackends(listed.filter((backend) => backend.enabled !== false && backend.state !== 'error' && backend.state !== 'unconfigured'));
            },
            () => {
                if (!cancelled) setBackends([]);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [draftOpen]);

    React.useEffect(() => {
        // A chosen backend that is no longer listed falls back to OpenCode.
        if (backends && acpBackendId && !backends.some((backend) => backend.id === acpBackendId)) {
            setDraftAcpBackendId(null);
        }
    }, [acpBackendId, backends, setDraftAcpBackendId]);

    if (!draftOpen || !backends || backends.length === 0) return null;
    const selectedLabel = acpBackendId ? (backends.find((backend) => backend.id === acpBackendId)?.label || acpBackendId) : 'OpenCode';

    return (
        <Select
            value={acpBackendId ?? OPENCODE_VALUE}
            onValueChange={(value) => setDraftAcpBackendId(value === OPENCODE_VALUE ? null : value)}
            disableGlobalShortcuts
        >
            <Tooltip>
                <TooltipTrigger asChild>
                    <SelectTrigger
                        size="sm"
                        aria-label={t('chat.chatInput.draftPicker.agentLabel')}
                        className="h-7 min-w-0 w-fit max-w-[48vw] border-transparent bg-transparent px-1.5 hover:[background-image:none] data-[popup-open]:[background-image:none] sm:max-w-[20rem]"
                    >
                        <SelectValue>{selectedLabel}</SelectValue>
                    </SelectTrigger>
                </TooltipTrigger>
                <TooltipContent showArrow side="top" sideOffset={8}>
                    {t('chat.chatInput.draftPicker.agentLabel')}
                </TooltipContent>
            </Tooltip>
            <SelectContent side="bottom" align="start" sideOffset={4} collisionAvoidance={{ side: 'none' }} constrainToMain className="w-max min-w-48">
                <SelectItem value={OPENCODE_VALUE} showSelectedBackground={false} className="max-w-[24rem] truncate">
                    OpenCode
                </SelectItem>
                {backends.map((backend) => (
                    <SelectItem key={backend.id} value={backend.id} showSelectedBackground={false} className="max-w-[24rem] truncate">
                        {backend.label || backend.id}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
