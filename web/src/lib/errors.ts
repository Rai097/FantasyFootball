/** Error thrown by every API wrapper. Mirrors the server's `{ error, hint? }` body. */
export class ApiError extends Error {
  hint?: string;
  status: number;
  constructor(message: string, status: number, hint?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.hint = hint;
  }
}
