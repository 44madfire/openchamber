import type {
  AgentCapabilities,
  AuthMethod,
  Implementation,
  SessionConfigOption as SdkSessionConfigOption,
} from '@agentclientprotocol/sdk';

import type { AcpBackendManager, AcpBackendState } from '../core/backend-manager.js';
import type { AcpOneOffService } from '../core/oneoff.js';
import type { AcpBackendEntry, AcpBackendRegistry } from '../core/registry.js';
import type { AcpSessionService } from '../core/sessions.js';

// ---------------------------------------------------------------------------
// Domain shapes (UI-owned; the server emits plain JSON of these shapes).
// Canonical definitions live in `packages/ui/src/lib/opencode/model.ts` and
// `packages/ui/src/lib/opencode/events.ts`; the declarations below mirror the
// fields the ACP routes use so the contract compiles standalone.
// ---------------------------------------------------------------------------

/** Token usage; `cache` is always present on the wire. */
export interface AcpTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export type AcpSessionStatus = { type: 'idle' } | { type: 'busy' } | {
  type: 'retry';
  attempt: number;
  message: string;
  next: number;
};

/** The `metadata.acp` block attached to every ACP session. */
export interface AcpSessionMeta {
  backendId: string;
  /** Agent capabilities as reported by `initialize` (pass-through JSON). */
  capabilities: Record<string, unknown>;
  /** Projected config options (SDK `currentValue` → `current`, option `value` → `id`). */
  configOptions: Array<{
    id: string;
    name?: string;
    category?: string;
    type?: string;
    current?: string | number | boolean | null;
    options?: Array<{ id: string; name?: string; description?: string | null }>;
  }>;
  /** Available modes with the current one flagged (`current: true`). */
  modes: Array<{ id: string; name?: string; description?: string | null; current?: boolean }>;
  /** Context window size in tokens, once a `usage_update` has arrived. */
  contextSize?: number;
  /** Checkpoint turn this session was reverted from, when it last reverted. */
  revertedFromTurn?: number;
}

export interface AcpSession {
  id: string;
  parentID?: string;
  projectID: string;
  directory: string;
  subpath?: string;
  title: string;
  cost: number;
  tokens: AcpTokenUsage;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time: { created: number; updated: number; idle?: number };
  metadata?: Record<string, unknown> & { acp?: AcpSessionMeta };
}

// ---------------------------------------------------------------------------
// Route contract (`registerAcpRoutes` in `./routes.js`).
//
// Directory scoping: session routes take `directory` as a query/body field
// (see each route); the `x-opencode-directory` header is accepted as a
// fallback wherever a directory is required. `directory` is normalized
// server-side (slashes, trailing separator, case on Windows) before it is
// used as the agent `cwd` or the index filter.
// ---------------------------------------------------------------------------

/** `POST /api/acp/sessions` — create a session on a backend in a directory. */
export interface AcpCreateSessionRequest {
  backendId: string;
  directory: string;
  /** Optional initial title (stored as the index `userTitle`). */
  title?: string;
}
export interface AcpSessionEnvelope {
  session: AcpSession;
}

/** `GET /api/acp/sessions?directory=` — sessions of one directory, sorted by id. */
export interface AcpListSessionsQuery {
  directory: string;
}
export interface AcpSessionsEnvelope {
  sessions: AcpSession[];
}

/**
 * `GET /api/acp/sessions/:key` — open (loading when cold) and return one session.
 * Unknown key → 404 `ACP_SESSION_UNKNOWN`.
 */
export interface AcpGetSessionParams {
  key: string;
}

/**
 * `GET /api/acp/sessions/:key/message?limit&before` — one page of messages,
 * newest first, exactly the `MessagePage` shape
 * `OpencodeService.getSessionMessages` returns:
 * `{ items: [{ info, parts }], cursor: { previous?, next? } }`.
 *
 * - `before` is a message id: the page holds messages strictly older than it.
 *   Omitted → the newest page.
 * - `limit` defaults to 100, clamped to 1..500.
 * - `cursor.next` is the `before` value for the next (older) page and is
 *   present if and only if older messages exist (`next` means "more" —
 *   unlike the OpenCode route, no trailing empty request is needed).
 * - `cursor.previous` is unused (no forward paging) and always absent.
 */
export interface AcpMessagesQuery {
  limit?: number;
  before?: string;
}
export interface AcpMessagePage {
  items: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  cursor: { previous?: string; next?: string };
}

/**
 * `GET /api/acp/sessions/:key/message/:messageId` — one message with its
 * parts (same record shape as page items). Unknown message → 404
 * `ACP_MESSAGE_UNKNOWN`. Prefer this over scanning pages.
 */
export interface AcpGetMessageParams {
  key: string;
  messageId: string;
}
export interface AcpMessageRecord {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

/**
 * `DELETE /api/acp/sessions/:key` — delete (`delete` cap) else close (`close`
 * cap), then drop the index entry. 200 `{ deleted: true }` (D5: plus an
 * optional `warning` when the agent side was already gone); unknown key → 404.
 */
export interface AcpDeleteSessionResponse {
  deleted: true;
  warning?: string;
}

/**
 * `GET /api/acp/sessions/:key/message?limit&before` — one page of messages,
 * newest first, exactly the `MessagePage` shape
 * `OpencodeService.getSessionMessages` returns:
 * `{ items: [{ info, parts }], cursor: { previous?, next? } }`.
 *
 * - `before` is a message id: the page holds messages strictly older than it.
 *   Omitted → the newest page.
 * - `limit` defaults to 100, clamped to 1..500.
 * - `cursor.next` is the `before` value for the next (older) page and is
 *   present if and only if older messages exist (`next` means "more" —
 *   unlike the OpenCode route, no trailing empty request is needed).
 * - `cursor.previous` is unused (no forward paging) and always absent.
 */
export interface AcpMessagesQuery {
  limit?: number;
  before?: string;
}
export interface AcpMessagePage {
  items: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  cursor: { previous?: string; next?: string };
}

/** One prompt part in `POST /api/acp/sessions/:key/prompt`. */
export type AcpPromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string };

/**
 * `POST /api/acp/sessions/:key/prompt` — send one user turn.
 * `messageId` is client-minted; the projector echoes it so the optimistic
 * message reconciles in place. Text parts become ACP text blocks, file parts
 * become `resource_link` blocks (`uri` = `url`).
 *
 * - 202 with an empty body when the turn starts.
 * - 409 `ACP_SESSION_BUSY` while a turn runs (the client must not queue).
 * - Unknown key → 404 `ACP_SESSION_UNKNOWN`.
 */
export interface AcpPromptRequest {
  messageId: string;
  parts: AcpPromptPart[];
}

/**
 * `POST /api/acp/sessions/:key/cancel` — interrupt the running turn.
 * 200 `{ cancelled: true }` when a turn was interrupted; 204 when idle.
 */
export interface AcpCancelResponse {
  cancelled: true;
}

/**
 * `POST /api/acp/sessions/:key/config` — set one config option
 * (`set_config_option`). 200 with an empty body; unknown option → 422
 * `ACP_CONFIG_UNKNOWN`.
 */
export interface AcpConfigRequest {
  configId: string;
  value: string | number | boolean;
}

/**
 * `GET /api/acp/sessions/status?directory=` — busy map for one directory:
 * session key → status. Only sessions with live projector state are listed;
 * a missing key means idle/unknown.
 */
export interface AcpStatusesQuery {
  directory: string;
}
export interface AcpStatusesEnvelope {
  statuses: Record<string, AcpSessionStatus>;
}
// ---------------------------------------------------------------------------
// Permissions (Phase 1.4): ACP `session/request_permission` → domain shape.
// ---------------------------------------------------------------------------

/**
 * A pending permission request. Mirrors the UI `PermissionRequest` shape
 * (opencode `Permission.Request`): the reducer stores it verbatim and
 * `PermissionCard` renders it.
 *
 * - `action` is the resolved tool name (`shell`, `edit`, `read`, …; §3.4).
 * - `resources` names what the call wants to touch (file paths from
 *   `locations`, the shell command, …), size-capped.
 * - `metadata` carries the capped tool input plus `title`/`kind`/`toolCallId`.
 */
export interface AcpPermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: 'tool'; messageID: string; id: string };
  message?: string;
}

export type AcpPermissionReply = 'once' | 'always' | 'reject';

/**
 * `POST /api/acp/sessions/:key/permissions/:requestId/reply` — answer one
 * pending permission (§3.2 `permissions.reply`).
 * `once`→`allow_once`, `always`→`allow_always` (else `allow_once`),
 * `reject`→`reject_once`, sent as `{outcome:{outcome:'selected',optionId}}`;
 * no matching option → `{outcome:{outcome:'cancelled'}}`.
 * 200 with an empty body; settled/unknown → 404 `ACP_PERMISSION_UNKNOWN`.
 */
export interface AcpPermissionReplyRequest {
  reply: AcpPermissionReply;
  message?: string;
}

/**
 * `GET /api/acp/sessions/:key/permissions/:requestId` — fetch one pending
 * permission (for `fetchPermission`). Unknown/settled → 404
 * `ACP_PERMISSION_UNKNOWN`.
 */
export interface AcpPermissionEnvelope {
  permission: AcpPermissionRequest;
}

/**
 * `GET /api/acp/permissions?directory=` — pending permission requests of one
 * directory, for bootstrap merge. Never 404s; `{ permissions: [] }` when idle.
 */
export interface AcpPermissionsQuery {
  directory: string;
}
export interface AcpPermissionsEnvelope {
  permissions: AcpPermissionRequest[];
}

// ---------------------------------------------------------------------------
// Forms (Phase 1.4): `elicitation/create` (form mode) plus pi-acp choice
// prompts (a permission with more than one `allow_*` option).
// ---------------------------------------------------------------------------

/** One elicitation form field. Mirrors the UI `FormRequest` field shapes. */
export interface AcpFormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  default?: string | number | boolean | string[];
  options?: Array<{ value: string; label: string; description?: string }>;
}

/**
 * A pending form. Mirrors the UI `FormRequest` shape (opencode `Form.Info`).
 * Choice-prompt forms carry a single `string` field with `options` (one per
 * permission option) and `metadata.elicitation` absent; elicitation forms
 * translate the JSON schema (`string`/`number`/`integer`→`number`,
 * `boolean`, `array`→`multiselect`; `enum`/`oneOf`→`options`).
 */
export interface AcpFormRequest {
  id: string;
  sessionID: string;
  title: string;
  fields: AcpFormField[];
  metadata?: Record<string, unknown>;
}

/**
 * `POST /api/acp/sessions/:key/forms/:formId/reply` — answer a form
 * (`{action:'accept',content}`; choice prompts answer the parked permission
 * with the selected `optionId`). 200 with an empty body; unknown/settled →
 * 404 `ACP_FORM_UNKNOWN`.
 */
export interface AcpFormReplyRequest {
  answer: Record<string, string | number | boolean | string[]>;
}

/**
 * `POST /api/acp/sessions/:key/forms/:formId/cancel` — dismiss a form
 * (`{action:'cancel'}`; choice prompts answer the parked permission with
 * `cancelled`). 200 with an empty body; unknown/settled → 404
 * `ACP_FORM_UNKNOWN`.
 */
export interface AcpFormCancelParams {
  key: string;
  formId: string;
}

/**
 * `GET /api/acp/forms?directory=` — pending forms of one directory, for
 * bootstrap merge. Never 404s; `{ forms: [] }` when idle.
 */
export interface AcpFormsQuery {
  directory: string;
}
export interface AcpFormsEnvelope {
  forms: AcpFormRequest[];
}

// ---------------------------------------------------------------------------
// Commands (Phase 1.4): the cached `available_commands` per session.
// ---------------------------------------------------------------------------

/** A slash command, OpenChamber `CommandInfo`-compatible (`name`, `description`). */
export interface AcpCommandInfo {
  name: string;
  description?: string;
}

/**
 * `GET /api/acp/sessions/:key/commands` — cached slash commands of one
 * session. `{ commands: [] }` until an `available_commands_update` arrives.
 * Unknown key → 404 `ACP_SESSION_UNKNOWN`. Changes emit
 * `catalog.updated{kind:'command'}` on the frame.
 */
export interface AcpCommandsEnvelope {
  commands: AcpCommandInfo[];
}

// ---------------------------------------------------------------------------
// Config cache (D9): last-seen config options per backend, for the
// pre-session picker. Persisted on every session/new and config_option_update.
// ---------------------------------------------------------------------------

/**
 * `GET /api/acp/backends/:id/config-cache` — last-seen config options of one
 * backend (same item shape as `AcpSessionMeta.configOptions`). Empty array
 * when nothing has been seen yet. Unknown backend → 404
 * `ACP_BACKEND_UNKNOWN`.
 */
export interface AcpConfigCacheEnvelope {
  configOptions: AcpSessionMeta['configOptions'];
}
// ---------------------------------------------------------------------------
// Checkpoints (Phase 1.5): per-turn file snapshots for diff and revert.
// ---------------------------------------------------------------------------

/**
 * `GET /api/acp/sessions/:key/checkpoints` — one checkpoint summary per
 * completed or in-progress turn, as a bare JSON array. Unknown key → 404
 * `ACP_SESSION_UNKNOWN`.
 */
export interface AcpCheckpointSummary {
  turn: number;
  complete: boolean;
}

/**
 * One file entry of `GET /api/acp/sessions/:key/diff?turn=N` — the turn's
 * working-tree changes vs its checkpoint as a bare JSON array. Bad `turn` →
 * 400 `ACP_INVALID_REQUEST`; unknown turn → 404 `ACP_CHECKPOINT_UNKNOWN`;
 * in-progress turn → 422 `ACP_CHECKPOINT_INCOMPLETE`.
 */
export interface AcpFileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
}

/**
 * `POST /api/acp/sessions/:key/revert` — restore the checkpoint of one turn.
 * Bad `turn` → 400 `ACP_INVALID_REQUEST`; busy session → 409
 * `ACP_SESSION_BUSY`; in-progress turn → 422 `ACP_CHECKPOINT_INCOMPLETE`.
 */
export interface AcpRevertRequest {
  turn: number;
}
export interface AcpRevertResponse {
  restored: string[];
  removed: string[];
  skipped: Array<{ file: string; reason: string }>;
  session: AcpSession;
}

/**
 * `POST /api/acp/sessions/:key/fork` — whole-transcript fork (§3.2, T6:
 * no fork-at-message, so no request body). Gated server-side on
 * `agentCapabilities.sessionCapabilities.fork`; unsupported → 409
 * `ACP_FORK_UNSUPPORTED`; busy session → 409 `ACP_SESSION_BUSY`. The
 * forked session (new key) is warm: its transcript is rebuilt via its
 * own load before the response.
 */
export interface AcpForkResponse {
  session: AcpSession;
}

// ---------------------------------------------------------------------------
// One-off generation (Phase 1.6): single-turn ask without a live session.
// ---------------------------------------------------------------------------

/**
 * `POST /api/acp/oneoff` — generate one completion on a resolved backend.
 * Validation failures → 400 `ACP_INVALID_REQUEST`; unknown backend → 404
 * `ACP_BACKEND_UNKNOWN`; no usable backend → 503 `ACP_BACKEND_UNAVAILABLE`;
 * agent failure → 502 `ACP_ONEOFF_FAILED` (message carries the agent's
 * error text; `backendId`/`agentCode` name it for the helper-model toast —
 * the same status the small-model route uses for this code);
 * generation timeout → 504 `ACP_ONEOFF_TIMEOUT`.
 */
export interface AcpOneOffRequest {
  backendId?: string;
  sessionKey?: string;
  instruction: string;
  input: string;
  maxChars?: number;
}
export interface AcpOneOffResponse {
  text: string;
  usage?: { totalTokens?: number; contextSize?: number };
  cost?: { amount: number; currency: string };
  warnings?: string[];
  sessionCleanup: 'deleted' | 'closed' | 'left';
  backendId: string;
}

// ---------------------------------------------------------------------------
// Terminal auth (Phase 1.6): interactive login runs in a spawned terminal.
// ---------------------------------------------------------------------------

/**
 * `POST /api/acp/backends/:id/auth/terminal` — spawn details for an
 * interactive auth method. This route never calls `authenticate`. Unknown
 * backend → 404 `ACP_BACKEND_UNKNOWN`; non-terminal method → 400
 * `ACP_AUTH_NOT_TERMINAL`.
 */
export interface AcpAuthTerminalRequest {
  methodId?: string;
}
export interface AcpAuthTerminalResponse {
  command: string;
  args: string[];
  env: Record<string, string>;
  methodId: string;
}

// ---------------------------------------------------------------------------
// Phase 1.4 frame events (existing `SyncEvent` vocabulary — no new frame
// type; the UI validates these with `lib/acp/frames.ts` unchanged).
// ---------------------------------------------------------------------------
//
// - `permission.asked` (full `AcpPermissionRequest`) → `permission.replied
//   {sessionID, requestID}` when answered, cancelled, or settled by turn end.
// - `form.created {form}` → `form.settled {sessionID, formID}` (elicitation
//   forms and pi-acp choice prompts alike).
// - `catalog.updated {kind:'command'}` when a session's cached commands change.
// - Compaction: `message.updated` (`role:'compaction'`, `status:'running'`,
//   empty `summary`) then `message.compaction.delta {sessionID, delta}` per
//   summary chunk, then `message.updated` with the settled status — for both
//   the standard updates and the `_meta["opencode/compaction"]` fallback.
// - Child sessions: `session.created` for the child (`parentID` = parent key)
//   with its own message/part events, `session.patched` on status changes;
//   the parent `subagent` tool part's metadata carries the child key.

// ---------------------------------------------------------------------------
// Backends (Phase 1.1, extended: `label`/`enabled` flattened for the picker).
// ---------------------------------------------------------------------------

/** `GET /api/acp/backends` → `{ backends: AcpBackendStatus[] }` (unchanged envelope). */
export interface AcpBackendStatus {
  id: string;
  /** Registry entry label, flattened (also under `entry.label`). */
  label: string;
  /** Registry entry enabled flag, flattened (also under `entry.enabled`). */
  enabled: boolean;
  /** Full registry entry (command/args/env/helper/cache) — the edit form reads it here. */
  entry: AcpBackendEntry;
  state: AcpBackendState;
  protocolVersion: number | null;
  agentInfo: Implementation | null;
  agentCapabilities: AgentCapabilities | null;
  authMethods: AuthMethod[];
  lastError: string | null;
  stderrTail: string;
}

// ---------------------------------------------------------------------------
// Event frame (D4): published on the global message hub as
// `{ type: 'openchamber:acp-sync', properties: { directory, events } }`,
// where each event is a domain `SyncEvent`. The UI validates the frame with
// zod (`lib/acp/frames.ts`) and passes the events to the existing reducer.
// ---------------------------------------------------------------------------

export interface AcpSyncFrame {
  type: 'openchamber:acp-sync';
  properties: {
    directory: string;
    events: Array<{ type: string; properties: Record<string, unknown> }>;
  };
}

export type { SdkSessionConfigOption };

interface AcpExpressApp {
  get(path: string, handler: (req: unknown, res: unknown) => unknown): unknown;
  put(path: string, ...handlers: Array<(req: unknown, res: unknown) => unknown>): unknown;
  post(path: string, ...handlers: Array<(req: unknown, res: unknown) => unknown>): unknown;
  patch(path: string, ...handlers: Array<(req: unknown, res: unknown) => unknown>): unknown;
  delete(path: string, handler: (req: unknown, res: unknown) => unknown): unknown;
}

export interface AcpRouteDependencies {
  registry: AcpBackendRegistry;
  manager: AcpBackendManager;
  /**
   * Session service (Phase 1.2+). Optional until the host wires it; session
   * routes answer 503 `ACP_SESSIONS_UNAVAILABLE` without it.
   */
  sessions?: AcpSessionService;
  /**
   * One-off generation service (Phase 1.6). Optional until the host wires
   * it; `POST /api/acp/oneoff` answers 503 `ACP_ONEOFF_UNAVAILABLE` without
   * it.
   */
  oneOff?: AcpOneOffService;
  /**
   * Hub publish hook: `publishSyncFrame(frame)` fans out to SSE + WS clients
   * with replay (the host binds `globalEventHub.injectEvent`). Optional in
   * tests; without it frames are dropped.
   */
  publishSyncFrame?: (frame: AcpSyncFrame) => void;
}

export declare function registerAcpRoutes(app: AcpExpressApp, dependencies: AcpRouteDependencies): void;
