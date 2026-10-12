import type { ChildProcess, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import type { readFileSync, statSync } from 'node:fs';

export declare const STDERR_RING_BYTES: number;

export declare class AcpSpawnError extends Error {
  code?: string;
  constructor(message: string, options?: { code?: string; cause?: unknown });
}

export declare function resolveAcpCommand(
  command: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    fsLike?: { statSync: typeof statSync };
  },
): string | null;

export declare function resolveNpmCmdShim(
  shimPath: string,
  options?: { fsLike?: { statSync: typeof statSync; readFileSync: typeof readFileSync } },
): { file: string; prefixArgs: string[] } | null;

export declare function buildSpawnTarget(
  command: string,
  args?: string[],
  options?: {
    resolvedPath?: string | null;
    platform?: NodeJS.Platform;
    fsLike?: { statSync: typeof statSync; readFileSync: typeof readFileSync };
  },
): { file: string; argv: string[]; windowsVerbatimArguments?: boolean };

export declare function killAcpProcessTree(
  child: ChildProcess | null | undefined,
  options?: {
    spawnSync?: typeof nodeSpawnSync;
    platform?: NodeJS.Platform;
  },
): Promise<void>;

export interface AcpSpawnedAgent {
  child: ChildProcess;
  resolvedPath: string;
  pid: number | undefined;
  getStderrTail(): string;
  kill(): Promise<void>;
}

export declare function spawnAcpAgent(options?: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  spawnImpl?: typeof nodeSpawn;
  registerProcess?: (entry: { pid: number; ownerPid: number; kind?: string; startTimeMs?: number | null; command?: string | null; invocation?: string | null }) => unknown;
  unregisterProcess?: (pid: number) => unknown;
  readStartTime?: (pid: number) => Promise<number | null>;
  envForResolve?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): AcpSpawnedAgent;
