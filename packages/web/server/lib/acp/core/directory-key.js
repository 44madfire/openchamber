/**
 * Platform-aware directory normalization, shared by the session service and
 * the session index so both agree on what "the same directory" means.
 *
 * - `normalizeDirectory`: backslashes on Windows, forward slashes elsewhere;
 *   trailing separators stripped (drive roots keep theirs).
 * - `directoryKey`: comparison key — case folds on Windows (case-insensitive
 *   filesystem), exact elsewhere.
 */
const isWindows = process.platform === 'win32';

const invalidDirectory = () => Object.assign(
  new Error('ACP session directory must be a non-empty string'),
  { name: 'AcpSessionError', code: 'ACP_INVALID_DIRECTORY' },
);
export const normalizeDirectory = (directory) => {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw invalidDirectory();
  }
  const trimmed = directory.trim();
  if (isWindows) {
    let normalized = trimmed.replace(/\//g, '\\');
    if (/^[a-zA-Z]:\\?$/.test(normalized)) return `${normalized[0].toUpperCase()}:\\`;
    normalized = normalized.replace(/\\+$/, '');
    if (/^[a-zA-Z]:$/.test(normalized)) return `${normalized.toUpperCase()}:\\`;
    return normalized;
  }
  const collapsed = trimmed.replace(/\/+/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed;
};

export const directoryKey = (directory) => {
  const normalized = normalizeDirectory(directory);
  return isWindows ? normalized.toLowerCase() : normalized;
};
