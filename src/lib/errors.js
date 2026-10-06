// HTTP-aware errors. `expose` marks messages that are safe to show to the user verbatim.
export class HttpError extends Error {
  constructor(status, message, { code, expose = true, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = expose;
    this.details = details;
  }
}

export const notFound = (what) => new HttpError(404, `${what} not found`, { code: 'NOT_FOUND' });
export const badRequest = (msg, code = 'BAD_REQUEST') => new HttpError(400, msg, { code });
export const unprocessable = (msg, code, details) => new HttpError(422, msg, { code, details });
