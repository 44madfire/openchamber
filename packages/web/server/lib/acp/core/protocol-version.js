/**
 * The one ACP protocol version OpenChamber speaks. Defined once here; every
 * connect negotiates exactly this, and any other answer drops the connection
 * with {@link AcpVersionMismatchError}.
 */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Thrown when an agent answers `initialize` with a protocol version other
 * than {@link ACP_PROTOCOL_VERSION}. The connection is dropped: guessing at a
 * newer or older wire format would corrupt turns silently.
 */
export class AcpVersionMismatchError extends Error {
  constructor(received) {
    super(`ACP protocol version mismatch: expected ${ACP_PROTOCOL_VERSION}, agent answered ${received}`);
    this.name = 'AcpVersionMismatchError';
    this.code = 'ACP_VERSION_MISMATCH';
    this.expected = ACP_PROTOCOL_VERSION;
    this.received = received;
  }
}
