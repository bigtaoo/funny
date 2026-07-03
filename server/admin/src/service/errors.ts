// Endpoint error surfaced by every AdminService mixin. httpApi maps the `status` field to an HTTP status code.
/** Endpoint error (httpApi maps HTTP status codes based on the status field). */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AdminError';
  }
}
