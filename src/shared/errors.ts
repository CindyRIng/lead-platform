/** 统一错误模型（冻结） */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'CONFLICT',
  'RUN_IN_PROGRESS',
  'QUOTA_EXHAUSTED',
  'SOURCE_SESSION_INVALID',
  'SOURCE_VERIFICATION_PENDING',
  'SOURCE_UNAVAILABLE',
  'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_BAD_REQUEST',
  'CUSTOMS_PERMISSION_DENIED',
  'UNSUPPORTED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class LeadError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts?: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown>; cause?: unknown }) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = 'LeadError';
    this.code = code;
    this.httpStatus = opts?.httpStatus ?? httpStatusFor(code);
    this.retryable = opts?.retryable ?? retryableFor(code);
    this.details = opts?.details;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION_ERROR':
    case 'UNSUPPORTED':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'RUN_IN_PROGRESS':
    case 'QUOTA_EXHAUSTED':
    case 'SOURCE_SESSION_INVALID':
    case 'CUSTOMS_PERMISSION_DENIED':
      return 409;
    case 'SOURCE_VERIFICATION_PENDING':
    case 'RATE_LIMITED':
    case 'UPSTREAM_RATE_LIMITED':
      return 429;
    case 'SOURCE_UNAVAILABLE':
      return 503;
    case 'UPSTREAM_BAD_REQUEST':
      return 502;
    default:
      return 500;
  }
}

export function retryableFor(code: ErrorCode): boolean {
  return ['SOURCE_UNAVAILABLE', 'UPSTREAM_RATE_LIMITED', 'RATE_LIMITED', 'INTERNAL_ERROR'].includes(code);
}

export function toLeadError(err: unknown): LeadError {
  if (err instanceof LeadError) return err;
  return new LeadError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err), { cause: err });
}
