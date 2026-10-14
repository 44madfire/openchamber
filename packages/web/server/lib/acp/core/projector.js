/**
 * Stateful projector, one per live session (D3): ACP updates in, domain
 * `SyncEvent`s out. It owns message ids, part ordinals and tool state.
 *
 * In-memory only: a cold session is rebuilt from `session/load` replay, and
 * pages for the UI are served from memory. The projector never touches the
 * network or the hub — the session service feeds it updates and fans its
 * returned events out.
 *
 * Identity: one session-namespaced allocator mints every generated message
 * id (`msg_acp-<tag>-<seq>`, zero-padded sequence shared by assistants,
 * announcements and replayed users). The UI keys parts globally by message
 * id and sorts equal-millisecond messages by id, so generated ids must be
 * unique across sessions AND ordered within the transcript. A monotonic tick
 * keeps generated `created` times strictly increasing for the same reason.
 * Replay resets the allocator, so the same replay stream always yields the
 * same ids; chunks group by the agent's `messageId` when supplied, with a
 * deterministic allocation-order fallback for agents that omit or re-mint
 * ids. Client prompt ids are echoed verbatim, never remapped.
 *
 * Event vocabulary (all domain `SyncEvent`s): prompt accepted → user
 * `message.updated` + `parts.replaced` + `status{busy}`; first agent item →
 * assistant `message.updated` before any part event; chunks → part
 * `updated` + `delta`; replay user chunks → user messages; tool calls →
 * `ToolPart` + `tool.transition`; plan/commands/config/mode/session-info/
 * usage updates → session/catalog patches; prompt result → patched + idle.
 */

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

const cloneTokens = (tokens) => ({
  input: tokens?.input ?? 0,
  output: tokens?.output ?? 0,
  reasoning: tokens?.reasoning ?? 0,
  cache: { read: tokens?.cache?.read ?? 0, write: tokens?.cache?.write ?? 0 },
});

/** Raw agent blobs are untrusted and unbounded; render only typed content. */
export const MAX_RAW_BYTES = 64 * 1024;
/** Retained tool input/output text is truncated past this (with a marker). */
export const MAX_RETAINED_TEXT = 64 * 1024;

const KNOWN_TOOL_NAMES = new Set([
  'write', 'edit', 'patch', 'read', 'grep', 'glob', 'shell', 'subagent', 'webfetch', 'websearch', 'skill', 'question',
]);

const KIND_TO_TOOL = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'grep',
  execute: 'shell',
  fetch: 'webfetch',
  think: 'acp',
  switch_mode: 'acp',
  other: 'acp',
};

/**
 * Tool name resolution (§3.4): `kind` first, then the non-standard root
 * `name` as a hint when it is one of OpenChamber's known tool names.
 */
export const resolveToolName = (update) => {
  const kind = typeof update?.kind === 'string' ? update.kind : null;
  let name = (kind && KIND_TO_TOOL[kind]) || 'acp';
  if (name === 'edit' && hasNullOldText(update)) name = 'write';
  const hint = typeof update?.name === 'string' ? update.name : null;
  if (hint && KNOWN_TOOL_NAMES.has(hint)) name = hint;
  return name;
};

const hasNullOldText = (update) => {
  const content = update?.content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => item?.type === 'diff' && (item.oldText === null || item.oldText === undefined));
};

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const serializedSize = (value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * Cap what is actually retained: tool input that serializes past the budget
 * is replaced by a bounded preview marker (still an object, so the reducer
 * and renderers keep working).
 */
export const cappedToolInput = (rawInput) => {
  const input = asRecord(rawInput);
  if (serializedSize(input) <= MAX_RAW_BYTES) return { ...input };
  let preview;
  try {
    preview = (JSON.stringify(rawInput) ?? '').slice(0, 8192);
  } catch {
    preview = '[unserializable]';
  }
  return { _truncated: true, preview };
};

const cappedText = (text) => {
  if (typeof text !== 'string' || text.length <= MAX_RETAINED_TEXT) return text;
  return `${text.slice(0, MAX_RETAINED_TEXT)}\n…[truncated ${text.length - MAX_RETAINED_TEXT} chars]`;
};

/** Unified patch for one `diff` content item (typed fields; the only source for patch bytes). */
export const diffToFileEntry = (item, label = null) => {
  const file = typeof label?.file === 'string'
    ? label.file
    : (typeof item?.path === 'string' ? item.path : 'unknown');
  // `oldText`/`newText` carry a trailing newline (`"a\n".split("\n")` is
  // `["a", ""]`); the empty tail is not a line.
  const linesOf = (text) => {
    if (typeof text !== 'string' || text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = linesOf(item?.oldText);
  const newLines = linesOf(item?.newText);
  const patch = [
    `Index: ${file}`,
    '===================================================================',
    `--- ${file}`,
    `+++ ${file}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    '',
  ].join('\n');
  return {
    file,
    patch,
    additions: typeof label?.additions === 'number' ? label.additions : newLines.length,
    deletions: typeof label?.deletions === 'number' ? label.deletions : oldLines.length,
    status: typeof label?.status === 'string'
      ? label.status
      : (oldLines.length === 0 ? 'added' : 'modified'),
  };
};

/**
 * Bounded reuse of the agent's relative file label: the raw entry only lends
 * its `file` name and counts after its path matches the typed diff's path
 * (typed paths are absolute, raw names relative — the typed path must end
 * with the raw name) and the raw patch is itself bounded. Patch bytes always
 * come from the typed diff. Returns the label or null.
 */
export const matchRawFileLabel = (typedItem, rawFiles) => {
  const typedPath = typeof typedItem?.path === 'string' ? typedItem.path : null;
  if (!typedPath || !Array.isArray(rawFiles)) return null;
  for (const raw of rawFiles) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.file !== 'string' || !raw.file) continue;
    if (typeof raw.patch !== 'string' || Buffer.byteLength(raw.patch, 'utf8') > MAX_RAW_BYTES * 4) continue;
    const normalized = typedPath.replace(/\\/g, '/');
    const candidate = raw.file.replace(/\\/g, '/');
    if (normalized === candidate || normalized.endsWith(`/${candidate}`)) return raw;
  }
  return null;
};

const STOP_TO_FINISH = {
  end_turn: 'stop',
  max_tokens: 'length',
  max_turn_requests: 'unknown',
  refusal: 'content-filter',
};

const isoToMs = (value, fallback) => {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
};

const textOf = (content) => (content && typeof content.text === 'string' ? content.text : '');

/** FNV-1a 48-bit session tag: deterministic, fixed-width, collision-shy. */
export const sessionTagFor = (key) => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  const text = String(key ?? '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a ^= code & 0xff;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= (code >>> 8) & 0xff;
    b = Math.imul(b, 0x01000193) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${(b & 0xffff).toString(16).padStart(4, '0')}`;
};

/**
 * @param {object} options
 * @param {string} options.key session key (UI id)
 * @param {string} options.backendId backend that owns the session
 * @param {string} options.directory normalized cwd
 * @param {object} [options.index] `{ title, userTitle }` read at build time
 * @param {() => number} [options.now]
 */
export const createSessionProjector = ({ key, backendId, directory, index = null, now = () => Date.now() }) => {
  if (typeof key !== 'string' || !key) throw new Error('createSessionProjector requires a key');
  if (typeof backendId !== 'string' || !backendId) throw new Error('createSessionProjector requires a backendId');

  const tag = sessionTagFor(key);

  const state = {
    info: {
      id: key,
      projectID: `acp:${backendId}`,
      directory,
      title: index?.userTitle ?? index?.title ?? '',
      cost: 0,
      tokens: cloneTokens(ZERO_TOKENS),
      time: { created: now(), updated: now() },
      metadata: {
        acp: {
          backendId,
          capabilities: {},
          configOptions: [],
          modes: [],
        },
      },
    },
    messages: [],
    parts: new Map(),
    status: { type: 'idle' },
    busy: false,
    turn: null,
    // One allocator for every live-generated message kind (assistants,
    // announcements): unique across sessions via the tag, ordered within
    // the transcript via the zero-padded sequence.
    nextSeq: 1,
    // Monotonic generated-message clock: strictly increasing `created`
    // times keep transcript order even when the wall clock stands still.
    lastTick: 0,
    // Load-replay rebuild state. Replayed messages get CANONICAL ids from
    // (session tag, turn ordinal, block ordinal) — deterministic for the
    // same stream regardless of allocator state or replay count. Chunk
    // grouping still follows the agent's messageId when supplied.
    replaying: false,
    replayTurn: 0,
    replayBlock: 0,
    replayByAgentId: new Map(),
    replayAssistantId: null,
    // Pre-rebuild transcript snapshot: ids the UI may still hold, replaced
    // by the canonical transcript when the rebuild completes.
    replacedIds: null,
    // Full pre-rebuild snapshot for rollback when the load fails.
    replayRollback: null,
    // The settled turn's assistant: trailing updates after the result land
    // here without reopening the turn or minting orphan messages.
    completedAssistantId: null,
  };

  const touch = () => { state.info.time.updated = now(); };

  /** Next generated message id + timestamp, in transcript order. */
  const allocate = () => {
    const seq = state.nextSeq++;
    const at = Math.max(now(), state.lastTick + 1);
    state.lastTick = at;
    return { id: `msg_acp-${tag}-${String(seq).padStart(6, '0')}`, at };
  };

  const tickAfter = () => {
    const at = Math.max(now(), state.lastTick + 1);
    state.lastTick = at;
    return at;
  };

  /**
   * Canonical id for a replayed message: `msg_acp-<tag>-t<TTTT>-<BB>` where
   * TTTT is the 1-based turn ordinal and BB the 0-based block ordinal
   * within the turn (00 = user, 01 = assistant, 02+ = announcements).
   * Lexicographic order is transcript order; the same stream always yields
   * the same ids.
   */
  const canonicalReplayId = (turn, block) =>
    `msg_acp-${tag}-t${String(turn).padStart(4, '0')}-${String(block).padStart(2, '0')}`;

  const ensureReplayTurn = () => {
    if (state.replayTurn === 0) state.replayTurn = 1;
    return state.replayTurn;
  };

  const sessionSnapshot = () => ({
    ...state.info,
    tokens: cloneTokens(state.info.tokens),
    time: { ...state.info.time },
    metadata: JSON.parse(JSON.stringify(state.info.metadata ?? {})),
  });

  const recordMessage = (message) => {
    state.messages.push(message);
    state.parts.set(message.id, []);
    return message;
  };

  const appendPart = (messageId, part) => {
    const list = state.parts.get(messageId) ?? [];
    list.push(part);
    state.parts.set(messageId, list);
    return part;
  };

  const replaceParts = (messageId, parts) => {
    state.parts.set(messageId, parts);
  };

  const messageById = (id) => (id ? state.messages.find((message) => message.id === id) ?? null : null);

  const currentAssistant = () => {
    const id = state.turn?.assistantId ?? (state.replaying ? state.replayAssistantId : null);
    return messageById(id);
  };

  const modelId = () => {
    const options = state.info.metadata.acp.configOptions ?? [];
    const model = options.find((option) => option.id === 'model');
    if (model && model.current !== undefined && model.current !== null) return String(model.current);
    return 'default';
  };

  /** The assistant message of the running turn; created before any part event. */
  const ensureAssistant = (events, agentId = null) => {
    let assistant = currentAssistant();
    if (assistant) return assistant;
    // Idle (settled) projector: attribute trailing updates to the completed
    // turn's assistant instead of minting an orphan message.
    if (!state.turn && !state.replaying && state.completedAssistantId) {
      assistant = messageById(state.completedAssistantId);
      if (assistant) return assistant;
    }
    if (state.replaying) {
      // Canonical identity: one assistant per turn (block 01). Repeated
      // chunks for the same agent message adopt the rebuilt message.
      if (agentId && state.replayByAgentId.has(agentId)) {
        const known = state.replayByAgentId.get(agentId);
        const existing = messageById(known);
        if (existing && existing.role === 'assistant') {
          state.replayAssistantId = known;
          return existing;
        }
      }
      const turn = ensureReplayTurn();
      const id = canonicalReplayId(turn, 1);
      if (agentId) state.replayByAgentId.set(agentId, id);
      state.replayAssistantId = id;
      return createAssistant(events, id, tickAfter());
    }
    const { id, at } = allocate();
    return createAssistant(events, id, at);
  };

  const createAssistant = (events, id, at) => {
    const assistant = {
      id,
      sessionID: key,
      role: 'assistant',
      time: { created: at },
      agent: backendId,
      providerID: `acp:${backendId}`,
      modelID: modelId(),
    };
    recordMessage(assistant);
    if (state.turn) state.turn.assistantId = id;
    else if (state.replaying) state.replayAssistantId = id;
    touch();
    events.push({ type: 'message.updated', properties: { info: { ...assistant, time: { ...assistant.time } } } });
    return assistant;
  };

  const currentStreamingPart = (assistantId, type) => {
    const list = state.parts.get(assistantId) ?? [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const part = list[index];
      if (part.type === type && part.time && part.time.end === undefined) return part;
      if (part.type === 'tool') continue;
      if (part.type !== type) return null;
    }
    return null;
  };

  const startStreamingPart = (events, assistant, type, text, startedAt) => {
    const list = state.parts.get(assistant.id) ?? [];
    const ordinal = list.filter((part) => part.type === type).length;
    const base = type === 'text' ? `${assistant.id}:text:${ordinal}` : `${assistant.id}:reasoning:${ordinal}`;
    const part = type === 'text'
      ? { id: base, sessionID: key, messageID: assistant.id, type, text, time: { start: startedAt } }
      : { id: base, sessionID: key, messageID: assistant.id, type, text, time: { start: startedAt } };
    appendPart(assistant.id, part);
    events.push({ type: 'message.part.updated', properties: { sessionID: key, part: { ...part } } });
    return part;
  };

  const appendChunk = (events, kind, chunk) => {
    const assistant = ensureAssistant(events);
    const text = textOf(chunk?.content);
    const startedAt = now();
    if (assistant.time.streamed === undefined) {
      assistant.time.streamed = startedAt;
      touch();
    }
    const type = kind === 'agent_thought_chunk' ? 'reasoning' : 'text';
    // Settled-tail path (finding 8): the turn is over, so trailing chunks
    // land in an immediately sealed part — never an open stream on an idle
    // session, and never a reopened seal.
    if (!state.turn && !state.replaying) {
      const list = state.parts.get(assistant.id) ?? [];
      const ordinal = list.filter((entry) => entry.type === type).length;
      const tail = {
        id: `${assistant.id}:${type}:${ordinal}`,
        sessionID: key,
        messageID: assistant.id,
        type,
        text: cappedText(text),
        time: { start: startedAt, end: startedAt },
      };
      appendPart(assistant.id, tail);
      events.push({ type: 'message.part.updated', properties: { sessionID: key, part: { ...tail } } });
      touch();
      return;
    }
    let part = currentStreamingPart(assistant.id, type);
    if (!part) {
      // A kind switch seals the other stream's open part (reasoning `end`).
      const other = type === 'text' ? 'reasoning' : 'text';
      const open = currentStreamingPart(assistant.id, other);
      if (open) {
        open.time.end = startedAt;
        events.push({ type: 'message.part.updated', properties: { sessionID: key, part: { ...open } } });
      }
      part = startStreamingPart(events, assistant, type, '', startedAt);
    }
    part.text = cappedText(part.text + text);
    if (type === 'text' && part.time.end !== undefined) delete part.time.end;
    events.push({
      type: 'message.part.delta',
      properties: { sessionID: key, messageID: assistant.id, partID: part.id, field: 'text', delta: text },
    });
    touch();
  };

  const toolPartFor = (assistantId, toolCallId) => {
    const list = state.parts.get(assistantId) ?? [];
    return list.find((part) => part.type === 'tool' && part.callID === toolCallId) ?? null;
  };

  const metadataFromContent = (content, meta, rawOutput) => {
    const metadata = {};
    const files = [];
    const outputs = [];
    const rawFiles = asRecord(asRecord(rawOutput).metadata).files;
    // Typed diffs are authoritative for patch bytes; every diff is collected.
    // The agent's raw file entry only lends its relative label/counts after
    // its path matches the typed diff's path.
    for (const item of Array.isArray(content) ? content : []) {
      if (item?.type === 'diff') {
        const label = Array.isArray(rawFiles) ? matchRawFileLabel(item, rawFiles) : null;
        files.push(diffToFileEntry(item, label));
      } else if (item?.type === 'terminal') {
        if (typeof item.output === 'string' && item.output) outputs.push(item.output);
      } else if (item?.type === 'content') {
        const block = item.content;
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) outputs.push(block.text);
      }
    }
    const terminalMeta = meta?.terminal_output ?? meta?.terminalOutput;
    if (typeof terminalMeta === 'string' && terminalMeta) outputs.push(terminalMeta);
    if (files.length > 0) metadata.files = files;
    if (outputs.length > 0) metadata.output = cappedText(outputs.join('\n'));
    return metadata;
  };

  /** Shared terminal/update projection used by both `tool_call` and `tool_call_update`. */
  const projectToolStatus = (events, assistant, part, update, startedAt) => {
    const status = update?.status ?? null;
    if ((status === 'in_progress' || status === null) && part.state.status === 'pending') {
      const input = update?.rawInput !== undefined ? cappedToolInput(update.rawInput) : part.state.input;
      events.push({
        type: 'message.tool.transition',
        properties: {
          sessionID: key,
          messageID: assistant.id,
          partID: part.id,
          transition: { kind: 'called', input: { ...input }, executed: true, start: startedAt },
        },
      });
      part.state = { status: 'running', input: { ...input }, time: { start: startedAt } };
      touch();
    }
    if (status === 'completed' || status === 'failed') {
      const metadata = metadataFromContent(update?.content, asRecord(update?._meta), update?.rawOutput);
      const output = metadata.output ?? '';
      const transition = status === 'completed'
        ? {
          kind: 'success',
          output,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          executed: true,
          end: startedAt,
        }
        : {
          kind: 'failed',
          error: cappedText(output || `tool ${part.tool} failed`),
          output: output || undefined,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          executed: true,
          end: startedAt,
        };
      const start = part.state.status === 'running' ? part.state.time.start : startedAt;
      events.push({
        type: 'message.tool.transition',
        properties: { sessionID: key, messageID: assistant.id, partID: part.id, transition },
      });
      part.state = status === 'completed'
        ? {
          status: 'completed',
          input: part.state.input,
          output,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          time: { start, end: startedAt },
        }
        : {
          status: 'error',
          input: part.state.input,
          error: transition.error,
          ...(output ? { output } : {}),
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          time: { start, end: startedAt },
        };
      touch();
      return;
    }
    if (part.state.status === 'running') {
      const metadata = metadataFromContent(update?.content, asRecord(update?._meta), update?.rawOutput);
      if (Object.keys(metadata).length > 0) {
        events.push({
          type: 'message.tool.transition',
          properties: {
            sessionID: key,
            messageID: assistant.id,
            partID: part.id,
            transition: { kind: 'progress', metadata },
          },
        });
        part.state = { ...part.state, metadata };
        touch();
      }
    }
  };

  const applyToolCall = (events, update) => {
    const toolCallId = update?.toolCallId;
    if (typeof toolCallId !== 'string' || !toolCallId) return;
    const assistant = ensureAssistant(events);
    const existing = toolPartFor(assistant.id, toolCallId);
    if (existing) {
      // A repeated skeleton is an update in disguise: project it as one.
      projectToolStatus(events, assistant, existing, update, now());
      return;
    }
    const name = resolveToolName(update);
    const part = {
      id: toolCallId,
      sessionID: key,
      messageID: assistant.id,
      type: 'tool',
      callID: toolCallId,
      tool: name,
      executed: true,
      state: { status: 'pending', input: cappedToolInput(update?.rawInput), raw: '' },
    };
    appendPart(assistant.id, part);
    events.push({ type: 'message.part.updated', properties: { sessionID: key, part: structuredClone(part) } });
    touch();
    // The skeleton may already carry a status and content (replay sends
    // completed calls whole): project them through the shared logic.
    projectToolStatus(events, assistant, part, update, now());
  };

  const applyToolCallUpdate = (events, update) => {
    const toolCallId = update?.toolCallId;
    if (typeof toolCallId !== 'string' || !toolCallId) return;
    const assistant = ensureAssistant(events);
    let part = toolPartFor(assistant.id, toolCallId);
    if (!part) {
      // Updates may arrive without a preceding `tool_call`; synthesize the
      // part so the transition lands.
      applyToolCall(events, update);
      return;
    }
    projectToolStatus(events, assistant, part, update, now());
  };

  const sealAssistantStreams = (events, assistantId, at) => {
    for (const part of state.parts.get(assistantId) ?? []) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.time && part.time.end === undefined) {
        part.time.end = at;
        events.push({ type: 'message.part.updated', properties: { sessionID: key, part: { ...part } } });
      }
    }
  };

  const applyUserReplay = (events, chunk) => {
    const text = textOf(chunk?.content);
    const agentId = typeof chunk?.messageId === 'string' && chunk.messageId ? chunk.messageId : null;
    // Chunks with the same agent messageId belong to the same message (v1);
    // agents that omit ids get one message per chunk in replay order. Either
    // way the id is canonical for (turn, block).
    if (agentId && state.replayByAgentId.has(agentId)) {
      const id = state.replayByAgentId.get(agentId);
      const list = state.parts.get(id) ?? [];
      let part = list.find((entry) => entry.type === 'text');
      if (!part) {
        part = { id: `${id}:text:0`, sessionID: key, messageID: id, type: 'text', text: '' };
        appendPart(id, part);
      }
      part.text = cappedText(part.text + text);
      events.push({
        type: 'message.parts.replaced',
        properties: { sessionID: key, messageID: id, parts: (state.parts.get(id) ?? []).map((entry) => ({ ...entry })) },
      });
      touch();
      return;
    }
    // A new user group starts a new turn (block 00).
    state.replayTurn += 1;
    state.replayBlock = 1;
    const id = canonicalReplayId(state.replayTurn, 0);
    if (agentId) state.replayByAgentId.set(agentId, id);
    const at = tickAfter();
    const message = { id, sessionID: key, role: 'user', time: { created: at } };
    recordMessage(message);
    events.push({ type: 'message.updated', properties: { info: { ...message, time: { ...message.time } } } });
    const part = { id: `${id}:text:0`, sessionID: key, messageID: id, type: 'text', text: cappedText(text) };
    appendPart(id, part);
    events.push({ type: 'message.parts.replaced', properties: { sessionID: key, messageID: id, parts: [{ ...part }] } });
    // Each replayed user turn starts a fresh assistant message; without this
    // every replayed agent chunk would accumulate on the first reply.
    if (state.replayAssistantId) {
      sealAssistantStreams(events, state.replayAssistantId, at);
    }
    state.replayAssistantId = null;
    touch();
  };

  const applyAgentReplay = (events, chunk) => {
    const agentId = typeof chunk?.messageId === 'string' && chunk.messageId ? chunk.messageId : null;
    const assistant = ensureAssistant(events, agentId);
    const text = textOf(chunk?.content);
    const startedAt = now();
    // Same grouping as live streaming: chunks accumulate on one text part;
    // the part seals when the turn rotates, not per chunk.
    let part = currentStreamingPart(assistant.id, 'text');
    if (!part) part = startStreamingPart(events, assistant, 'text', '', startedAt);
    part.text = cappedText(part.text + text);
    events.push({ type: 'message.part.updated', properties: { sessionID: key, part: { ...part } } });
    touch();
  };

  const applyPlan = (events, update) => {
    const entries = Array.isArray(update?.entries) ? update.entries : [];
    state.info.metadata.acp.plan = {
      entries: entries.map((entry) => ({
        content: typeof entry?.content === 'string' ? entry.content : '',
        priority: entry?.priority ?? 'medium',
        status: entry?.status ?? 'pending',
      })),
      updatedAt: now(),
    };
    touch();
    events.push({
      type: 'session.patched',
      properties: { sessionID: key, patch: { metadata: JSON.parse(JSON.stringify(state.info.metadata)) } },
    });
  };

  const applyCommands = (events, update) => {
    const commands = Array.isArray(update?.availableCommands) ? update.availableCommands : [];
    state.commands = commands
      .filter((command) => command && typeof command.name === 'string')
      .map((command) => ({
        name: command.name,
        description: typeof command.description === 'string' ? command.description : '',
      }));
    touch();
    events.push({ type: 'catalog.updated', properties: { kind: 'command' } });
  };

  const projectConfigOptions = (options) => (Array.isArray(options) ? options : []).map((option) => ({
    id: String(option?.id ?? ''),
    ...(typeof option?.name === 'string' ? { name: option.name } : {}),
    ...(typeof option?.category === 'string' ? { category: option.category } : {}),
    ...(typeof option?.type === 'string' ? { type: option.type } : {}),
    ...(option?.currentValue !== undefined && option?.currentValue !== null ? { current: option.currentValue } : {}),
    ...(Array.isArray(option?.options)
      ? {
        options: option.options.map((item) => ({
          id: String(item?.value ?? item?.id ?? ''),
          ...(typeof item?.name === 'string' ? { name: item.name } : {}),
          ...(typeof item?.description === 'string' ? { description: item.description } : {}),
        })),
      }
      : {}),
  }));

  const announce = (events, role, fields) => {
    // Announcements during a rebuild join the canonical transcript (blocks
    // 02+ of the current turn) so the rebuild stays fully deterministic.
    // Block 01 is the assistant's; announcements start at 02 even when no
    // user chunk has established the turn yet.
    const { id, at } = state.replaying
      ? (() => {
        const turn = ensureReplayTurn();
        state.replayBlock = Math.max(state.replayBlock + 1, 2);
        return { id: canonicalReplayId(turn, state.replayBlock), at: tickAfter() };
      })()
      : allocate();
    const message = { id, sessionID: key, role, time: { created: at }, ...fields };
    recordMessage(message);
    events.push({ type: 'message.updated', properties: { info: { ...message, time: { ...message.time } } } });
  };

  const applyConfigOptions = (events, update) => {
    const previous = state.info.metadata.acp.configOptions ?? [];
    const next = projectConfigOptions(update?.configOptions);
    state.info.metadata.acp.configOptions = next;
    touch();
    events.push({
      type: 'session.patched',
      properties: { sessionID: key, patch: { metadata: JSON.parse(JSON.stringify(state.info.metadata)) } },
    });
    const before = previous.find((option) => option.id === 'model')?.current;
    const after = next.find((option) => option.id === 'model')?.current;
    if (before !== after && after !== undefined) {
      announce(events, 'model-switched', {
        model: { id: String(after), providerID: `acp:${backendId}` },
        ...(before !== undefined ? { previous: { id: String(before), providerID: `acp:${backendId}` } } : {}),
      });
    }
  };

  const applyModeUpdate = (events, update) => {
    const modeId = update?.currentModeId;
    if (typeof modeId !== 'string' || !modeId) return;
    const modes = state.info.metadata.acp.modes ?? [];
    const previous = modes.find((mode) => mode.current)?.id;
    state.info.metadata.acp.modes = modes.map((mode) => ({ ...mode, current: mode.id === modeId }));
    touch();
    events.push({
      type: 'session.patched',
      properties: { sessionID: key, patch: { metadata: JSON.parse(JSON.stringify(state.info.metadata)) } },
    });
    if (previous !== modeId) {
      announce(events, 'agent-switched', { agent: modeId, ...(previous ? { previous } : {}) });
    }
  };

  const applySessionInfo = (events, update) => {
    const retry = asRecord(update?._meta)['opencode/retry'];
    if (retry && typeof retry === 'object') {
      const status = {
        type: 'retry',
        attempt: typeof retry.attempt === 'number' ? retry.attempt : 1,
        message: typeof retry.message === 'string' ? retry.message : 'retrying',
        next: typeof retry.next === 'number' ? retry.next : now() + 1000,
      };
      state.status = status;
      events.push({ type: 'session.status', properties: { sessionID: key, status: { ...status } } });
    }
    if (typeof update?.title === 'string' && update.title) {
      state.info.time.updated = isoToMs(update?.updatedAt, now());
      if (!index?.userTitle) {
        state.info.title = update.title;
        events.push({
          type: 'session.patched',
          properties: { sessionID: key, patch: { title: update.title, time: { updated: state.info.time.updated } } },
        });
      } else {
        touch();
      }
    } else {
      touch();
    }
  };

  const applyUsage = (events, update) => {
    const used = typeof update?.used === 'number' ? update.used : null;
    const size = typeof update?.size === 'number' ? update.size : null;
    const cost = update?.cost;
    if (used !== null) {
      state.info.tokens = { ...cloneTokens(ZERO_TOKENS), output: used };
    }
    if (cost && typeof cost.amount === 'number') {
      state.info.cost = cost.amount;
    }
    if (size !== null) {
      state.info.metadata.acp.contextSize = size;
    }
    touch();
    const patch = {};
    if (used !== null) patch.tokens = cloneTokens(state.info.tokens);
    if (cost && typeof cost.amount === 'number') patch.cost = state.info.cost;
    if (size !== null) patch.metadata = JSON.parse(JSON.stringify(state.info.metadata));
    if (Object.keys(patch).length > 0) {
      events.push({ type: 'session.patched', properties: { sessionID: key, patch } });
    }
  };

  const settleOpenTools = (events, assistant, finishedAt, terminal) => {
    if (!assistant) return;
    for (const part of state.parts.get(assistant.id) ?? []) {
      if (part.type !== 'tool' || (part.state.status !== 'pending' && part.state.status !== 'running')) continue;
      const transition = { kind: 'failed', error: terminal, executed: true, end: finishedAt };
      const start = part.state.status === 'running' ? part.state.time.start : finishedAt;
      events.push({
        type: 'message.tool.transition',
        properties: { sessionID: key, messageID: part.messageID, partID: part.id, transition },
      });
      part.state = {
        status: 'error',
        input: part.state.input,
        error: terminal,
        time: { start, end: finishedAt },
      };
    }
  };

  const finishTurn = (events, result, { cancelledByUs, declinedInTurn, error }) => {
    const assistant = currentAssistant();
    const finishedAt = now();
    if (assistant) {
      for (const part of state.parts.get(assistant.id) ?? []) {
        if ((part.type === 'text' || part.type === 'reasoning') && part.time && part.time.end === undefined) {
          part.time.end = finishedAt;
          events.push({ type: 'message.part.updated', properties: { sessionID: key, part: { ...part } } });
        }
      }
    }
    if (error) {
      settleOpenTools(events, assistant, finishedAt, 'Interrupted');
      const structured = {
        type: 'acp_error',
        message: error.message ?? 'ACP request failed',
        ...(typeof error.code === 'number' || typeof error.code === 'string' ? { status: error.code } : {}),
      };
      if (assistant) {
        assistant.finish = 'error';
        assistant.error = structured;
        assistant.time.completed = finishedAt;
        events.push({
          type: 'message.patched',
          properties: {
            sessionID: key,
            messageID: assistant.id,
            patch: { time: { completed: finishedAt }, finish: 'error', error: structured },
          },
        });
      }
      state.info.outcome = 'failed';
      touch();
      events.push({
        type: 'session.patched',
        properties: { sessionID: key, patch: { outcome: 'failed', time: { updated: state.info.time.updated } } },
      });
      events.push({ type: 'session.error', properties: { sessionID: key, error: structured } });
    } else {
      const stopReason = result?.stopReason ?? 'end_turn';
      if (stopReason === 'cancelled' && cancelledByUs) {
        // Only our own cancel yields `interrupted`.
        settleOpenTools(events, assistant, finishedAt, 'Interrupted');
        if (assistant) {
          assistant.time.completed = finishedAt;
          events.push({
            type: 'message.patched',
            properties: { sessionID: key, messageID: assistant.id, patch: { time: { completed: finishedAt } } },
          });
        }
        state.info.outcome = 'interrupted';
        touch();
        events.push({
          type: 'session.patched',
          properties: { sessionID: key, patch: { outcome: 'interrupted', time: { updated: state.info.time.updated } } },
        });
      } else if (stopReason === 'cancelled' && declinedInTurn) {
        // §8 T2: the agent reports a user decline as `cancelled`. The turn
        // ended by the user's choice, not by an interruption.
        settleOpenTools(events, assistant, finishedAt, 'Declined');
        if (assistant) {
          assistant.finish = 'stop';
          assistant.time.completed = finishedAt;
          events.push({
            type: 'message.patched',
            properties: {
              sessionID: key,
              messageID: assistant.id,
              patch: { time: { completed: finishedAt }, finish: 'stop' },
            },
          });
        }
        state.info.outcome = 'succeeded';
        touch();
        events.push({
          type: 'session.patched',
          properties: { sessionID: key, patch: { outcome: 'succeeded', time: { updated: state.info.time.updated } } },
        });
      } else if (stopReason === 'cancelled') {
        // Unsolicited `cancelled`: the spec allows it only after our cancel,
        // so this is an agent bug — surface it, don't bless it.
        settleOpenTools(events, assistant, finishedAt, 'Interrupted');
        const structured = {
          type: 'acp_error',
          message: 'agent reported the turn cancelled without a cancel request',
        };
        if (assistant) {
          assistant.finish = 'error';
          assistant.error = structured;
          assistant.time.completed = finishedAt;
          events.push({
            type: 'message.patched',
            properties: {
              sessionID: key,
              messageID: assistant.id,
              patch: { time: { completed: finishedAt }, finish: 'error', error: structured },
            },
          });
        }
        state.info.outcome = 'failed';
        touch();
        events.push({
          type: 'session.patched',
          properties: { sessionID: key, patch: { outcome: 'failed', time: { updated: state.info.time.updated } } },
        });
        events.push({ type: 'session.error', properties: { sessionID: key, error: structured } });
      } else {
        const finish = STOP_TO_FINISH[stopReason] ?? 'unknown';
        const outcome = stopReason === 'end_turn' ? 'succeeded' : 'failed';
        if (assistant) {
          assistant.finish = finish;
          assistant.time.completed = finishedAt;
          events.push({
            type: 'message.patched',
            properties: { sessionID: key, messageID: assistant.id, patch: { time: { completed: finishedAt }, finish } },
          });
        }
        state.info.outcome = outcome;
        touch();
        events.push({
          type: 'session.patched',
          properties: { sessionID: key, patch: { outcome, time: { updated: state.info.time.updated } } },
        });
      }
    }
    state.busy = false;
    if (assistant) state.completedAssistantId = assistant.id;
    state.turn = null;
    state.status = { type: 'idle' };
    const outcome = state.info.outcome;
    events.push({ type: 'session.idle', properties: { sessionID: key, ...(outcome ? { outcome } : {}) } });
  };

  return {
    key,

    get status() {
      return { ...state.status };
    },

    get busy() {
      return state.busy;
    },

    get commands() {
      return state.commands.map((command) => ({ ...command }));
    },

    session() {
      return sessionSnapshot();
    },

    /**
     * Seed session metadata from a `session/new` / `load` / `resume`
     * response (config options, modes, capabilities). No events: the service
     * emits `session.created` with the seeded snapshot.
     */
    seed(response, capabilities = null) {
      if (response?.configOptions !== undefined) {
        state.info.metadata.acp.configOptions = projectConfigOptions(response.configOptions);
      }
      if (response?.modes) {
        const current = response.modes.currentModeId;
        const available = Array.isArray(response.modes.availableModes) ? response.modes.availableModes : [];
        state.info.metadata.acp.modes = available.map((mode) => ({
          id: String(mode?.id ?? ''),
          ...(typeof mode?.name === 'string' ? { name: mode.name } : {}),
          ...(typeof mode?.description === 'string' ? { description: mode.description } : {}),
          ...(current !== undefined && mode?.id === current ? { current: true } : {}),
        }));
      }
      if (capabilities && typeof capabilities === 'object') {
        state.info.metadata.acp.capabilities = JSON.parse(JSON.stringify(capabilities));
      }
      touch();
    },

    /** User title changed underneath the projector (rename): agent titles stop landing. */
    setUserTitle(userTitle) {
      if (index) index = { ...index, userTitle };
      if (userTitle) {
        state.info.title = userTitle;
        touch();
      }
    },

    /**
     * Prompt accepted: echo the client's `messageId` as the user message,
     * then mark the turn busy. Throws when a turn is already running.
     */
    acceptPrompt(messageId, parts) {
      if (state.busy) {
        throw Object.assign(new Error(`ACP session is busy: ${key}`), { code: 'ACP_SESSION_BUSY' });
      }
      if (typeof messageId !== 'string' || !messageId) {
        throw Object.assign(new Error('ACP prompt requires a messageId'), { code: 'ACP_INVALID_PROMPT' });
      }
      const events = [];
      // The id is the client's, but the timestamp joins the projector's
      // monotonic clock: at a frozen wall clock, tick order is what keeps
      // turns interleaved (user, assistant, user, assistant, ...).
      const message = { id: messageId, sessionID: key, role: 'user', time: { created: tickAfter() } };
      recordMessage(message);
      events.push({ type: 'message.updated', properties: { info: { ...message, time: { ...message.time } } } });
      const projected = (Array.isArray(parts) ? parts : []).flatMap((part, partIndex) => {
        if (part?.type === 'text' && typeof part.text === 'string') {
          return [{ id: `${messageId}:text:0`, sessionID: key, messageID: messageId, type: 'text', text: cappedText(part.text) }];
        }
        if (part?.type === 'file' && typeof part.url === 'string') {
          return [{
            id: `${messageId}:file:${partIndex}`,
            sessionID: key,
            messageID: messageId,
            type: 'file',
            mime: typeof part.mime === 'string' ? part.mime : 'application/octet-stream',
            ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
            url: part.url,
          }];
        }
        return [];
      });
      replaceParts(messageId, projected);
      events.push({
        type: 'message.parts.replaced',
        properties: { sessionID: key, messageID: messageId, parts: projected.map((part) => ({ ...part })) },
      });
      state.busy = true;
      state.turn = { startedAt: now(), assistantId: null };
      state.completedAssistantId = null;
      state.replaying = false;
      state.replayAssistantId = null;
      state.status = { type: 'busy' };
      touch();
      events.push({ type: 'session.status', properties: { sessionID: key, status: { type: 'busy' } } });
      return events;
    },

    /**
     * Feed one `session/update` notification. `replay: true` switches chunk
     * handling to load-replay semantics (user chunks rebuild history grouped
     * by agent id; agent chunks accumulate without deltas).
     */
    applyUpdate(notification, { replay = false } = {}) {
      const events = [];
      const update = notification?.update;
      const kind = update?.sessionUpdate;
      if (typeof kind !== 'string') return events;
      switch (kind) {
        case 'agent_message_chunk':
          if (replay) applyAgentReplay(events, update);
          else appendChunk(events, kind, update);
          break;
        case 'agent_thought_chunk':
          appendChunk(events, kind, update);
          break;
        case 'user_message_chunk':
          if (replay) applyUserReplay(events, update);
          break;
        case 'tool_call':
          applyToolCall(events, update);
          break;
        case 'tool_call_update':
          applyToolCallUpdate(events, update);
          break;
        case 'plan':
          applyPlan(events, update);
          break;
        case 'available_commands_update':
          applyCommands(events, update);
          break;
        case 'config_option_update':
          applyConfigOptions(events, update);
          break;
        case 'current_mode_update':
          applyModeUpdate(events, update);
          break;
        case 'session_info_update':
          applySessionInfo(events, update);
          break;
        case 'usage_update':
          applyUsage(events, update);
          break;
        default:
          // Unknown updates (compaction, notices, future kinds) are ignored
          // in M1; later phases project them. Never throw on agent traffic.
          break;
      }
      return events;
    },

    /**
     * The `session/prompt` response arrived: settle the turn.
     * `cancelledByUs` (the service sent cancel) is the only path to
     * `interrupted`; `declinedInTurn` (a permission/form declined) ends the
     * turn as the user's choice (§8 T2).
     */
    applyPromptResult(result, flags = {}) {
      if (!state.busy) return [];
      const events = [];
      finishTurn(events, result, {
        cancelledByUs: flags.cancelledByUs === true,
        declinedInTurn: flags.declinedInTurn === true,
      });
      return events;
    },

    /** The `session/prompt` request threw (JSON-RPC error / transport): error the turn. */
    applyPromptError(error) {
      if (!state.busy) return [];
      const events = [];
      finishTurn(events, null, { error });
      return events;
    },

    /** Backend crash: live sessions surface `session.error{acp_backend_exit}`. */
    applyBackendExit(exit) {
      const events = [];
      finishTurn(events, null, {
        error: {
          message: `agent process exited (code ${exit?.code ?? 'null'}${exit?.signal ? `, signal ${exit.signal}` : ''})`,
          code: 'acp_backend_exit',
        },
      });
      return events;
    },

    /**
     * Begin a `session/load` rebuild: snapshot the live transcript for the
     * replacement prefix (`message.removed`) and for rollback, then reset
     * transcript state. Replayed messages get canonical ids; the live
     * allocator is untouched.
     */
    beginReplay() {
      // The replacement set unions the live transcript with ids persisted
      // to the sidecar: after eviction or a restart the fresh projector
      // never saw the live ids, but the UI may still hold them.
      const persisted = Array.isArray(index?.messageIds) ? index.messageIds : [];
      state.replacedIds = [...new Set([...persisted, ...state.messages.map((message) => message.id)])];
      state.replayRollback = {
        messages: structuredClone(state.messages),
        parts: structuredClone([...state.parts]),
        busy: state.busy,
        status: { ...state.status },
        completedAssistantId: state.completedAssistantId,
      };
      state.messages = [];
      state.parts = new Map();
      state.busy = false;
      state.turn = null;
      state.completedAssistantId = null;
      state.status = { type: 'idle' };
      state.replaying = true;
      state.replayTurn = 0;
      state.replayBlock = 0;
      state.replayByAgentId = new Map();
      state.replayAssistantId = null;
    },

    /**
     * The rebuild failed: restore the pre-rebuild transcript so the session
     * keeps serving what it had. Returns no events; the caller emits the
     * terminal error separately.
     */
    rollbackReplay() {
      const snapshot = state.replayRollback;
      state.replayRollback = null;
      state.replacedIds = null;
      state.replaying = false;
      state.replayAssistantId = null;
      if (!snapshot) return;
      state.messages = snapshot.messages;
      state.parts = new Map(snapshot.parts);
      state.busy = snapshot.busy;
      state.status = snapshot.status;
      state.completedAssistantId = snapshot.completedAssistantId;
    },

    /**
     * The rebuild completed: `message.removed` for every pre-rebuild id
     * that is not in the canonical transcript. The service publishes these
     * BEFORE the buffered canonical events, so the UI replaces rather than
     * merges. Clears the rebuild state.
     */
    endReplay() {
      const before = state.replacedIds ?? [];
      const canonical = new Set(state.messages.map((message) => message.id));
      state.replacedIds = null;
      state.replayRollback = null;
      state.replaying = false;
      state.replayAssistantId = null;
      return before
        .filter((id) => !canonical.has(id))
        .map((id) => ({ type: 'message.removed', properties: { sessionID: key, messageID: id } }));
    },

    /**
     * Terminal error outside any turn (watchdog recovery failure): session
     * failed + session.error + idle, without requiring a busy projector.
     */
    applyTerminalError(error) {
      const events = [];
      const structured = {
        type: 'acp_error',
        message: error?.message ?? 'ACP request failed',
        ...(typeof error?.code === 'number' || typeof error?.code === 'string' ? { status: error.code } : {}),
      };
      state.info.outcome = 'failed';
      touch();
      events.push({
        type: 'session.patched',
        properties: { sessionID: key, patch: { outcome: 'failed', time: { updated: state.info.time.updated } } },
      });
      events.push({ type: 'session.error', properties: { sessionID: key, error: structured } });
      state.busy = false;
      state.turn = null;
      state.status = { type: 'idle' };
      events.push({ type: 'session.idle', properties: { sessionID: key, outcome: 'failed' } });
      return events;
    },

    /**
     * One page of messages, newest first. `before` names the message the page
     * ends before (exclusive); `next` is present iff older messages exist.
     */
    page({ limit = 100, before } = {}) {
      const count = Math.max(1, Math.min(500, Math.floor(limit) || 100));
      const end = before === undefined
        ? state.messages.length
        : state.messages.findIndex((message) => message.id === before);
      const sliceEnd = end === -1 ? 0 : end;
      const sliceStart = Math.max(0, sliceEnd - count);
      const items = state.messages.slice(sliceStart, sliceEnd).reverse().map((message) => ({
        info: JSON.parse(JSON.stringify(message)),
        parts: JSON.parse(JSON.stringify(state.parts.get(message.id) ?? [])),
      }));
      const cursor = {};
      if (sliceStart > 0 && items.length > 0) {
        cursor.next = state.messages[sliceStart].id;
      }
      return { items, cursor };
    },

    /** Live transcript message ids, oldest first (for sidecar replacement sets). */
    transcriptIds() {
      return state.messages.map((message) => message.id);
    },
  };
};
