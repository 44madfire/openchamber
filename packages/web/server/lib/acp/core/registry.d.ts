import type fsp from 'node:fs/promises';

export declare const ACP_BACKENDS_FILE: 'acp-backends.json';

export interface AcpBackendEntry {
  id: string;
  label: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
  helper?: { config: Record<string, string> };
  cache?: { configOptions: unknown[]; at: string };
}

export interface AcpBackendRegistry {
  list(): Promise<AcpBackendEntry[]>;
  save(backends: AcpBackendEntry[]): Promise<AcpBackendEntry[]>;
  get(id: string): Promise<AcpBackendEntry | null>;
  readonly filePath: string;
}

export declare function createAcpBackendRegistry(options?: {
  dataDir: string;
  fsPromises?: typeof fsp;
  resolveCommand?: (command: string) => string | null;
}): AcpBackendRegistry;
