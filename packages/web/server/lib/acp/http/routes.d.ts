import type {
  AgentCapabilities,
  AuthMethod,
  Implementation,
  SessionConfigOption as SdkSessionConfigOption,
} from '@agentclientprotocol/sdk';

import type { AcpBackendManager, AcpBackendState } from '../core/backend-manager.js';
import type { AcpBackendRegistry } from '../core/registry.js';
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
 * cap), then drop the index entry. 200 `{ deleted: true }`; unknown key → 404.
 */
export interface AcpDeleteSessionResponse {
  deleted: true;
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
// Backends (Phase 1.1, extended: `label`/`enabled` flattened for the picker).
// ---------------------------------------------------------------------------

/** `GET /api/acp/backends` → `{ backends: AcpBackendStatus[] }` (unchanged envelope). */
export interface AcpBackendStatus {
  id: string;
  /** Registry entry label, flattened (also under `entry.label`). */
  label: string;
  /** Registry entry enabled flag, flattened (also under `entry.enabled`). */
  enabled: boolean;
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
   * Hub publish hook: `publishSyncFrame(frame)` fans out to SSE + WS clients
   * with replay (the host binds `globalEventHub.injectEvent`). Optional in
   * tests; without it frames are dropped.
   */
  publishSyncFrame?: (frame: AcpSyncFrame) => void;
}

export declare function registerAcpRoutes(app: AcpExpressApp, dependencies: AcpRouteDependencies): void;
