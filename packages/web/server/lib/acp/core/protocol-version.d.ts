export declare const ACP_PROTOCOL_VERSION: 1;

export declare class AcpVersionMismatchError extends Error {
  code: 'ACP_VERSION_MISMATCH';
  expected: 1;
  received: unknown;
  constructor(received: unknown);
}
