import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type {
  AgentCapabilities,
  AuthMethod,
  ClientSideConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
  Implementation,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';

export declare const EARLY_EXIT_GUARD_MS: number;
export declare const INITIALIZE_TIMEOUT_MS: number;
export declare const CLIENT_CAPABILITIES: {
  readonly elicitation: { readonly form: Record<string, never> };
  readonly session: { readonly compaction: Record<string, never> };
  readonly _meta: { readonly 'opencode/child-session-updates': true };
};

export declare class AcpConnectionError extends Error {
  code?: string;
  constructor(message: string, options?: { code?: string; cause?: unknown });
}

export interface AcpConnectionHooks {
  onSessionUpdate?: (params: SessionNotification) => unknown;
  onRequestPermission?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
  onElicitation?: (params: CreateElicitationRequest) => Promise<CreateElicitationResponse> | CreateElicitationResponse;
  onUnknownNotification?: (method: string, params: Record<string, unknown>) => unknown;
}

export interface AcpConnectedAgent {
  connection: ClientSideConnection;
  events: EventEmitter;
  protocolVersion: number;
  agentCapabilities: AgentCapabilities | null;
  authMethods: AuthMethod[];
  agentInfo: Implementation | null;
  /** Manager-assigned connection generation (stamped at publish; absent on bare connections). */
  generation?: number;
  waitForExit(): Promise<{ code: number | null; signal: string | null }>;
  readonly exited: { code: number | null; signal: string | null } | null;
}

export declare function connectAcpAgent(options: {
  child: ChildProcess;
  getStderrTail?: () => string;
  clientName?: string;
  clientVersion?: string;
  hooks?: AcpConnectionHooks;
  timeouts?: { earlyExitMs?: number; initializeMs?: number };
}): Promise<AcpConnectedAgent>;
