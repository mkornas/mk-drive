/** An error with an HTTP status the error handler turns into `{ ok: false, message }`. */
export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what = 'not found') => new HttpError(404, what);
export const badRequest = (what: string) => new HttpError(400, what);
export const forbidden = (what: string) => new HttpError(403, what);
