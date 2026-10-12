/**
 * Git checkpoints per turn (ACP_PLAN.md D12/D13/D14): shadow-repo snapshots,
 * turn diffs in the DiffView shape, byte-exact file restore, ref garbage
 * collection. Host-agnostic; not wired into any route yet.
 */

export class AcpCheckpointsError extends Error {
  code: string;
  constructor(code: string, message: string, options?: { cause?: unknown });
}

export type CheckpointPhase = 'start' | 'end';

export interface CheckpointSnapshot {
  /** The snapshot's tree id (hex, sha1 or sha256 length). */
  tree: string;
}

export interface CheckpointFileDiff {
  /** Work-tree-relative path with forward slashes. */
  file: string;
  /** Unified patch for this file (`diff --git` form), `''` when unchanged. */
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'deleted' | 'modified';
}

export interface CheckpointSkippedPath {
  file: string;
  reason:
    | 'protected'
    | 'gitlink'
    | 'non-blob'
    | 'outside-root'
    | 'obstructed-ancestor'
    | 'would-replace-symlink'
    | 'nested-repo'
    | 'non-empty-dir'
    | 'ignored'
    | 'symlink';
}

export interface CheckpointRestoreResult {
  /**
   * Target-tree members whose bytes or mode actually changed on disk.
   * Identical files are left alone and unreported.
   */
  restored: string[];
  /**
   * Members of the current tree (explicit `current`, else the latest
   * snapshot state) absent from the target that were deleted from disk.
   * Members of neither tree are never touched.
   */
  removed: string[];
  /** Paths refused with a reason instead of restored/removed. */
  skipped: CheckpointSkippedPath[];
}

export interface CheckpointGcResult {
  deletedRefs: number;
}

export interface CheckpointStoreOptions {
  /** OpenChamber data dir; shadow repos live under `<dataDir>/checkpoints/`. */
  dataDir: string;
  /** Git binary. Defaults to `git` from PATH. */
  git?: string;
  /** Base environment for git calls, scrubbed of inherited `GIT_*` vars. */
  environment?: NodeJS.ProcessEnv;
  /** Per-git-call timeout in ms. Defaults to 120_000. */
  timeoutMs?: number;
}

export interface CheckpointStore {
  snapshot(args: { cwd: string; sessionKey: string; turn: number; phase: CheckpointPhase }): Promise<CheckpointSnapshot>;
  diff(args: { cwd: string; from: string; to: string }): Promise<CheckpointFileDiff[]>;
  restore(args: { cwd: string; tree: string; current?: string }): Promise<CheckpointRestoreResult>;
  gc(args: { sessionKey: string; cwd?: string }): Promise<CheckpointGcResult>;
}

export function createCheckpointStore(options: CheckpointStoreOptions): CheckpointStore;

/** Canonical filesystem path for `cwd`. Exported for tests. */
export function canonicalCwd(cwd: string): Promise<string>;

/** Normalize `cwd` for shadow-dir hashing. Exported for tests. */
export function normalizeCwd(cwd: string): string;

/** Shadow repo dir for a project. Exported for tests. */
export function shadowDirFor(dataDir: string, cwd: string): string;
