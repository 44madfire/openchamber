/**
 * Session key codec (D6): the UI-safe handle for an ACP session.
 *
 * `ses_acp-<backend>_r<native>` when the agent's native id is already
 * link-safe, else `ses_acp-<backend>_e<base64url(native)>`. The backend id is
 * part of the key, so keys never collide with OpenCode HTTP ids and always
 * route to the backend that owns the session. Keys longer than 128 characters
 * are rejected, matching the router's session-id constraint.
 */

const PREFIX = 'ses_acp-';
const MAX_KEY_LENGTH = 128;
const RAW_NATIVE_PATTERN = /^[A-Za-z0-9_-]+$/;
export const BACKEND_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * True when `value` is shaped like an ACP session key. Shape only: garbage
 * base64url after `_e` still counts, since routing must not depend on
 * decodability.
 */
export const isAcpSessionKey = (value) => {
  if (typeof value !== 'string' || value.length > MAX_KEY_LENGTH) return false;
  if (!value.startsWith(PREFIX)) return false;
  const rest = value.slice(PREFIX.length);
  const sep = rest.search(/_[re]/);
  if (sep <= 0) return false;
  const backend = rest.slice(0, sep);
  const marker = rest[sep + 1];
  const native = rest.slice(sep + 2);
  if (!BACKEND_ID_PATTERN.test(backend) || !native) return false;
  if (marker === 'r') return RAW_NATIVE_PATTERN.test(native);
  return /^[A-Za-z0-9_-]+$/.test(native);
};

const toBase64Url = (value) => Buffer.from(value, 'utf8').toString('base64url');

const fromBase64Url = (value) => Buffer.from(value, 'base64url').toString('utf8');

/**
 * Encode a backend id plus an agent-native session id into a UI-safe key.
 * Throws when the result would exceed 128 characters.
 */
export const encode = (backendId, nativeId) => {
  if (typeof backendId !== 'string' || !BACKEND_ID_PATTERN.test(backendId)) {
    throw new Error(`Invalid ACP backend id: ${JSON.stringify(backendId)}`);
  }
  if (typeof nativeId !== 'string' || !nativeId) {
    throw new Error('Invalid ACP native session id: must be a non-empty string');
  }
  const raw = RAW_NATIVE_PATTERN.test(nativeId) ? nativeId : null;
  const key = raw === null
    ? `${PREFIX}${backendId}_e${toBase64Url(nativeId)}`
    : `${PREFIX}${backendId}_r${raw}`;
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`ACP session key exceeds ${MAX_KEY_LENGTH} characters`);
  }
  return key;
};

/**
 * Decode a key back into `{ backendId, nativeId }`, or `null` when the key
 * is not a well-formed ACP session key.
 */
export const decode = (key) => {
  if (!isAcpSessionKey(key)) return null;
  const rest = key.slice(PREFIX.length);
  const sep = rest.search(/_[re]/);
  const backendId = rest.slice(0, sep);
  const marker = rest[sep + 1];
  const encoded = rest.slice(sep + 2);
  if (marker === 'r') return { backendId, nativeId: encoded };
  try {
    const nativeId = fromBase64Url(encoded);
    if (!nativeId || toBase64Url(nativeId) !== encoded) return null;
    return { backendId, nativeId };
  } catch {
    return null;
  }
};

export const ACP_SESSION_KEY_MAX_LENGTH = MAX_KEY_LENGTH;
