export function registerManagedProcess(entry: {
  pid?: number;
  ownerPid?: number;
  port?: number | null;
  binary?: string | null;
  runtime?: string;
  kind?: 'acp';
  startTimeMs?: number | null;
  command?: string | null;
  invocation?: string | null;
}): Promise<void>;

export function unregisterManagedProcess(pid?: number): Promise<void>;

export function reapOrphanedProcesses(options?: {
  log?: (message: string) => void;
}): Promise<{ inspected: number; reaped: number }>;

export function readProcessStartTimeMs(pid?: number): Promise<number | null>;
