import type { Message, Part, SyntheticMessage, UserMessage } from '@/lib/opencode/model';
import { acpRevertedFromTurnOf, resolveRevertBoundaryMessageID } from '@/lib/acp/revert';
import { readSubagentRun } from '@/lib/opencode/subagent-run';
import type { State } from '@/sync/types';
import { findMessageIndex } from '@/sync/message-ordering';

type RevertedMessageRecord = {
    /** A prompt, or a background subagent run report (it stands where a prompt would). */
    message: UserMessage | SyntheticMessage;
    parts: Part[];
};

export type RevertedMessageDockState = {
    revertMessageID?: string;
    records: RevertedMessageRecord[];
};

const EMPTY_PARTS: Part[] = [];
const EMPTY_REVERTED_RECORDS: RevertedMessageRecord[] = [];

export const EMPTY_REVERTED_MESSAGE_DOCK_STATE: RevertedMessageDockState = {
    revertMessageID: undefined,
    records: EMPTY_REVERTED_RECORDS,
};

const isRevertedEntry = (message: Message): message is UserMessage | SyntheticMessage => {
    return message.role === 'user' || readSubagentRun(message) !== undefined;
};

const areRecordsEqual = (left: RevertedMessageRecord[], right: RevertedMessageRecord[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index]?.message !== right[index]?.message || left[index]?.parts !== right[index]?.parts) {
            return false;
        }
    }
    return true;
};

export const buildRevertedMessageDockState = (
    state: Pick<State, 'session' | 'message' | 'part'>,
    sessionId: string | null,
    previous: RevertedMessageDockState = EMPTY_REVERTED_MESSAGE_DOCK_STATE,
): RevertedMessageDockState => {
    if (!sessionId) {
        return EMPTY_REVERTED_MESSAGE_DOCK_STATE;
    }

    const session = state.session.find((item) => item.id === sessionId);
    const messages = state.message[sessionId] ?? [];
    // The server stamps the boundary with the turn's client-minted id, which
    // the transcript does not always carry; ACP sessions fall back to the
    // first message stamped at or after `revertedFromTurn`.
    const revertMessageID = resolveRevertBoundaryMessageID(
        messages,
        session?.revert?.messageID,
        session ? acpRevertedFromTurnOf(session) : null,
    );
    if (!revertMessageID) {
        return EMPTY_REVERTED_MESSAGE_DOCK_STATE;
    }

    const revertIndex = findMessageIndex(messages, revertMessageID);
    if (revertIndex < 0) {
        return EMPTY_REVERTED_MESSAGE_DOCK_STATE;
    }
    const records: RevertedMessageRecord[] = [];
    for (let index = revertIndex; index < messages.length; index += 1) {
        const message = messages[index];
        if (!isRevertedEntry(message)) {
            continue;
        }
        records.push({
            message,
            parts: state.part[message.id] ?? EMPTY_PARTS,
        });
    }

    const next = records.length === 0 ? EMPTY_REVERTED_RECORDS : records;
    if (previous.revertMessageID === revertMessageID && areRecordsEqual(previous.records, next)) {
        return previous;
    }

    return {
        revertMessageID,
        records: next,
    };
};
