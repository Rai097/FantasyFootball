/** Error thrown by every API wrapper. Mirrors the server's `{ error, hint?, code? }` body. */
export class ApiError extends Error {
  hint?: string;
  status: number;
  /** Machine-readable reason for auth refusals (e.g. "signin", "not_allowed", "league", "csrf"). */
  code?: string;
  constructor(message: string, status: number, hint?: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.hint = hint;
    this.code = code;
  }
}
