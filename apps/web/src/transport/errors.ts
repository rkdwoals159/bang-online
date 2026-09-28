export type TransportErrorCode =
  | "NOT_CONNECTED"
  | "ACK_TIMEOUT"
  | "SESSION_EXPIRED"
  | "REQUEST_REJECTED"
  | "INVALID_RESPONSE"
  | "HTTP_REQUEST_FAILED"
  | "COMMAND_ID_REUSED";

export class BrowserTransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string = code) {
    super(message);
    this.code = code;
    this.name = "BrowserTransportError";
  }
}
