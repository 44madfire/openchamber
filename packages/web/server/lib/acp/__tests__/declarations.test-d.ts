/**
 * Strict declaration consumer: compiled with skipLibCheck false (see the
 * `type-check:acp` script), so the ACP .d.ts files must be valid on their
 * own — the workspace tsconfig's skipLibCheck would otherwise hide broken
 * declaration imports.
 */
import type { ClientSideConnection } from '@agentclientprotocol/sdk';

import type { AcpBackendManager, AcpBackendStatus } from '../core/backend-manager.js';
import type { AcpConnectedAgent } from '../core/connection.js';
import type { AcpBackendEntry, AcpBackendRegistry } from '../core/registry.js';
import type { AcpSpawnedAgent } from '../core/spawn.js';

export async function exerciseAcpDeclarations(
  manager: AcpBackendManager,
  registry: AcpBackendRegistry,
): Promise<{ status: AcpBackendStatus; entry: AcpBackendEntry }> {
  const entries: AcpBackendEntry[] = await registry.list();
  const entry: AcpBackendEntry = entries[0] ?? {
    id: 'x',
    label: 'x',
    command: 'x',
    args: [],
    enabled: true,
  };
  const connected: AcpConnectedAgent = await manager.ensureReady(entry.id);
  const raw: ClientSideConnection = connected.connection;
  void raw;
  const lease = await manager.acquire(entry.id);
  lease.release();
  const status: AcpBackendStatus = await manager.status(entry.id);
  const spawned: AcpSpawnedAgent | null = null;
  void spawned;
  return { status, entry };
}
