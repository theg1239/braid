/**
 * Braid's refusals and how a failure answers over HTTP. Durable Object RPC keeps only an error's message, so a
 * refusal crosses RPC as a `Result` and becomes an `HttpError` again on the other side.
 */

/** A failure whose message is fixed text, safe to show to the person it concerns. */
export class ShownError extends Error {}
export class HttpError extends ShownError {
  constructor(public status: number, message: string, public retryAfter?: number, public code?: string) { super(message); }
}
/** What a person may read about a failure: Braid's own text, or `fallback` for anything that may carry upstream text. */
export const shown = (error: unknown, fallback: string) => error instanceof ShownError ? error.message : fallback;

export type Refusal = { ok: false; status: number; error: string; retryAfter?: number; code?: string };
export type Result<T> = { ok: true; data: T } | Refusal;

export const refusal = (error: HttpError): Refusal => ({ ok: false, status: error.status, error: error.message,
  ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}), ...(error.code ? { code: error.code } : {}) });
/** An `HttpError` as a refusal. Anything else is rethrown, unless a status and message say how to answer it. */
export function refused(error: unknown, status?: number, message?: string): Refusal {
  if (error instanceof HttpError) return refusal(error);
  if (status === undefined || message === undefined) throw error;
  return { ok: false, status, error: message };
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new HttpError(result.status, result.error, result.retryAfter, result.code);
  return result.data;
}

const ARTIFACTS_CODES = ['ALREADY_EXISTS', 'NOT_FOUND', 'CREATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS', 'INVALID_INPUT', 'INVALID_REPO_NAME',
  'INVALID_TTL', 'INVALID_URL', 'REMOTE_AUTH_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'MEMORY_LIMIT', 'INTERNAL_ERROR'] as const satisfies readonly ArtifactsErrorCode[];
/** Artifacts rejects with `ArtifactsError`, an interface rather than a class, so its typed `code` identifies it. */
export const artifactsCode = (error: unknown): ArtifactsErrorCode | undefined =>
  error instanceof Error && 'code' in error ? ARTIFACTS_CODES.find(code => code === error.code) : undefined;
export const artifactsFailed = (error: unknown, ...codes: ArtifactsErrorCode[]) => codes.some(code => code === artifactsCode(error));

/**
 * Logs a failure Braid carries on past, by its typed fields. Only Braid's own fixed text is logged as a message:
 * anything else may carry upstream text or a credential.
 */
export function logFailure(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  const typed = error instanceof Error ? {
    error: error.name, ...(error instanceof ShownError ? { message: error.message } : {}),
    ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    ...('status' in error && typeof error.status === 'number' ? { status: error.status } : {}),
  } : { error: typeof error };
  console.warn(JSON.stringify({ event, ...fields, ...typed }));
}

/**
 * The answer for a thrown error. Only Braid's own refusals keep their message, since anything else may carry
 * upstream text. A Durable Object that reports itself `overloaded` asks the caller to come back shortly.
 */
export function errorAnswer(error: unknown, fallback: string): { status: number; error: string; code?: string; retryAfter?: number } {
  if (error instanceof HttpError) return { status: error.status, error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) };
  if (error instanceof Error && 'overloaded' in error && error.overloaded === true) return { status: 503, error: 'Service unavailable. Try again shortly.', retryAfter: 1 };
  return { status: 500, error: fallback };
}
