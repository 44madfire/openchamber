import type { EventEmitter } from 'node:events';

import type { AcpBackendManager } from './backend-manager.js';
import type { AcpConnectionHooks } from './connection.js';
import type { AcpProjector, AcpSyncEvent } from './projector.js';
import type { AcpBackendRegistry } from './registry.js';
import type { AcpSessionIndex } from './session-index.js';

export declare const POST_CANCEL_SETTLE_MS: number;
export declare const POST_CANCEL_WATCHDOG_MS: number;
export declare const MAX_LIST_PAGES: number;
export declare const DEFAULT_MAX_INACTIVE_PROJECTIONS: number;
export declare const DEFAULT_IDLE_EVICT_MS: number;

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
  config(options: { key: string; configId: string; value: string | number | boolean }): Promise<void>;
  delete(options: { key: string }): Promise<boolean>;
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
  now?: () => number;
  settleMs?: number;
  watchdogMs?: number;
  maxInactiveProjections?: number;
  idleEvictMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): AcpSessionService;
