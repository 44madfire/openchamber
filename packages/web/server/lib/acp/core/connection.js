/**
 * One ACP connection: the SDK's `ClientSideConnection` over an agent child's
 * stdio, initialized at exactly `ACP_PROTOCOL_VERSION`.
 *
 * Host-agnostic: it takes an already-spawned child (stdio pipes) and exposes
 * agent→client traffic through hook callbacks, which later phases wire to the
 * projector. Unknown agent→client requests are answered `-32601` (the SDK's
 * default for unregistered methods); unknown notifications are surfaced
 * through `onUnknownNotification` and otherwise ignored, per the spec's
 * extensibility rules.
 */

import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

import { ACP_PROTOCOL_VERSION, AcpVersionMismatchError } from './protocol-version.js';

/** The child exited before `initialize` answered (bootstrap guard, §4). */
export const EARLY_EXIT_GUARD_MS = 50;
/** No `initialize` answer within this long → `error` (§4). */
export const INITIALIZE_TIMEOUT_MS = 15_000;

const CLIENT_INFO = Object.freeze({ name: 'openchamber', version: '1.1.0' });

/**
 * Client capabilities (D8): elicitation forms, session compaction, and the
 * opencode child-session extension flag. Never `fs` or `terminal` — dead in
 * v2, and only omp would use them.
 */
export const CLIENT_CAPABILITIES = Object.freeze({
  elicitation: Object.freeze({ form: Object.freeze({}) }),
  session: Object.freeze({ compaction: Object.freeze({}) }),
  _meta: Object.freeze({ 'opencode/child-session-updates': true }),
});

export class AcpConnectionError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AcpConnectionError';
    if (code !== undefined) this.code = code;
  }
}

const noopHook = () => {};

/**
 * Connect to an agent child process and run `initialize`.
 *
 * @param {object} options
 * @param {import('node:child_process').ChildProcess} options.child
 * @param {() => string} [options.getStderrTail] stderr tail for error context
 * @param {string} [options.clientName] override for `clientInfo.name`
 * @param {string} [options.clientVersion] override for `clientInfo.version`
 * @param {object} [options.hooks] agent→client traffic:
 *   `onSessionUpdate(params)`, `onRequestPermission(params)` (must resolve to
 *   a `RequestPermissionResponse`), `onElicitation(params)` (must resolve to
 *   a `CreateElicitationResponse`), `onUnknownNotification(method, params)`,
 *   `onExit({ code, signal })`.
 * @param {{ earlyExitMs?: number, initializeMs?: number }} [options.timeouts]
 *   guard overrides (tests).
 */
export const connectAcpAgent = async ({
  child,
  getStderrTail,
  clientName,
  clientVersion,
  hooks = {},
  timeouts = {},
}) => {
  if (!child?.stdin || !child?.stdout) {
    throw new AcpConnectionError('ACP connection requires a child with piped stdio', {
      code: 'ACP_NO_STDIO',
    });
  }
  const {
    onSessionUpdate = noopHook,
    onRequestPermission = null,
    onElicitation = null,
    onUnknownNotification = noopHook,
  } = hooks;
  const earlyExitMs = timeouts.earlyExitMs ?? EARLY_EXIT_GUARD_MS;
  const initializeMs = timeouts.initializeMs ?? INITIALIZE_TIMEOUT_MS;

  const events = new EventEmitter();
  // Crash/exit notifications must never throw for lack of a listener.
  events.setMaxListeners(0);

  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
    events.emit('exit', exited);
  });
  child.once('error', (error) => {
    events.emit('spawn-error', error);
  });

  const stderrTail = () => {
    try {
      return typeof getStderrTail === 'function' ? getStderrTail() : '';
    } catch {
      return '';
    }
  };

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new ClientSideConnection(
    () => ({
      requestPermission: (params) => {
        if (typeof onRequestPermission === 'function') return onRequestPermission(params);
        // No permission handler yet (Phase 1.4 wires the projector): reject
        // explicitly rather than hanging the agent's turn.
        return { outcome: { outcome: 'cancelled' } };
      },
      sessionUpdate: async (params) => {
        await onSessionUpdate(params);
      },
      createElicitation: (params) => {
        if (typeof onElicitation === 'function') return onElicitation(params);
        return { action: 'cancel' };
      },
      extNotification: async (method, params) => {
        await onUnknownNotification(method, params);
      },
      // No `extMethod`: unknown agent→client requests fall through to the
      // SDK default, a `-32601` method-not-found error.
    }),
    stream,
  );

  // Bootstrap guard (§4): ANY exit before initialize completes is an early
  // exit — there is no timing window to race. The `exit` listener is
  // attached before the initialize request is sent, and the catch path
  // below awaits the recorded outcome instead of racing a grace timer
  // against Node's exit delivery. `earlyExitMs` is retained as a hang
  // backstop: if the stream dies without an exit event following promptly,
  // the stale-connection error surfaces instead of hanging forever.
  let exitRecorded = null;
  const exitSettled = new Promise((resolve) => {
    if (exited) {
      exitRecorded = exited;
      resolve(exited);
      return;
    }
    events.once('exit', (exit) => {
      exitRecorded = exit;
      resolve(exit);
    });
  });
  // Suppress unhandled rejection: the initialize race below is the only
  // consumer, and only on the failure path.
  exitSettled.catch(() => {});

  const earlyExit = exitSettled.then((exit) => {
    const tail = stderrTail();
    throw new AcpConnectionError(
      `ACP agent exited during startup (code ${exit?.code ?? 'null'})${tail ? `: ${tail.slice(-500)}` : ''}`,
      { code: 'ACP_EARLY_EXIT' },
    );
  });

  const initialize = (async () => {
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const tail = stderrTail();
          reject(new AcpConnectionError(
            `ACP agent did not answer initialize within ${initializeMs} ms${tail ? `: ${tail.slice(-500)}` : ''}`,
            { code: 'ACP_INITIALIZE_TIMEOUT' },
          ));
        }, initializeMs);
        timer.unref?.();
      });
      let response;
      try {
        response = await Promise.race([
          connection.initialize({
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: CLIENT_CAPABILITIES,
            clientInfo: {
              name: clientName ?? CLIENT_INFO.name,
              version: clientVersion ?? CLIENT_INFO.version,
            },
          }),
          timeout,
          earlyExit,
        ]);
      } catch (error) {
        // The stdio stream closes before Node delivers `exit`, so a child
        // that dies instantly surfaces as a closed connection first. When
        // the child is gone, always report the early exit with its code —
        // never the transport error, regardless of event ordering. The
        // backstop timer only bounds the wait when no exit ever arrives
        // (half-dead pipe); it can no longer mask a real exit because the
        // recorded outcome is checked first.
        if (error?.code === 'ACP_INITIALIZE_TIMEOUT' || error?.code === 'ACP_EARLY_EXIT') throw error;
        if (exitRecorded) {
          const tail = stderrTail();
          throw new AcpConnectionError(
            `ACP agent exited during startup (code ${exitRecorded.code ?? 'null'})${tail ? `: ${tail.slice(-500)}` : ''}`,
            { code: 'ACP_EARLY_EXIT' },
          );
        }
        const exit = await Promise.race([
          exitSettled,
          new Promise((resolve) => {
            const backstop = setTimeout(() => resolve(null), Math.max(earlyExitMs, 50));
            backstop.unref?.();
          }),
        ]);
        if (exit) {
          const tail = stderrTail();
          throw new AcpConnectionError(
            `ACP agent exited during startup (code ${exit.code ?? 'null'})${tail ? `: ${tail.slice(-500)}` : ''}`,
            { code: 'ACP_EARLY_EXIT' },
          );
        }
        throw error;
      }
      if (response?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new AcpVersionMismatchError(response?.protocolVersion);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  })();

  let initResponse;
  try {
    initResponse = await initialize;
  } catch (error) {
    // A failed handshake owns nothing: the manager kills the child.
    events.removeAllListeners();
    throw error;
  }

  return {
    connection,
    events,
    protocolVersion: initResponse.protocolVersion,
    agentCapabilities: initResponse.agentCapabilities ?? null,
    authMethods: initResponse.authMethods ?? [],
    agentInfo: initResponse.agentInfo ?? null,
    /** Resolves once the child exits (crash detection hook). */
    waitForExit: () => (exited ? Promise.resolve(exited) : new Promise((resolve) => events.once('exit', resolve))),
    get exited() {
      return exited;
    },
  };
};
