import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

import type { AcpBackendManager } from './backend-manager.js';
import type { AcpBackendRegistry } from './registry.js';
import type { AcpSessionIndex } from './session-index.js';

export declare const DEFAULT_ONEOFF_TIMEOUT_MS: number;
export declare const DEFAULT_ONEOFF_MAX_CHARS: number;
export declare const ONEOFF_TMP_PREFIX: string;
export declare const ONEOFF_CLEANUP_TIMEOUT_MS: number;
export declare const ONEOFF_CANCEL_SETTLE_MS: number;

export declare class AcpOneOffError extends Error {
  code?: string;
  backendId?: string;
  constructor(message: string, options?: { code?: string; backendId?: string; cause?: unknown });
}

export type AcpOneOffCleanup = 'deleted' | 'closed' | 'left';

export interface AcpOneOffUsage {
  totalTokens?: number;
  contextSize?: number;
}

export interface AcpOneOffCost {
  amount: number;
  currency: string;
}

export interface AcpOneOffResult {
  text: string;
  usage?: AcpOneOffUsage;
  cost?: AcpOneOffCost;
  warnings?: string[];
  sessionCleanup: AcpOneOffCleanup;
}

export interface AcpOneOffGenerateOptions {
  backendId: string;
  instruction: string;
  input: string;
  maxChars?: number;
}

export interface AcpOneOffHooksOptions {
  /**
   * Reports whether a session id belongs to the host's indexed (normal)
   * session set. Disambiguates the session/new creation window: unknown
   * ids arriving while creation is in flight are the throwaway's own
   * setup traffic and are claimed; known ids always pass through.
   */
  isKnownSession?: ((sessionId: string) => boolean) | null;
}

/**
 * Agent→client hooks for one-off sessions, composed by the host into the
 * manager's `connectionHooks` factory alongside the session service's
 * hooks (one-off first). The update hook returns true when the update
 * belonged to a throwaway session (the host swallows it) and false when
 * it must reach the session router. The permission/elicitation hooks
 * return a decline for one-off sessions, or null when the request
 * belongs to a normal session and must reach the session router.
 */
export interface AcpOneOffHooks {
  onSessionUpdate(params: SessionNotification): boolean;
  onRequestPermission(params: RequestPermissionRequest): RequestPermissionResponse | null;
  onElicitation(params: CreateElicitationRequest): CreateElicitationResponse | null;
}

export interface AcpOneOffService {
  generate(options: AcpOneOffGenerateOptions): Promise<AcpOneOffResult>;
  resolveBackend(options?: { backendId?: string | null; sessionKey?: string | null }): Promise<string>;
  hooksForOneOff(backendId: string, options?: AcpOneOffHooksOptions): AcpOneOffHooks;
  trimOneOffOutput(raw: string, maxChars?: number): string;
}

export declare function trimOneOffOutput(raw: string, maxChars?: number): string;

export declare function createOneOff(options?: {
  manager: AcpBackendManager;
  registry: AcpBackendRegistry;
  index?: AcpSessionIndex | null;
  tmpRoot?: string | null;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  cancelSettleMs?: number;
}): AcpOneOffService;
