export declare const BACKEND_ID_PATTERN: RegExp;
export declare const ACP_SESSION_KEY_MAX_LENGTH: number;

export declare function isAcpSessionKey(value: unknown): value is string;
export declare function encode(backendId: string, nativeId: string): string;
export declare function decode(key: string): { backendId: string; nativeId: string } | null;
