/**
 * Platform-aware directory normalization, shared by the session service and
 * the session index so both agree on what "the same directory" means.
 *
 * - `normalizeDirectory`: backslashes on Windows, forward slashes elsewhere;
 *   trailing separators stripped (drive roots keep theirs). On Windows,
 *   drive-relative (`C:`, `C:relative`), current-drive-rooted (`\foo`), and
 *   malformed-UNC spellings throw `ACP_INVALID_DIRECTORY`; only fully
 *   qualified drive paths (`X:\...`), valid UNC (`\\server\share\...`), and
 *   plain relative strings pass through.
 * - `directoryKey`: comparison key — case folds on Windows (case-insensitive
 *   filesystem), exact elsewhere.
 * - `canonicalDirectory`: validated + canonicalized — absolute, existing
 *   directory, no NUL, realpath-resolved (symlinks/junctions and `.`/`..`
 *   gone). The session create/open/list boundary resolves once and uses
 *   the canonical path everywhere (agent calls, index, filters, events,
 *   checkpoints), so aliased spellings cannot bind different roots.
 *   Failures throw `ACP_INVALID_DIRECTORY` (400 at the routes).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const isWindows = process.platform === 'win32';

const invalidDirectory = (detail) => Object.assign(
  new Error(detail ?? 'ACP session directory must be a non-empty string'),
  { name: 'AcpSessionError', code: 'ACP_INVALID_DIRECTORY' },
);

const assertValidWindowsSpelling = (trimmed) => {
  // Drive-letter spelling: must be fully qualified (`X:\...`). Bare `C:` and
  // drive-relative `C:relative` never mean `C:\` — reject before any rewrite.
  if (/^[a-zA-Z]:/.test(trimmed)) {
    if (!/^[a-zA-Z]:[\\/]/.test(trimmed)) {
      throw invalidDirectory(
        `ACP session directory must be a fully qualified drive path or UNC path: ${JSON.stringify(trimmed)}`,
      );
    }
    return;
  }
  // Leading-separator spelling: current-drive-rooted (`\foo`, `/foo`) or UNC.
  // Only a valid UNC (`\\server\share\...`) passes.
  if (/^[\\/]/.test(trimmed) && !/^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(trimmed)) {
    throw invalidDirectory(
      `ACP session directory must be a fully qualified drive path or UNC path: ${JSON.stringify(trimmed)}`,
    );
  }
};

export const normalizeDirectory = (directory) => {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw invalidDirectory();
  }
  const trimmed = directory.trim();
  if (isWindows) {
    assertValidWindowsSpelling(trimmed);
    let normalized = trimmed.replace(/\//g, '\\');
    if (/^[a-zA-Z]:\\+$/.test(normalized)) return `${normalized[0].toUpperCase()}:\\`;
    normalized = normalized.replace(/\\+$/, '');
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

export const canonicalDirectory = async (directory) => {
  const spelling = normalizeDirectory(directory);
  if (spelling.includes('\0')) {
    throw invalidDirectory('ACP session directory must not contain NUL');
  }
  if (!path.isAbsolute(spelling)) {
    throw invalidDirectory(`ACP session directory must be absolute: ${JSON.stringify(directory)}`);
  }
  let canonical;
  try {
    canonical = await fs.realpath(spelling);
  } catch {
    throw invalidDirectory(`ACP session directory does not exist: ${JSON.stringify(directory)}`);
  }
  let stats;
  try {
    stats = await fs.stat(canonical);
  } catch {
    throw invalidDirectory(`ACP session directory is not accessible: ${JSON.stringify(directory)}`);
  }
  if (!stats.isDirectory()) {
    throw invalidDirectory(`ACP session directory is not a directory: ${JSON.stringify(directory)}`);
  }
  return canonical;
};
