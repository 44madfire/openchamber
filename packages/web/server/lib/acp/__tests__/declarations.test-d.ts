/**
 * Strict declaration consumer: compiled with skipLibCheck false (see the
 * `type-check:acp` script), so the ACP .d.ts files must be valid on their
 * own — the workspace tsconfig's skipLibCheck would otherwise hide broken
 * declaration imports.
 */
import type { ClientSideConnection } from '@agentclientprotocol/sdk';

import type { AcpBackendManager, AcpBackendStatus } from '../core/backend-manager.js';
import type { AcpConnectedAgent } from '../core/connection.js';
import type { AcpProjector, AcpSyncEvent } from '../core/projector.js';
import type { AcpBackendEntry, AcpBackendRegistry } from '../core/registry.js';
import type { AcpSessionEntry, AcpSessionIndex } from '../core/session-index.js';
import type { AcpSessionRecord, AcpSessionService } from '../core/sessions.js';
import type { AcpSession, AcpSyncFrame } from '../http/routes.js';
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

export async function exerciseAcpSessionDeclarations(
  service: AcpSessionService,
  index: AcpSessionIndex,
  projector: AcpProjector,
): Promise<{ session: AcpSession; record: AcpSessionRecord; entry: AcpSessionEntry; frame: AcpSyncFrame }> {
  const created = await service.create({ backendId: 'fake', directory: 'C:\\work' });
  const record: AcpSessionRecord = created.session;
  const listed: AcpSessionRecord[] = await service.list({ directory: 'C:\\work' });
  void listed;
  const page = await service.messages({ key: record.id, limit: 10 });
  void page.cursor.next;
  const promptEvents: AcpSyncEvent[] = await service.prompt({
    key: record.id,
    messageId: 'msg_1',
    parts: [{ type: 'text', text: 'hi' }],
  });
  void promptEvents;
  const cancelled: boolean = await service.cancel({ key: record.id });
  void cancelled;
  await service.config({ key: record.id, configId: 'model', value: 'm1' });
  const renamed = await service.rename({ key: record.id, title: 't' });
  void renamed.session.time.updated;
  const statuses = await service.status({ directory: 'C:\\work' });
  void statuses;
  const live = service.getLive(record.id);
  void live?.projector.busy;
  service.dispose();
  const entry: AcpSessionEntry = (await index.get(record.id)) ?? {
    key: 'k', backendId: 'b', nativeId: 'n', cwd: 'c', title: '', created: 0, updated: 0,
  };
  void (await index.listByDirectory('c'));
  const session: AcpSession = {
    id: entry.key,
    projectID: 'acp:b',
    directory: entry.cwd,
    title: entry.title,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  };
  void projector.page({ limit: 1 }).items;
  const frame: AcpSyncFrame = {
    type: 'openchamber:acp-sync',
    properties: { directory: 'C:\\work', events: [{ type: 'session.idle', properties: { sessionID: 's' } }] },
  };
  return { session, record, entry, frame };
}
