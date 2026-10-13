import type { EventEmitter } from 'node:events';

import type { AcpBackendManager } from './backend-manager.js';
import type { AcpConnectionHooks } from './connection.js';
import type { AcpProjector, AcpSyncEvent } from './projector.js';
import type { AcpBackendRegistry } from './registry.js';
import type { AcpSessionIndex } from './session-index.js';

export declare const POST_CANCEL_SETTLE_MS: number;
export declare const POST_CANCEL_WATCHDOG_MS: number;
export declare const MAX_LIST_PAGES: number;
export declare const CHECKPOINT_START_BUDGET_MS: number;
export declare const EMPTY_TREE_ID: string;
export declare const REVERT_NOTE_PREFIX: (turn: number) => string;

export declare class AcpSessionError extends Error {
  code?: string;
  constructor(message: string, options?: { code?: string; cause?: unknown });
}

export declare function normalizeDirectory(directory: string): string;
export declare function directoryKey(directory: string): string;

export interface AcpSessionRecord {
  id: string;
  parentID?: string;
  projectID: string;
  directory: string;
  title: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time: { created: number; updated: number; idle?: number };
  metadata?: Record<string, unknown>;
}
export interface AcpPromptInputPart {
  type: string;
  text?: string;
  url?: string;
  mime?: string;
  filename?: string;
}

/** One file of a turn diff (D14), in the DiffView `FileDiffInfo` shape. */
export interface AcpTurnDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
}

/** File restore outcome (D13) plus the session to continue in. */
export interface AcpRevertResult {
  restored: string[];
  removed: string[];
  skipped: Array<{ file: string; reason: string }>;
  session: AcpSessionRecord;
  events: AcpSyncEvent[];
}

export interface AcpSessionService {
  events: EventEmitter;
  hooksForBackend(backendId: string, generation?: number): AcpConnectionHooks;
  create(options: { backendId: string; directory: string; title?: string }): Promise<{ session: AcpSessionRecord; events: AcpSyncEvent[] }>;
  list(options: { directory: string }): Promise<AcpSessionRecord[]>;
  open(options: { key: string }): Promise<{ session: AcpSessionRecord; events: AcpSyncEvent[] }>;
  messages(options: { key: string; limit?: number; before?: string }): Promise<{
    items: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
    cursor: { previous?: string; next?: string };
  }>;
  message(options: { key: string; messageId: string }): Promise<{
    info: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  }>;
  prompt(options: { key: string; messageId: string; parts: AcpPromptInputPart[] }): Promise<AcpSyncEvent[]>;
  cancel(options: { key: string }): Promise<boolean>;
  checkpoints(options: { key: string }): Promise<Array<{ turn: number; complete: boolean }>>;
  diff(options: { key: string; turn: number }): Promise<AcpTurnDiff[]>;
  revert(options: { key: string; turn: number }): Promise<AcpRevertResult>;
  fork(options: { key: string }): Promise<{ session: AcpSessionRecord; events: AcpSyncEvent[] }>;
  hasNativeSession(backendId: string, nativeId: string): boolean;
  config(options: { key: string; configId: string; value: string | number | boolean }): Promise<void>;
  delete(options: { key: string }): Promise<boolean | { deleted: true; warning: string }>;
  rename(options: { key: string; title: string }): Promise<{ session: AcpSessionRecord; events: AcpSyncEvent[] }>;
  status(options: { directory: string }): Promise<Record<string, { type: string; [key: string]: unknown }>>;
  replyPermission(options: { key: string; requestId: string; reply: 'once' | 'always' | 'reject' }): Promise<{ events: AcpSyncEvent[] }>;
  getPermission(options: { key: string; requestId: string }): Promise<{ permission: Record<string, unknown> }>;
  listPendingPermissions(options: { directory: string }): Promise<Array<Record<string, unknown>>>;
  replyForm(options: { key: string; formId: string; answer: Record<string, unknown> }): Promise<{ events: AcpSyncEvent[] }>;
  cancelForm(options: { key: string; formId: string }): Promise<{ events: AcpSyncEvent[] }>;
  listPendingForms(options: { directory: string }): Promise<Array<Record<string, unknown>>>;
  commands(options: { key: string }): Promise<Array<{ name: string; description?: string }>>;
  configCache(options: { backendId: string }): Promise<unknown[]>;
  getLive(key: string): { projector: AcpProjector } | null;
  dispose(): void;
}

export declare function createAcpSessionService(options?: {
  manager: AcpBackendManager;
  index: AcpSessionIndex;
  registry?: AcpBackendRegistry | null;
  checkpoints?: AcpCheckpointStoreLike | null;
  checkpointStartBudgetMs?: number;
  now?: () => number;
  settleMs?: number;
  watchdogMs?: number;
  maxInactiveProjections?: number;
  idleEvictMs?: number;
  sleep?: (ms: number) => Promise<void>;
  createProjector?: (options: { key: string; backendId: string; directory: string; index?: unknown; now?: () => number }) => AcpProjector;
  canonicalDirectory?: (directory: string) => Promise<string>;
}): AcpSessionService;

/** The checkpoint-store surface the session service consumes (D12–D14). */
export interface AcpCheckpointStoreLike {
  snapshot(args: { cwd: string; sessionKey: string; turn: number; phase: 'start' | 'end' }): Promise<{ tree: string }>;
  diff(args: { cwd: string; from: string; to: string }): Promise<AcpTurnDiff[]>;
  restore(args: { cwd: string; tree: string; current?: string }): Promise<{
    restored: string[];
    removed: string[];
    skipped: Array<{ file: string; reason: string }>;
  }>;
  gc(args: { sessionKey: string; cwd?: string }): Promise<{ deletedRefs: number }>;
}
