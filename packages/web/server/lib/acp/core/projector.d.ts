import type { SessionNotification } from '@agentclientprotocol/sdk';

export declare const MAX_RAW_BYTES: number;
export declare const MAX_RETAINED_TEXT: number;

export declare function resolveToolName(update: {
  kind?: string | null;
  name?: string | null;
  content?: Array<{ type?: string; oldText?: string | null }> | null;
} | null | undefined): string;

export declare function diffToFileEntry(item: {
  path?: string;
  oldText?: string | null;
  newText?: string | null;
} | null | undefined, label?: {
  file?: string;
  additions?: number;
  deletions?: number;
  status?: string;
} | null): {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
};

export declare function matchRawFileLabel(
  typedItem: { path?: string } | null | undefined,
  rawFiles: unknown,
): { file?: string; patch?: string; additions?: number; deletions?: number; status?: string } | null;

export declare function cappedToolInput(rawInput: unknown): Record<string, unknown>;

export declare function sessionTagFor(key: string): string;

export interface AcpProjectorSession {
  id: string;
  projectID: string;
  directory: string;
  title: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time: { created: number; updated: number; idle?: number };
  metadata: Record<string, unknown>;
}

export interface AcpSyncEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface AcpProjector {
  readonly key: string;
  readonly status: { type: string; [key: string]: unknown };
  readonly busy: boolean;
  readonly commands: Array<{ name: string; description: string }>;
  session(): AcpProjectorSession;
  seed(response: { configOptions?: unknown; modes?: unknown } | null | undefined, capabilities?: unknown): void;
  setUserTitle(userTitle: string | undefined): void;
  acceptPrompt(messageId: string, parts: Array<{ type: string; text?: string; url?: string; mime?: string; filename?: string }>): AcpSyncEvent[];
  applyUpdate(notification: SessionNotification, options?: { replay?: boolean }): AcpSyncEvent[];
  applyPromptResult(result: { stopReason?: string } | null | undefined, flags?: { cancelledByUs?: boolean; declinedInTurn?: boolean }): AcpSyncEvent[];
  applyPromptError(error: { message?: string; code?: unknown } | null | undefined): AcpSyncEvent[];
  applyTerminalError(error: { message?: string; code?: unknown } | null | undefined): AcpSyncEvent[];
  applyBackendExit(exit: { code: number | null; signal: string | null } | null | undefined): AcpSyncEvent[];
  beginReplay(): void;
  rollbackReplay(): void;
  endReplay(): AcpSyncEvent[];
  page(options?: { limit?: number; before?: string }): {
    items: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
    cursor: { previous?: string; next?: string };
  };
  transcriptIds(): string[];
}

export declare function createSessionProjector(options: {
  key: string;
  backendId: string;
  directory: string;
  index?: { title?: string; userTitle?: string; messageIds?: string[] } | null;
  now?: () => number;
}): AcpProjector;
