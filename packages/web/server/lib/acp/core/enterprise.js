/**
 * Enterprise enforcement for ACP backends (M1 holistic review, blocker).
 *
 * In enterprise mode the administrator promises conversation content goes
 * only to administrator-configured providers — so user-configured ACP
 * backends (arbitrary executables + env) are DISABLED unless the machine
 * policy allowlists them via `acpBackends: [{ id, command, args? }]`:
 *
 * - No allowlist entry for the id → the backend may neither be saved
 *   (registry PUT → 403) nor launched (every launch path refuses).
 * - An entry pins id+command and the exact argv. An omitted `args`
 *   pins the EMPTY argv: an entry carrying any args does not match
 *   the row. User `env` is ignored under the allowlist: env could
 *   reroute provider credentials, so only the allowlisted invocation
 *   runs.
 *
 * Enforcement lives at BOTH layers: the HTTP route rejects unauthorized
 * registry writes, and the backend manager re-checks every entry before
 * spawn — a registry file written out-of-band (or before the policy
 * landed) cannot bypass the route check.
 *
 * Read live on every call (like the opencodeBinary pin): a removed
 * allowlist entry stops serving immediately.
 */

import { isEnterpriseMode, readEnterprisePolicy } from '../../enterprise-mode.js';

export const ACP_ENTERPRISE_ERROR = 'Not available in enterprise mode: this backend is not allowlisted by your administrator (acpBackends in the OpenChamber policy file).';
export const ACP_ENTERPRISE_CODE = 'ACP_ENTERPRISE_BLOCKED';

const sameArgs = (left, right) => {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
};

/**
 * The allowlist decision for one registry entry. Returns `{ allowed: true,
 * env }` (env always `{}` — user env is ignored under the allowlist) when
 * enterprise mode is off or the entry matches an allowlist row, else
 * `{ allowed: false, error }`.
 */
export const enterpriseDecisionForBackend = (entry, { policy = null } = {}) => {
  const effective = policy ?? readEnterprisePolicy();
  if (!effective?.enterpriseMode) return { allowed: true, env: entry?.env };
  const allowlist = Array.isArray(effective.acpBackends) ? effective.acpBackends : [];
  const row = allowlist.find((candidate) => candidate?.id === entry?.id);
  if (!row) {
    return {
      allowed: false,
      error: `${ACP_ENTERPRISE_ERROR} (backend "${entry?.id ?? 'unknown'}")`,
    };
  }
  if (typeof entry?.command !== 'string' || entry.command !== row.command) {
    return {
      allowed: false,
      error: `${ACP_ENTERPRISE_ERROR} (backend "${entry?.id}" command does not match the allowlisted command)`,
    };
  }
  // Omitted pins empty: `sameArgs` reads a missing `args` (row or
  // entry) as `[]`, so any argv against an omitted row is rejected.
  if (!sameArgs(entry?.args, row.args)) {
    return {
      allowed: false,
      error: `${ACP_ENTERPRISE_ERROR} (backend "${entry?.id}" args do not match the allowlisted args)`,
    };
  }
  return { allowed: true, env: {} };
};

/** True when ACP launches are gated at all (enterprise mode on). */
export const isAcpEnterpriseGated = (options) => isEnterpriseMode(options);

export class AcpEnterpriseError extends Error {
  constructor(message = ACP_ENTERPRISE_ERROR, { backendId, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AcpEnterpriseError';
    this.code = ACP_ENTERPRISE_CODE;
    if (backendId !== undefined) this.backendId = backendId;
  }
}
