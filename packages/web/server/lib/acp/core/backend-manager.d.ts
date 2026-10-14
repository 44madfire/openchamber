import type { EventEmitter } from 'node:events';
import type { AgentCapabilities, AuthMethod, Implementation } from '@agentclientprotocol/sdk';

import type { AcpConnectedAgent, AcpConnectionHooks, connectAcpAgent } from './connection.js';
import type { AcpBackendEntry, AcpBackendRegistry } from './registry.js';
import type { AcpSpawnedAgent } from './spawn.js';

export declare const DEFAULT_IDLE_REAP_MS: number;

export declare class AcpBackendError extends Error {
  code?: string;
  backendId?: string;
  constructor(message: string, options?: { code?: string; backendId?: string; cause?: unknown });
}

export type AcpBackendState = 'unconfigured' | 'idle' | 'starting' | 'ready' | 'error';

export interface AcpBackendStatus {
  id: string;
  state: AcpBackendState;
  protocolVersion: number | null;
  agentInfo: Implementation | null;
  agentCapabilities: AgentCapabilities | null;
  authMethods: AuthMethod[];
  lastError: string | null;
  stderrTail: string;
}

export interface AcpBackendLease {
  connection: AcpConnectedAgent;
  release(): void;
}

export interface AcpConnectInfo {
  backendId: string;
  protocolVersion: number;
  agentInfo: Implementation | null;
}

export interface AcpBackendManager {
  events: EventEmitter;
  ensureReady(backendId: string): Promise<AcpConnectedAgent>;
  acquire(backendId: string): Promise<AcpBackendLease>;
  restart(backendId: string): Promise<AcpBackendStatus>;
  authenticate(backendId: string, methodId: string): Promise<AcpBackendStatus>;
  status(backendId: string): Promise<AcpBackendStatus>;
  listStatuses(): Promise<Array<{ entry: AcpBackendEntry } & AcpBackendStatus>>;
  shutdown(): Promise<void>;
  stop(backendId: string): Promise<void>;
}

export declare function createAcpBackendManager(options?: {
  registry: AcpBackendRegistry;
  spawnAgent?: (options: { command: string; args: string[]; env?: Record<string, string> }) => AcpSpawnedAgent;
  connectAgent?: typeof connectAcpAgent;
  idleReapMs?: number;
  now?: () => number;
  connectionHooks?: AcpConnectionHooks | ((backendId: string, generation: number) => AcpConnectionHooks);
  timeouts?: { earlyExitMs?: number; initializeMs?: number };
  clientInfo?: { name?: string; version?: string };
  onConnect?: (info: AcpConnectInfo) => void;
  stderrFlushMs?: number;
}): AcpBackendManager;
