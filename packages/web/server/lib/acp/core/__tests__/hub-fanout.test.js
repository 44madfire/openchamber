import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createGlobalMessageStreamHub } from '../../../event-stream/global-hub.js';
import { createAcpBackendManager } from '../backend-manager.js';
import { createAcpBackendRegistry } from '../registry.js';
import { createAcpSessionIndex } from '../session-index.js';
import { createAcpSessionService } from '../sessions.js';
import { normalizeDirectory } from '../directory-key.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

describe('acp hub fan-out', () => {
  it('publishes sync frames to hub subscribers with replay', async () => {
    const registry = createAcpBackendRegistry({
      dataDir: await mkdtemp(join(tmpdir(), 'acp-hub-reg-')),
      resolveCommand: () => null,
    });
    await registry.save([{
      id: 'fake', label: 'fake', command: process.execPath, args: [FAKE_AGENT], enabled: true,
      env: {
        FAKE_ACP_PROMPT_SCRIPT: JSON.stringify([
          { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hub-hi' } } },
        ]),
      },
    }]);
    const { spawnAcpAgent } = await import('../spawn.js');
    const holder = { current: null };
    const manager = createAcpBackendManager({
      registry,
      spawnAgent: (options) => spawnAcpAgent({ ...options, registerProcess: () => {}, unregisterProcess: () => {} }),
      stderrFlushMs: 10,
      connectionHooks: (backendId, generation) => holder.current?.hooksForBackend(backendId, generation) ?? {},
    });
    const service = createAcpSessionService({ canonicalDirectory: async (d) => normalizeDirectory(d),
      manager,
      index: createAcpSessionIndex({ dataDir: await mkdtemp(join(tmpdir(), 'acp-hub-idx-')) }),
      registry,
      settleMs: 5,
    });
    holder.current = service;

    // The production binding (feature-routes-runtime `publishSyncFrame`).
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: () => { throw new Error('no upstream in this test'); },
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 60_000,
      deltaCoalesceWindowMs: 0,
    });
    service.events.on('sync', ({ directory, events }) => {
      hub.injectEvent({ payload: { type: 'openchamber:acp-sync', properties: { directory, events } }, directory });
    });
    const seen = [];
    hub.subscribeEvent((event) => seen.push(event));

    try {
      const { session } = await service.create({ backendId: 'fake', directory: 'C:\\work' });
      await service.prompt({ key: session.id, messageId: 'msg_1', parts: [{ type: 'text', text: 'x' }] });
      const start = Date.now();
      while (!seen.some((event) => event.payload.properties.events.some((e) => e.type === 'session.idle'))) {
        if (Date.now() - start > 8000) throw new Error('timed out waiting for idle frame');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      hub.flushPending();

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((event) => event.payload.type === 'openchamber:acp-sync')).toBe(true);
      expect(seen.every((event) => event.directory === 'C:\\work')).toBe(true);
      // WS serialization carries the frame intact.
      const serialized = JSON.parse(seen[0].serialize());
      expect(serialized.type).toBe('event');
      expect(serialized.payload.type).toBe('openchamber:acp-sync');
      expect(serialized.directory).toBe('C:\\work');
      // Replay by cursor returns the suffix after it.
      const replayed = hub.replayAfter(seen[0].eventId);
      expect(replayed).not.toBeNull();
      expect(replayed.map((entry) => entry.eventId)).toEqual(seen.slice(1).map((event) => event.eventId));
      expect(hub.replayAfter(seen.at(-1).eventId)).toEqual([]);
    } finally {
      service.dispose();
      await manager.shutdown();
      hub.stop();
    }
  });
});
