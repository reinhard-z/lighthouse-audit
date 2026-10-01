/**
 * Safe, typed failures (SPEC.md §10). Every message is fixed, service-authored
 * text; provider text never reaches a caller. A failure is identified by a
 * `FailureKind`, which selects the public code, message and `retryable` value.
 */
import { SAFE_PROVIDER_ERROR_CODE, type AuditError, type AuditErrorCode } from "./schemas";

interface FailureDefinition {
  code: AuditErrorCode;
  message: string;
  retryable: boolean;
}

/** All failure variants the service can report, with their fixed public text. */
const FAILURES = {
  invalidUrl: {
    code: "INVALID_URL",
    message: "Supply an absolute public HTTP(S) URL of at most 2,048 characters.",
    retryable: false,
  },
  unsupportedTarget: {
    code: "UNSUPPORTED_TARGET",
    message: "Only supported public, non-authenticated page URLs can be audited.",
    retryable: false,
  },
  serviceUnavailable: {
    code: "SERVICE_UNAVAILABLE",
    message: "Audits are temporarily unavailable.",
    retryable: false,
  },
  capacityExceeded: {
    code: "CAPACITY_EXCEEDED",
    message: "Analysis capacity is exhausted; do not retry automatically.",
    retryable: true,
  },
  rateLimitExceeded: {
    code: "CAPACITY_EXCEEDED",
    message: "The analysis provider's rate limit was reached; do not retry automatically.",
    retryable: true,
  },
  dailyQuotaExceeded: {
    code: "CAPACITY_EXCEEDED",
    message:
      "The analysis provider's daily quota is exhausted; do not retry automatically.",
    retryable: true,
  },
  auditTimeout: {
    code: "AUDIT_TIMEOUT",
    message: "The audit did not finish within the current time limit.",
    retryable: true,
  },
  auditCancelled: {
    // The spec defines no cancellation code; see the completion report.
    code: "AUDIT_TIMEOUT",
    message: "The audit was cancelled before it finished.",
    retryable: true,
  },
  pageLoadFailed: {
    code: "PAGE_LOAD_FAILED",
    message: "Google could not load or audit the requested public page.",
    retryable: false,
  },
  upstreamUnavailable: {
    code: "UPSTREAM_UNAVAILABLE",
    message: "The analysis provider is unavailable.",
    retryable: true,
  },
  upstreamRejected: {
    code: "UPSTREAM_UNAVAILABLE",
    message: "The analysis provider rejected the request.",
    retryable: false,
  },
  invalidUpstreamResponse: {
    code: "INVALID_UPSTREAM_RESPONSE",
    message: "The provider returned an unusable result.",
    retryable: true,
  },
  responseTooLarge: {
    code: "RESPONSE_TOO_LARGE",
    message: "This report exceeds the service's response limits.",
    retryable: false,
  },
  internalError: {
    code: "INTERNAL_ERROR",
    message: "The service failed unexpectedly.",
    retryable: true,
  },
} as const satisfies Record<string, FailureDefinition>;

export type FailureKind = keyof typeof FAILURES;

export interface FailureDetails {
  /** Provider code such as "NO_FCP"; dropped unless it matches the safe pattern. */
  providerErrorCode?: string | undefined;
  /** Only when backed by reliable provider information. */
  retryAfterSeconds?: number | undefined;
}

/** Builds the public error object for a failure kind. */
export function createAuditError(kind: FailureKind, details: FailureDetails = {}): AuditError {
  const definition: FailureDefinition = FAILURES[kind];
  const error: AuditError = {
    code: definition.code,
    message: definition.message,
    retryable: definition.retryable,
  };
  const { providerErrorCode, retryAfterSeconds } = details;
  if (providerErrorCode !== undefined && SAFE_PROVIDER_ERROR_CODE.test(providerErrorCode)) {
    error.providerErrorCode = providerErrorCode;
  }
  if (
    retryAfterSeconds !== undefined &&
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    error.retryAfterSeconds = retryAfterSeconds;
  }
  return error;
}
