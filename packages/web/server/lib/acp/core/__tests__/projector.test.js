import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createSessionProjector, diffToFileEntry, resolveToolName } from '../projector.js';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

const loadFixture = async (name) => {
  const text = await readFile(path.join(FIXTURES, name), 'utf8');
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
};

/** Feed a fixture turn: prompt accept, updates, then the `__result__` line. */
const runTurn = (projector, rows, messageId = 'msg_client-1') => {
  const events = [...projector.acceptPrompt(messageId, [{ type: 'text', text: 'hello' }])];
  let result = null;
  for (const row of rows) {
    if (row.sessionUpdate === '__result__') {
      const { sessionUpdate: _ignored, ...rest } = row;
      result = rest;
    } else {
      events.push(...projector.applyUpdate({ sessionId: 'native-1', update: row }));
    }
  }
  if (result) events.push(...projector.applyPromptResult(result));
  return events;
};

const runReplay = (projector, rows) => {
  projector.beginReplay();
  const events = [];
  for (const row of rows) {
    events.push(...projector.applyUpdate({ sessionId: 'native-1', update: row }, { replay: true }));
  }
  return events;
};

const projectorFor = (backendId = 'opencode') => createSessionProjector({
  key: `ses_acp-${backendId}_rnative-1`,
  backendId,
  directory: 'C:\\work',
  now: (() => { let t = 1000; return () => t++; })(),
});

describe('acp projector golden tests (recorded agent traffic)', () => {
  it('opencode trivial text: order invariants + final page', async () => {
    const rows = await loadFixture('opencode-text.ndjson');
    const projector = projectorFor('opencode');
    const events = runTurn(projector, rows);

    const types = events.map((event) => event.type);
    // Prompt accept first: user message, parts, busy.
    expect(types.slice(0, 3)).toEqual(['message.updated', 'message.parts.replaced', 'session.status']);
    // Assistant message before any part event.
    const assistantAt = types.indexOf('message.updated', 1);
    const firstPart = types.findIndex((type) => type === 'message.part.updated' || type === 'message.part.delta');
    expect(assistantAt).toBeGreaterThan(-1);
    expect(assistantAt).toBeLessThan(firstPart);
    // Turn settles last: patch, message patch, idle.
    expect(types.slice(-3)).toEqual(['message.patched', 'session.patched', 'session.idle']);
    expect(events.find((event) => event.type === 'catalog.updated')).toMatchObject({
      properties: { kind: 'command' },
    });

    const page = projector.page({ limit: 10 });
    expect(page.items.map((item) => item.info.role)).toEqual(['assistant', 'user']);
    expect(page.items[1].info.id).toBe('msg_client-1');
    expect(page.items[1].parts).toEqual([
      { id: 'msg_client-1:text:0', sessionID: page.items[1].info.sessionID, messageID: 'msg_client-1', type: 'text', text: 'hello' },
    ]);
    expect(page.items[0].parts).toHaveLength(1);
    expect(page.items[0].parts[0]).toMatchObject({ type: 'text', text: 'HELLO-OC2' });
    expect(page.items[0].info).toMatchObject({ finish: 'stop' });
    expect(projector.session()).toMatchObject({
      outcome: 'succeeded',
      cost: 0.00057186,
      tokens: { input: 0, output: 8890, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(projector.session().metadata.acp.contextSize).toBe(1000000);
    expect(projector.commands.map((command) => command.name)).toEqual(['init', 'review', 'compact']);
  });

  it('opencode edit: tool skeleton, diff files, name hint', async () => {
    const rows = await loadFixture('opencode-edit.ndjson');
    const projector = projectorFor('opencode');
    const events = runTurn(projector, rows);

    const assistantAt = events.findIndex((event, index) => index > 0 && event.type === 'message.updated');
    const firstTool = events.findIndex((event) => event.type === 'message.tool.transition');
    expect(assistantAt).toBeGreaterThan(-1);
    expect(assistantAt).toBeLessThan(firstTool);
    const transitions = events
      .filter((event) => event.type === 'message.tool.transition')
      .map((event) => event.properties.transition.kind);
    expect(transitions).toEqual(['called', 'success']);

    const page = projector.page({ limit: 10 });
    const tool = page.items[0].parts.find((part) => part.type === 'tool');
    expect(tool).toMatchObject({ callID: 'toolu_0179Q4aKvFhdJk1JFd1wHDkj', tool: 'edit', executed: true });
    expect(tool.state.status).toBe('completed');
    expect(tool.state.output).toBe('Edited acp-file.txt (1 replacement)');
    expect(tool.state.metadata.files).toHaveLength(1);
    // Relative label from the matched raw entry; patch bytes from the typed diff.
    expect(tool.state.metadata.files[0]).toMatchObject({ file: 'acp-file.txt', status: 'modified', additions: 1, deletions: 0 });
    expect(tool.state.metadata.files[0].patch).toContain('+beta-line-2');
    const text = page.items[0].parts.find((part) => part.type === 'text');
    expect(text.text).toBe('I appended `beta-line-2` as a second line in `acp-file.txt`, so the file now reads `alpha-line-1` then `beta-line-2`.');
  });

  it('opencode load replay: user + text + tool skeleton rebuild the page', async () => {
    const rows = await loadFixture('opencode-load.ndjson');
    const projector = projectorFor('opencode');
    const events = runReplay(projector, rows);

    // No deltas in replay: parts land whole.
    expect(events.some((event) => event.type === 'message.part.delta')).toBe(false);
    const page = projector.page({ limit: 10 });
    expect(page.items.map((item) => item.info.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
    expect(page.items[3].parts[0].text).toBe('Reply with exactly: REPLAY-MARKER-TEXT');
    expect(page.items[2].parts[0].text).toBe('REPLAY-MARKER-TEXT');
    expect(page.items[1].parts[0].text).toBe('Create file replay-note.txt containing: replay-xyz');
    const tool = page.items[0].parts.find((part) => part.type === 'tool');
    expect(tool).toMatchObject({ tool: 'write' });
    expect(tool.state.status).toBe('completed');
    expect(page.items[0].parts.find((part) => part.type === 'text').text).toContain('replay-xyz');
  });

  it('omp text with reasoning: kind switch seals the reasoning part', async () => {
    const rows = await loadFixture('omp-text.ndjson');
    const projector = projectorFor('omp');
    const events = runTurn(projector, rows);

    const types = events.map((event) => event.type);
    const assistantAt = types.indexOf('message.updated', 1);
    const firstPart = types.findIndex((type) => type === 'message.part.updated');
    expect(assistantAt).toBeLessThan(firstPart);
    expect(types.slice(-3)).toEqual(['message.patched', 'session.patched', 'session.idle']);

    const page = projector.page({ limit: 10 });
    const reasoning = page.items[0].parts.find((part) => part.type === 'reasoning');
    const text = page.items[0].parts.find((part) => part.type === 'text');
    expect(reasoning.text).toBe("The user hasn't given a new instruction beyond the checkpoint.");
    expect(reasoning.time.end).toBeDefined();
    expect(text.text).toBe('Ready when you are.');
    expect(text.id).toBe(`${page.items[0].info.id}:text:0`);
    expect(reasoning.id).toBe(`${page.items[0].info.id}:reasoning:0`);
    expect(projector.session().title).toBe('Exact reply request: HISTORY-MARKER-1');
  });

  it('omp load replay: turn ordinals from replay order', async () => {
    const rows = await loadFixture('omp-load.ndjson');
    const projector = projectorFor('omp');
    runReplay(projector, rows);
    const page = projector.page({ limit: 10 });
    expect(page.items.map((item) => item.info.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
    expect(page.items[3].parts[0].text).toContain('ACK OMP-REPLAY-T1');
    expect(page.items[2].parts[0].text).toBe('ACK OMP-REPLAY-T1');
    expect(page.items[1].parts[0].text).toContain('ACK OMP-REPLAY-T2');
    expect(page.items[0].parts[0].text).toBe('ACK OMP-REPLAY-T2');
  });

  it('pi-acp text: repeated titles collapse, usage without cost', async () => {
    const rows = await loadFixture('piacp-text.ndjson');
    const projector = projectorFor('pi-acp');
    const events = runTurn(projector, rows);
    const titlePatches = events.filter((event) =>
      event.type === 'session.patched' && event.properties.patch.title !== undefined);
    expect(titlePatches).toHaveLength(3);
    expect(titlePatches.at(-1).properties.patch.title).toBe('Write a 6-word commit message for: fix typo in README');
    expect(projector.session().title).toBe('Write a 6-word commit message for: fix typo in README');
    expect(projector.session().cost).toBe(0);
    expect(projector.session().metadata.acp.contextSize).toBe(1000000);
    const page = projector.page({ limit: 10 });
    expect(page.items[0].parts[0].text).toContain('wording(6).');
  });

  it('pi-acp load replay: title + text-only turns', async () => {
    const rows = await loadFixture('piacp-load.ndjson');
    const projector = projectorFor('pi-acp');
    runReplay(projector, rows);
    expect(projector.session().title).toBe('Reply with exactly this acknowledgement and nothing else: ACK REPLAY-MARKER-TURN');
    const page = projector.page({ limit: 10 });
    expect(page.items.map((item) => item.info.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
  });
});

describe('acp projector tool mapping (§3.4)', () => {
  it.each([
    [{ kind: 'read' }, 'read'],
    [{ kind: 'edit' }, 'edit'],
    [{ kind: 'delete' }, 'edit'],
    [{ kind: 'move' }, 'edit'],
    [{ kind: 'search' }, 'grep'],
    [{ kind: 'execute' }, 'shell'],
    [{ kind: 'fetch' }, 'webfetch'],
    [{ kind: 'think' }, 'acp'],
    [{ kind: 'switch_mode' }, 'acp'],
    [{ kind: 'other' }, 'acp'],
    [{}, 'acp'],
  ])('kind %j → %s', (update, expected) => {
    expect(resolveToolName(update)).toBe(expected);
  });

  it('maps a diff with null oldText to write', () => {
    expect(resolveToolName({ kind: 'edit', content: [{ type: 'diff', path: 'f', oldText: null, newText: 'x' }] })).toBe('write');
  });

  it('uses the opencode name hint only for known tools', () => {
    expect(resolveToolName({ kind: 'execute', name: 'shell' })).toBe('shell');
    expect(resolveToolName({ kind: 'execute', name: 'subagent' })).toBe('subagent');
    expect(resolveToolName({ kind: 'execute', name: 'weird-internal' })).toBe('shell');
  });

  it('builds a unified patch from typed diff fields', () => {
    const entry = diffToFileEntry({ path: 'f.txt', oldText: 'a\n', newText: 'a\nb\n' });
    expect(entry).toMatchObject({ file: 'f.txt', additions: 2, deletions: 1, status: 'modified' });
    expect(entry.patch).toContain('-a');
    expect(entry.patch).toContain('+b');
  });

  it('projects initial tool status and content from the skeleton itself', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({
      sessionId: 'n',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        kind: 'edit',
        status: 'completed',
        rawInput: { path: 'f.txt' },
        content: [{ type: 'diff', path: 'f.txt', oldText: 'a\n', newText: 'a\nb\n' }],
      },
    });
    const tool = projector.page({ limit: 5 }).items[0].parts.find((part) => part.type === 'tool');
    expect(tool.state.status).toBe('completed');
    expect(tool.state.input).toEqual({ path: 'f.txt' });
    expect(tool.state.metadata.files).toHaveLength(1);
    expect(tool.state.metadata.files[0].patch).toContain('+b');
  });

  it('collects every typed diff and caps oversized input', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    const big = 'x'.repeat(100000);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', status: 'pending', rawInput: { blob: big } } });
    projector.applyUpdate({
      sessionId: 'n',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [
          { type: 'diff', path: 'one.txt', oldText: 'a\n', newText: 'a\nb\n' },
          { type: 'diff', path: 'two.txt', oldText: '', newText: 'z\n' },
        ],
      },
    });
    const tool = projector.page({ limit: 5 }).items[0].parts.find((part) => part.type === 'tool');
    expect(tool.state.metadata.files.map((file) => file.file)).toEqual(['one.txt', 'two.txt']);
    expect(tool.state.input).toMatchObject({ _truncated: true });
    expect(JSON.stringify(tool.state.input).length).toBeLessThan(65536);
  });

  it('uses raw file entries only for labels after a path match', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', status: 'pending' } });
    projector.applyUpdate({
      sessionId: 'n',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'diff', path: 'C:\\work\\acp-file.txt', oldText: 'a\n', newText: 'a\nb\n' }],
        rawOutput: { metadata: { files: [{ file: 'acp-file.txt', patch: 'BOGUS', additions: 99, deletions: 0, status: 'modified' }] } },
      },
    });
    const tool = projector.page({ limit: 5 }).items[0].parts.find((part) => part.type === 'tool');
    // Relative label and counts come from raw; patch bytes from the typed diff.
    expect(tool.state.metadata.files[0]).toMatchObject({ file: 'acp-file.txt', additions: 99 });
    expect(tool.state.metadata.files[0].patch).toContain('+b');
    expect(tool.state.metadata.files[0].patch).not.toContain('BOGUS');
  });

  it('ignores raw file entries whose path does not match the typed diff', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', status: 'pending' } });
    projector.applyUpdate({
      sessionId: 'n',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'diff', path: 'C:\\work\\real.txt', oldText: 'a\n', newText: 'a\nb\n' }],
        rawOutput: { metadata: { files: [{ file: 'other.txt', patch: 'BOGUS', additions: 99, status: 'modified' }] } },
      },
    });
    const tool = projector.page({ limit: 5 }).items[0].parts.find((part) => part.type === 'tool');
    expect(tool.state.metadata.files[0]).toMatchObject({ file: 'C:\\work\\real.txt', additions: 2 });
  });
});

describe('acp projector turn rules', () => {
  it('rejects a second prompt while busy (409 rule)', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'one' }]);
    expect(() => projector.acceptPrompt('msg_2', [{ type: 'text', text: 'two' }])).toThrowError(
      expect.objectContaining({ code: 'ACP_SESSION_BUSY' }),
    );
  });

  it('maps stop reasons to finish/outcome', () => {
    for (const [stopReason, finish, outcome] of [
      ['end_turn', 'stop', 'succeeded'],
      ['max_tokens', 'length', 'failed'],
      ['max_turn_requests', 'unknown', 'failed'],
      ['refusal', 'content-filter', 'failed'],
    ]) {
      const projector = projectorFor();
      projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
      // An agent item must exist for the finish to land on.
      projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } });
      const events = projector.applyPromptResult({ stopReason });
      expect(events.at(-1)).toEqual({ type: 'session.idle', properties: { sessionID: projector.key, outcome } });
      expect(projector.page({ limit: 5 }).items[0].info.finish).toBe(finish);
    }
  });

  it('our cancel → interrupted, and a follow-up works', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    const events = projector.applyPromptResult({ stopReason: 'cancelled' }, { cancelledByUs: true });
    expect(events.at(-1).properties.outcome).toBe('interrupted');
    expect(projector.session().outcome).toBe('interrupted');
    expect(() => projector.acceptPrompt('msg_2', [{ type: 'text', text: 'y' }])).not.toThrow();
  });

  it('cancelled after a user decline → stop/succeeded with the tool declined (T2)', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', status: 'pending' } });
    const events = projector.applyPromptResult({ stopReason: 'cancelled' }, { declinedInTurn: true });
    expect(events.at(-1).properties.outcome).toBe('succeeded');
    const page = projector.page({ limit: 5 });
    expect(page.items[0].info.finish).toBe('stop');
    expect(page.items[0].parts.find((part) => part.type === 'tool').state).toMatchObject({
      status: 'error', error: 'Declined',
    });
  });

  it('unsolicited cancelled → session.error, never interrupted', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    const events = projector.applyPromptResult({ stopReason: 'cancelled' });
    expect(events.at(-1).properties.outcome).toBe('failed');
    expect(events.some((event) => event.type === 'session.error')).toBe(true);
    expect(events.find((event) => event.type === 'session.error')).toMatchObject({
      properties: { error: { message: expect.stringContaining('without a cancel request') } },
    });
  });

  it('JSON-RPC error → session.error with a failed outcome', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } });
    const events = projector.applyPromptError({ message: 'boom', code: -32603 });
    expect(events.map((event) => event.type).slice(-4)).toEqual([
      'message.patched',
      'session.patched',
      'session.error',
      'session.idle',
    ]);
    expect(events.find((event) => event.type === 'session.error')).toMatchObject({
      properties: { sessionID: projector.key, error: { type: 'acp_error', message: 'boom' } },
    });
    expect(projector.session().outcome).toBe('failed');
  });

  it('open tools at our-cancel end → Interrupted', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', status: 'pending' } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' } });
    projector.applyPromptResult({ stopReason: 'cancelled' }, { cancelledByUs: true });
    const tool = projector.page({ limit: 5 }).items[0].parts.find((part) => part.type === 'tool');
    expect(tool.state).toMatchObject({ status: 'error', error: 'Interrupted' });
  });

  it('user titles win over agent titles', () => {
    const projector = createSessionProjector({
      key: 'ses_acp-omp_rn', backendId: 'omp', directory: 'C:\\w',
      index: { title: 'agent', userTitle: 'mine' },
    });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'session_info_update', title: 'agent new' } });
    expect(projector.session().title).toBe('mine');
  });

  it('retry meta → session.status{retry}', () => {
    const projector = projectorFor();
    const events = projector.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': { attempt: 2, message: 'wait', next: 999 } } },
    });
    expect(events).toContainEqual({
      type: 'session.status',
      properties: { sessionID: projector.key, status: { type: 'retry', attempt: 2, message: 'wait', next: 999 } },
    });
  });

  it('terminal content and _meta.terminal_output → metadata.output', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', status: 'pending' } });
    projector.applyUpdate({
      sessionId: 'n',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: 'term-1', output: 'line1' }],
        _meta: { terminal_output: 'line2' },
      },
    });
    const tool = projector.page({ limit: 5 }).items[0].parts.find((part) => part.type === 'tool');
    expect(tool.state.metadata.output).toBe('line1\nline2');
  });

  it('config updates refresh options and announce model switches', () => {
    const projector = projectorFor();
    projector.seed({ configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'a' }] }, {});
    const events = projector.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'b' }] },
    });
    expect(projector.session().metadata.acp.configOptions).toEqual([
      { id: 'model', name: 'Model', type: 'select', current: 'b' },
    ]);
    expect(events.some((event) =>
      event.type === 'message.updated' && event.properties.info.role === 'model-switched')).toBe(true);
  });

  it('backend crash errors the live session', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    const events = projector.applyBackendExit({ code: 1, signal: null });
    expect(events.at(-1).type).toBe('session.idle');
    expect(events.find((event) => event.type === 'session.error')).toMatchObject({
      properties: { error: { message: expect.stringContaining('code 1') } },
    });
    expect(projector.busy).toBe(false);
  });

  it('pages newest-first with exact membership and next-iff-more cursors', () => {
    const projector = projectorFor();
    const assistantIds = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      projector.acceptPrompt(`msg_u${turn}`, [{ type: 'text', text: `q${turn}` }]);
      projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `a${turn}` } } });
      projector.applyPromptResult({ stopReason: 'end_turn' });
      assistantIds.push(projector.page({ limit: 1 }).items[0].info.id);
    }
    // Walk every page: each message appears exactly once, newest first.
    const seen = [];
    let before;
    for (;;) {
      const page = projector.page({ limit: 2, ...(before ? { before } : {}) });
      for (const item of page.items) seen.push(item.info.id);
      if (!page.cursor.next) break;
      before = page.cursor.next;
    }
    expect(seen).toEqual([assistantIds[2], 'msg_u3', assistantIds[1], 'msg_u2', assistantIds[0], 'msg_u1']);
    expect(new Set(seen).size).toBe(seen.length);
    // Each page also carries the right parts.
    const newest = projector.page({ limit: 2 });
    expect(newest.items[0].parts[0].text).toBe('a3');
    expect(newest.items[1].parts[0].text).toBe('q3');
    expect(projector.page({ limit: 2, before: 'msg_nope' }).items).toEqual([]);
  });

  it('trailing updates after the result land sealed on the settled assistant', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'body' } } });
    projector.applyPromptResult({ stopReason: 'end_turn' });
    const assistantId = projector.page({ limit: 5 }).items[0].info.id;
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tail1' } } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tail2' } } });
    const page = projector.page({ limit: 5 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].info.id).toBe(assistantId);
    // The tail stays on the same message instead of minting an orphan, and
    // every part is sealed: no open streams on an idle session.
    expect(page.items[0].parts.map((part) => part.text).join('')).toBe('bodytail1tail2');
    for (const part of page.items[0].parts) {
      expect(part.time.end).toBeDefined();
    }
    expect(page.items[0].info.time.completed).toBeDefined();
    expect(projector.busy).toBe(false);
  });

  it('announcement ids never collide with assistant ids', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } });
    projector.seed({ configOptions: [{ id: 'model', currentValue: 'a' }] }, {});
    projector.applyUpdate({
      sessionId: 'n',
      update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'b' }] },
    });
    const ids = projector.page({ limit: 10 }).items.map((item) => item.info.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('msg_acp-'))).toHaveLength(2);
  });

  it('generated ids are session-namespaced and ordered past nine turns', () => {
    const a = createSessionProjector({ key: 'ses_acp-omp_ra', backendId: 'omp', directory: 'C:\\w', now: () => 1000 });
    const b = createSessionProjector({ key: 'ses_acp-omp_rb', backendId: 'omp', directory: 'C:\\w', now: () => 1000 });
    const idsA = [];
    for (let turn = 1; turn <= 12; turn += 1) {
      a.acceptPrompt(`u${turn}`, [{ type: 'text', text: 'x' }]);
      a.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } });
      a.applyPromptResult({ stopReason: 'end_turn' });
      idsA.push(a.page({ limit: 1 }).items[0].info.id);
    }
    b.acceptPrompt('u1', [{ type: 'text', text: 'x' }]);
    b.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } });
    const idB = b.page({ limit: 2 }).items[0].info.id;
    // Cross-session uniqueness.
    expect(idsA).not.toContain(idB);
    // Lexicographic order matches transcript order (zero-padded past 9).
    expect([...idsA].sort()).toEqual(idsA);
    // Fixed clock still yields strictly increasing created times.
    const chronological = a.page({ limit: 30 }).items.reverse();
    const generated = chronological
      .filter((item) => item.info.id.startsWith('msg_acp-'))
      .map((item) => item.info.time.created);
    expect(generated).toEqual([...generated].sort((x, y) => x - y));
    expect(new Set(generated).size).toBe(generated.length);
  });
});

describe('acp projector compaction identity', () => {
  const compactionOf = (projector, id) => projector.page({ limit: 50 }).items
    .map((item) => item.info)
    .filter((info) => info.role === 'compaction');

  it('keeps one record per compaction id across chunks and settle', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: '/compact' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'a' } } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' } });
    const records = compactionOf(projector);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'completed', summary: 'a' });
  });

  it('patches the same record after completion instead of minting another', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: '/compact' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed', summary: [{ type: 'text', text: 'done' }] } });
    const first = compactionOf(projector)[0].id;
    // A late chunk appends to the settled record (and refreshes it, since
    // the reducer only streams deltas into running records).
    const events = projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: '!' } } });
    expect(events.map((event) => event.type)).toEqual(['message.compaction.delta', 'message.updated']);
    const records = compactionOf(projector);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: first, status: 'completed', summary: 'done!' });
    // A repeated terminal patch updates in place too.
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'failed', error: 'boom' } });
    expect(compactionOf(projector)).toHaveLength(1);
    expect(compactionOf(projector)[0]).toMatchObject({ id: first, status: 'failed', error: { message: 'boom' } });
  });

  it('implements null and empty-array clearing for summary and error', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: '/compact' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'secret' } } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed', summary: null } });
    expect(compactionOf(projector)[0].summary).toBe('');
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'failed', error: 'x' } });
    expect(compactionOf(projector)[0].error).toBeDefined();
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'failed', error: null } });
    expect(compactionOf(projector)[0].error).toBeUndefined();
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress', summary: [] } });
    expect(compactionOf(projector)[0].summary).toBe('');
    // Omission leaves the value alone.
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'kept' } } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' } });
    expect(compactionOf(projector)[0].summary).toBe('kept');
  });

  it('rebuilds compactions canonically and rolls them back', () => {
    const projector = projectorFor();
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'x' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed', summary: [{ type: 'text', text: 'old' }] } });
    projector.beginReplay();
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'new' } } }, { replay: true });
    projector.rollbackReplay();
    expect(compactionOf(projector)[0].summary).toBe('old');
    projector.beginReplay();
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'new' } } }, { replay: true });
    projector.endReplay();
    expect(compactionOf(projector)).toHaveLength(1);
    expect(compactionOf(projector)[0].summary).toBe('new');
  });
});

describe('acp projector terminal output (§3.3)', () => {
  const PIACP_UPDATES = (id) => [
    {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: 'echo hi',
      kind: 'execute',
      status: 'pending',
      content: [{ type: 'terminal', terminalId: id }],
      _meta: { terminal_info: { terminal_id: id, cwd: 'C:\\work' } },
    },
    { sessionUpdate: 'tool_call_update', toolCallId: id, title: 'echo hi', kind: 'execute', status: 'in_progress' },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'in_progress',
      _meta: { terminal_output: { terminal_id: id, data: 'PIACP-' } },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'in_progress',
      _meta: { terminal_output: { terminal_id: id, data: 'OUTPUT\n' } },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'completed',
      _meta: { terminal_exit: { terminal_id: id, exit_code: 0, signal: null } },
    },
  ];

  it('accumulates _meta terminal_output deltas into the completed part', () => {
    const projector = projectorFor('pi-acp');
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'run it' }]);
    for (const update of PIACP_UPDATES('call_1')) {
      projector.applyUpdate({ sessionId: 'n', update });
    }
    const parts = projector.page({ limit: 10 }).items.flatMap((item) => item.parts);
    const shell = parts.find((part) => part.type === 'tool' && part.callID === 'call_1');
    expect(shell.tool).toBe('shell');
    expect(shell.state).toMatchObject({ status: 'completed', output: 'PIACP-OUTPUT\n' });
    expect(shell.state.metadata).toMatchObject({ output: 'PIACP-OUTPUT\n', exitCode: 0 });
  });

  it('accepts the string form of terminal_output', () => {
    const projector = projectorFor('pi-acp');
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'run it' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 't', kind: 'execute', status: 'pending' } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'in_progress', _meta: { terminal_output: 'out' } } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed' } });
    const parts = projector.page({ limit: 10 }).items.flatMap((item) => item.parts);
    expect(parts.find((part) => part.callID === 'c2').state).toMatchObject({ status: 'completed', output: 'out' });
  });

  it('keeps typed content as a replacing snapshot, not an append', () => {
    const projector = projectorFor('opencode');
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'run it' }]);
    const id = 'toolu_1';
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: id, title: 't', kind: 'execute', status: 'pending' } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'part' } }] } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'whole' } }] } });
    const parts = projector.page({ limit: 10 }).items.flatMap((item) => item.parts);
    // Snapshot replaces; the progress text is not duplicated into the final.
    expect(parts.find((part) => part.callID === id).state).toMatchObject({ status: 'completed', output: 'whole' });
  });
});

describe('acp projector turn ordinals (D12) and generic tool identity', () => {
  it('numbers live turns 1-based in accept order', () => {
    const projector = projectorFor('omp');
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'one' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'r' } } });
    projector.applyPromptResult({ stopReason: 'end_turn' });
    projector.acceptPrompt('msg_2', [{ type: 'text', text: 'two' }]);
    projector.applyPromptResult({ stopReason: 'end_turn' });
    expect(projector.turnNumberOf('msg_1')).toBe(1);
    expect(projector.turnNumberOf('msg_2')).toBe(2);
    expect(projector.turnNumberOf('msg_nope')).toBeNull();
    // An assistant reply is not a turn.
    const assistantId = projector.transcriptIds().find((id) => id !== 'msg_1' && id !== 'msg_2');
    expect(assistantId).toBeTruthy();
    expect(projector.turnNumberOf(assistantId)).toBeNull();
  });

  it('restores turn ordinals across rollback', () => {
    const projector = projectorFor('omp');
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'one' }]);
    projector.applyPromptResult({ stopReason: 'end_turn' });
    projector.beginReplay();
    expect(projector.turnNumberOf('msg_1')).toBeNull();
    projector.rollbackReplay();
    expect(projector.turnNumberOf('msg_1')).toBe(1);
  });

  it('carries raw kind/title on generic tools across settle', () => {
    const projector = projectorFor('omp');
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'think' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Considering alternatives', kind: 'think', status: 'pending' } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'Considering alternatives', kind: 'think', status: 'in_progress' } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'done' } }] } });
    const parts = projector.page({ limit: 10 }).items.flatMap((item) => item.parts);
    const generic = parts.find((part) => part.callID === 'c1');
    expect(generic.tool).toBe('acp');
    expect(generic.state.metadata).toMatchObject({ acpKind: 'think', acpTitle: 'Considering alternatives', output: 'done' });
  });

  it('omits generic identity on mapped tools', () => {
    const projector = projectorFor('opencode');
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'read' }]);
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read file', kind: 'read', status: 'pending' } });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'tool_call_update', toolCallId: 'r1', title: 'Read file', kind: 'read', status: 'completed' } });
    const parts = projector.page({ limit: 10 }).items.flatMap((item) => item.parts);
    const read = parts.find((part) => part.callID === 'r1');
    expect(read.tool).toBe('read');
    expect(read.state.metadata ?? {}).not.toHaveProperty('acpKind');
    expect(read.state.metadata ?? {}).not.toHaveProperty('acpTitle');
  });
});

describe('acp projector revert commit', () => {
  it('commit clears the marker and the ordinal; replay cannot resurrect', () => {
    const projector = projectorFor('omp');
    projector.acceptPrompt('msg_1', [{ type: 'text', text: 'one' }]);
    projector.applyPromptResult({ stopReason: 'end_turn' });
    projector.setRevertBoundary(1, 'msg_1');
    expect(projector.session().revert).toEqual({ messageID: 'msg_1' });
    expect(projector.session().metadata.acp.revertedFromTurn).toBe(1);
    const events = projector.acceptPrompt('msg_2', [{ type: 'text', text: 'two' }]);
    expect(events.some((e) => e.type === 'session.patched' && e.properties.patch.revert === null)).toBe(true);
    expect(projector.session().revert).toBeUndefined();
    expect(projector.session().metadata.acp.revertedFromTurn).toBeUndefined();
    // Rebuild after the commit: no boundary comes back.
    projector.beginReplay();
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'user_message_chunk', messageId: 'u-1', content: { type: 'text', text: 'one' } } }, { replay: true });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'r' } } }, { replay: true });
    projector.endReplay();
    expect(projector.session().revert).toBeUndefined();
  });
});

describe('acp projector replayed completion', () => {
  it('marks rotated and trailing replayed assistants complete', () => {
    const projector = projectorFor('omp');
    projector.beginReplay();
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'user_message_chunk', messageId: 'u-1', content: { type: 'text', text: 'one' } } }, { replay: true });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'r1' } } }, { replay: true });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'user_message_chunk', messageId: 'u-2', content: { type: 'text', text: 'two' } } }, { replay: true });
    projector.applyUpdate({ sessionId: 'n', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm-2', content: { type: 'text', text: 'r2' } } }, { replay: true });
    projector.endReplay();
    const page = projector.page({ limit: 10 });
    const assistants = page.items.filter((item) => item.info.role === 'assistant');
    expect(assistants).toHaveLength(2);
    for (const item of assistants) {
      expect(item.info.finish).toBe('stop');
      expect(item.info.time.completed).toEqual(expect.any(Number));
    }
  });
});
