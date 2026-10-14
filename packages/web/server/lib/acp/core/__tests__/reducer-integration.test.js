import { describe, expect, it } from 'vitest';

import { applyDirectoryEvent } from '@/sync/event-reducer';
import { INITIAL_STATE } from '@/sync/types';

import { createSessionProjector } from '../projector.js';

const freshStore = () => structuredClone(INITIAL_STATE);

const feed = (store, events) => {
  for (const event of events) applyDirectoryEvent(store, event);
};

const projectorFor = (key, backendId = 'omp') => createSessionProjector({
  key,
  backendId,
  directory: 'C:\\work',
  now: (() => { let t = 1000; return () => t++; })(),
});

const turnWithChunks = (projector, messageId, chunks) => {
  const events = [...projector.acceptPrompt(messageId, [{ type: 'text', text: 'q' }])];
  for (const [index, text] of chunks.entries()) {
    events.push(...projector.applyUpdate({
      sessionId: 'n',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: `agent-${messageId}-${index}`,
        content: { type: 'text', text },
      },
    }));
  }
  events.push(...projector.applyPromptResult({ stopReason: 'end_turn' }));
  return events;
};

describe('acp projector through the real UI reducer', () => {
  it('keeps two sessions independent (no cross-session id collision)', () => {
    const store = freshStore();
    const a = projectorFor('ses_acp-omp_ra');
    const b = projectorFor('ses_acp-omp_rb');
    feed(store, [{ type: 'session.created', properties: { info: a.session() } }]);
    feed(store, [{ type: 'session.created', properties: { info: b.session() } }]);
    feed(store, turnWithChunks(a, 'msg_a1', ['alpha-text']));
    feed(store, turnWithChunks(b, 'msg_b1', ['beta-text']));

    const messagesA = store.message['ses_acp-omp_ra'];
    const messagesB = store.message['ses_acp-omp_rb'];
    expect(messagesA.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messagesB.map((message) => message.role)).toEqual(['user', 'assistant']);
    const assistantA = messagesA[1];
    const assistantB = messagesB[1];
    expect(assistantA.id).not.toBe(assistantB.id);
    expect(store.part[assistantA.id][0].text).toBe('alpha-text');
    expect(store.part[assistantB.id][0].text).toBe('beta-text');
  });

  it('model/mode announcements never replace the assistant', () => {
    const store = freshStore();
    const projector = projectorFor('ses_acp-omp_ra');
    feed(store, [{ type: 'session.created', properties: { info: projector.session() } }]);
    feed(store, turnWithChunks(projector, 'msg_1', ['answer']));
    projector.seed({ configOptions: [{ id: 'model', currentValue: 'm1' }] }, {});
    feed(store, projector.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'm2' }] },
    }));
    const messages = store.message['ses_acp-omp_ra'];
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'model-switched']);
    expect(messages[1].role).toBe('assistant');
    expect(new Set(messages.map((message) => message.id)).size).toBe(3);
  });

  it('warm replay replaces the live transcript with the canonical one', () => {
    const store = freshStore();
    const projector = projectorFor('ses_acp-opencode_rses_live');
    feed(store, [{ type: 'session.created', properties: { info: projector.session() } }]);
    feed(store, turnWithChunks(projector, 'msg_client-1', ['hel', 'lo']));
    expect(store.message['ses_acp-opencode_rses_live']).toHaveLength(2);

    // Sidebar re-click: the service buffers the replay, then publishes the
    // replacement (removed prefix + canonical events) as one batch.
    projector.beginReplay();
    const replayed = [];
    replayed.push(...projector.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'user_message_chunk', messageId: 'user-agent-1', content: { type: 'text', text: 'q' } },
    }, { replay: true }));
    replayed.push(...projector.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'agent-msg-0', content: { type: 'text', text: 'hel' } },
    }, { replay: true }));
    replayed.push(...projector.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'agent-msg-0', content: { type: 'text', text: 'lo' } },
    }, { replay: true }));
    feed(store, [...projector.endReplay(), ...replayed]);

    const messages = store.message['ses_acp-opencode_rses_live'];
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0].parts ?? null).toBeNull();
    expect(store.part[messages[1].id].map((part) => part.text).join('')).toBe('hello');
    // Canonical ids: turn 1, blocks 00/01.
    expect(messages[0].id).toMatch(/-t0001-00$/);
    expect(messages[1].id).toMatch(/-t0001-01$/);
  });

  it('repeated id-less replay yields identical canonical transcripts', () => {
    const replayStream = (projector) => {
      projector.beginReplay();
      const events = [];
      for (const [kind, text] of [
        ['user_message_chunk', 'q1'],
        ['agent_message_chunk', 'a1'],
        ['user_message_chunk', 'q2'],
        ['agent_message_chunk', 'a2'],
      ]) {
        events.push(...projector.applyUpdate({
          sessionId: 'n',
          update: { sessionUpdate: kind, content: { type: 'text', text } },
        }, { replay: true }));
      }
      return [...projector.endReplay(), ...events];
    };
    const first = projectorFor('ses_acp-omp_ra');
    const store = freshStore();
    feed(store, [{ type: 'session.created', properties: { info: first.session() } }]);
    feed(store, replayStream(first));
    const idsFirst = store.message['ses_acp-omp_ra'].map((message) => message.id);
    expect(store.message['ses_acp-omp_ra'].map((message) => message.role)).toEqual(
      ['user', 'assistant', 'user', 'assistant']);
    // A second identical rebuild (reminted or id-less agents): same ids,
    // applied over the store: exact membership, no duplicates.
    feed(store, replayStream(first));
    expect(store.message['ses_acp-omp_ra'].map((message) => message.id)).toEqual(idsFirst);
    expect(idsFirst).toEqual([
      expect.stringMatching(/-t0001-00$/),
      expect.stringMatching(/-t0001-01$/),
      expect.stringMatching(/-t0002-00$/),
      expect.stringMatching(/-t0002-01$/),
    ]);
  });

  it('eviction then reopen rebuilds the canonical transcript from scratch', () => {
    const live = projectorFor('ses_acp-omp_ra');
    const store = freshStore();
    feed(store, [{ type: 'session.created', properties: { info: live.session() } }]);
    feed(store, turnWithChunks(live, 'msg_client-1', ['answer']));
    // Eviction persists the live ids to the sidecar; reopen builds a fresh
    // projector seeded with them, so the replacement still removes them.
    const persistedIds = live.transcriptIds();
    const rebuilt = createSessionProjector({
      key: 'ses_acp-omp_ra',
      backendId: 'omp',
      directory: 'C:\\work',
      index: { messageIds: persistedIds },
      now: (() => { let t = 1000; return () => t++; })(),
    });
    rebuilt.beginReplay();
    const replayed = [];
    replayed.push(...rebuilt.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' } },
    }, { replay: true }));
    replayed.push(...rebuilt.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
    }, { replay: true }));
    feed(store, [...rebuilt.endReplay(), ...replayed]);
    const messages = store.message['ses_acp-omp_ra'];
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0].id).toMatch(/-t0001-00$/);
    expect(store.part[messages[1].id][0].text).toBe('answer');
  });

  it('reload mid-turn keeps the in-progress message with no duplicate user', () => {
    const store = freshStore();
    const projector = projectorFor('ses_acp-omp_ra');
    feed(store, [{ type: 'session.created', properties: { info: projector.session() } }]);
    feed(store, projector.acceptPrompt('msg_client-9', [{ type: 'text', text: 'halfway' }]));
    feed(store, projector.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'agent-9', content: { type: 'text', text: 'partial' } },
    }));
    // Reload: the loader re-reads the page; the same events must not duplicate.
    const page = projector.page({ limit: 10 });
    expect(page.items).toHaveLength(2);
    feed(store, page.items.flatMap((item) => [
      { type: 'message.updated', properties: { info: item.info } },
      { type: 'message.parts.replaced', properties: { sessionID: item.info.sessionID, messageID: item.info.id, parts: item.parts } },
    ]));
    const messages = store.message['ses_acp-omp_ra'];
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(store.part[messages[1].id].map((part) => part.text).join('')).toBe('partial');
  });

  it('equal-millisecond transcripts keep chronological order', () => {
    const frozen = createSessionProjector({
      key: 'ses_acp-omp_ra',
      backendId: 'omp',
      directory: 'C:\\work',
      now: () => 1000,
    });
    const store = freshStore();
    feed(store, [{ type: 'session.created', properties: { info: frozen.session() } }]);
    for (let turn = 1; turn <= 12; turn += 1) {
      feed(store, turnWithChunks(frozen, `client-${turn}`, [`a${turn}`]));
    }
    const roles = store.message['ses_acp-omp_ra'].map((message) => message.role);
    expect(roles).toEqual(Array.from({ length: 12 }, () => ['user', 'assistant']).flat());
    const texts = store.message['ses_acp-omp_ra']
      .filter((message) => message.role === 'assistant')
      .map((message) => store.part[message.id][0].text);
    expect(texts).toEqual(Array.from({ length: 12 }, (_, index) => `a${index + 1}`));
  });
});
