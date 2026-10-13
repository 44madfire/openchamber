/**
 * Terminal auth resolution (Phase 1.6): a `terminal` auth method names extra
 * `args`/`env` for the configured agent invocation, launched as a separate
 * interactive process — the client MUST NOT pass it to `authenticate`
 * (spec). This resolves the same spawn target the backend manager would
 * build for the agent: registry command + args with the method's args
 * appended, and the environment overlaid the same way `spawn.js` does.
 *
 * Host-agnostic: returns `{ command, args, env }` for the UI to open in
 * the terminal panel. After the user finishes, `restart` re-initializes.
 */

import { buildSpawnTarget, resolveAcpCommand } from './spawn.js';

const overlayEnv = (entryEnv, methodEnv) => {
  const out = { ...(entryEnv ?? {}) };
  if (methodEnv && typeof methodEnv === 'object') {
    for (const [name, value] of Object.entries(methodEnv)) {
      if (typeof value === 'string') out[name] = value;
    }
  }
  // PATH-style delimiter join matches spawn.js `overlayEnvironment` for the
  // two vars spawn merges; everything else replaces. The terminal panel
  // launches with this object overlaid on the server environment by the
  // terminal runtime, so only the agent's own layer is returned here.
  return out;
};

export const resolveAuthTerminalInvocation = (entry, method) => {
  if (!entry || typeof entry.command !== 'string' || !entry.command) {
    throw new Error('resolveAuthTerminalInvocation requires a backend entry with a command');
  }
  if (!method || typeof method !== 'object') {
    throw new Error('resolveAuthTerminalInvocation requires an auth method');
  }
  const resolvedPath = resolveAcpCommand(entry.command);
  const baseArgs = [...(entry.args ?? []), ...(Array.isArray(method.args) ? method.args : [])];
  const { file, argv } = buildSpawnTarget(entry.command, baseArgs, { resolvedPath });
  return { command: file, args: argv, env: overlayEnv(entry.env, method.env) };
};
