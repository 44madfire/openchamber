/**
 * ACP session key predicate (mirrors `web/server/lib/acp/core/session-key.js`).
 *
 * Keys look like `ses_acp-<backend>_r<native>` when the agent's native id is
 * already link-safe, else `ses_acp-<backend>_e<base64url(native)>`. Shape only:
 * routing must not depend on decodability, so garbage after `_e` still
 * counts. Keep in sync with the server codec (D6).
 */

const PREFIX = "ses_acp-"
const MAX_KEY_LENGTH = 128
const RAW_NATIVE_PATTERN = /^[A-Za-z0-9_-]+$/
const BACKEND_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** True when `value` is shaped like an ACP session key (see D6). */
export const isAcpSessionId = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > MAX_KEY_LENGTH) return false
  if (!value.startsWith(PREFIX)) return false
  const rest = value.slice(PREFIX.length)
  const sep = rest.search(/_[re]/)
  if (sep <= 0) return false
  const backend = rest.slice(0, sep)
  const marker = rest[sep + 1]
  const native = rest.slice(sep + 2)
  if (!BACKEND_ID_PATTERN.test(backend) || !native) return false
  return RAW_NATIVE_PATTERN.test(native)
}

export const ACP_SESSION_KEY_MAX_LENGTH = MAX_KEY_LENGTH
