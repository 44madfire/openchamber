import type { AcpBackendEntry } from './registry.js';

export declare const ACP_ENTERPRISE_ERROR: string;
export declare const ACP_ENTERPRISE_CODE: string;

export interface AcpEnterpriseDecision {
  allowed: boolean;
  env?: Record<string, string> | undefined;
  error?: string;
}

export declare function enterpriseDecisionForBackend(
  entry: AcpBackendEntry | null | undefined,
  options?: { policy?: { enterpriseMode?: boolean; acpBackends?: Array<{ id: string; command: string; args?: string[] }> | null } | null },
): AcpEnterpriseDecision;

export declare function isAcpEnterpriseGated(options?: unknown): boolean;

export declare class AcpEnterpriseError extends Error {
  code: string;
  backendId?: string;
  constructor(message?: string, options?: { backendId?: string; cause?: unknown });
}
