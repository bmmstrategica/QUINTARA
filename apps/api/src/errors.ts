/** An error the client is meant to see. Anything else becomes a generic 500. */
export class HttpError extends Error {
  readonly status: number;
  readonly fields: Record<string, string>;

  constructor(status: number, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export const unauthenticated = () => new HttpError(401, 'Sign in to continue.');
export const forbidden = (message = 'Your membership does not include this.') => new HttpError(403, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

export function validation(issues: { path: PropertyKey[]; message: string }[]): HttpError {
  const fields: Record<string, string> = {};
  for (const issue of issues) fields[String(issue.path[0] ?? 'form')] ??= issue.message;
  return new HttpError(422, 'Some details need attention.', fields);
}
