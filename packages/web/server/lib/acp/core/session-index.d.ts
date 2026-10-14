export interface AcpSessionEntry {
  key: string;
  backendId: string;
  nativeId: string;
  cwd: string;
  title: string;
  userTitle?: string;
  parentKey?: string;
  created: number;
  updated: number;
  lastConfig?: Record<string, string | number | boolean>;
  messageIds?: string[];
}

export declare function displayTitle(entry: AcpSessionEntry | null | undefined): string;

export interface AcpSessionIndex {
  readonly filePath: string;
  get(key: string): Promise<AcpSessionEntry | null>;
  upsert(key: string, patch: Partial<AcpSessionEntry> & { key?: string }): Promise<AcpSessionEntry>;
  remove(key: string): Promise<boolean>;
  listAll(): Promise<AcpSessionEntry[]>;
  listByDirectory(cwd: string): Promise<AcpSessionEntry[]>;
}

export declare function createAcpSessionIndex(options?: {
  dataDir: string;
  fsPromises?: { readFile: (...args: never[]) => Promise<string>; writeFile: (...args: never[]) => Promise<void>; rename: (...args: never[]) => Promise<void>; mkdir: (...args: never[]) => Promise<unknown> };
}): AcpSessionIndex;
