import type { AuthMethod } from '@agentclientprotocol/sdk';

import type { AcpBackendEntry } from './registry.js';

/** A resolved spawn target: what the terminal panel must launch. */
export interface AcpResolvedInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export declare function resolveAuthTerminalInvocation(
  entry: AcpBackendEntry,
  method: AuthMethod,
): AcpResolvedInvocation;
