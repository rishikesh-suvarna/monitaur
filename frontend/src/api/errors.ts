/** Machine codes the backend sends in `{"error": "...", "code": "..."}`. */
export const SERVER_ERROR_CODES = [
  'unauthorized',
  'email_unverified',
  'forbidden',
  'not_found',
  'invalid',
  'limit_reached',
  'rate_limited',
  'conflict',
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

/** Codes the client assigns when there is no usable server code. */
export type ClientErrorCode = 'network' | 'timeout' | 'aborted' | 'bad_response' | 'server_error' | 'unknown';

export type ApiErrorCode = ServerErrorCode | ClientErrorCode;

export interface ApiErrorInit {
  status: number;
  code: ApiErrorCode;
  message: string;
  method: string;
  path: string;
  cause?: unknown;
}

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly method: string;
  readonly path: string;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.method = init.method;
    this.path = init.path;
  }

  /** e.g. "GET /servers · timed out after 10 s", for error states. */
  get summary(): string {
    return `${this.method} ${this.path} · ${this.message}`;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function hasErrorCode(error: unknown, code: ApiErrorCode): boolean {
  return isApiError(error) && error.code === code;
}

const isServerErrorCode = (value: unknown): value is ServerErrorCode =>
  typeof value === 'string' && (SERVER_ERROR_CODES as readonly string[]).includes(value);

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;

/** Fallback when the body carries no recognised code. */
export function codeFromStatus(status: number): ApiErrorCode {
  switch (status) {
    case HTTP_BAD_REQUEST:
    case HTTP_UNPROCESSABLE:
      return 'invalid';
    case HTTP_UNAUTHORIZED:
      return 'unauthorized';
    case HTTP_FORBIDDEN:
      return 'forbidden';
    case HTTP_NOT_FOUND:
      return 'not_found';
    case HTTP_CONFLICT:
      return 'conflict';
    case HTTP_TOO_MANY_REQUESTS:
      return 'rate_limited';
    default:
      return status >= HTTP_SERVER_ERROR_MIN ? 'server_error' : 'unknown';
  }
}

const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: 'Your session has expired. Sign in again.',
  email_unverified: 'Verify your email address to continue.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'Not found.',
  invalid: 'The request was not valid.',
  limit_reached: 'Your plan limit has been reached.',
  rate_limited: 'Too many requests. Try again in a moment.',
  conflict: 'That conflicts with something that already exists.',
  network: 'Could not reach the Monitaur API.',
  timeout: 'The request timed out.',
  aborted: 'The request was cancelled.',
  bad_response: 'The server sent a response we could not read.',
  server_error: 'The server had a problem handling the request.',
  unknown: 'Something went wrong.',
};

export function defaultMessage(code: ApiErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
}

/** Builds an ApiError from a non-2xx response. Never throws. */
export async function errorFromResponse(response: Response, method: string, path: string): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    const text = await response.text();
    if (text !== '') body = JSON.parse(text) as ErrorBody;
  } catch {
    body = null;
  }
  const code = isServerErrorCode(body?.code) ? body.code : codeFromStatus(response.status);
  const message = typeof body?.error === 'string' && body.error !== '' ? body.error : defaultMessage(code);
  return new ApiError({ status: response.status, code, message, method, path });
}

/** A short human message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return defaultMessage('unknown');
}
