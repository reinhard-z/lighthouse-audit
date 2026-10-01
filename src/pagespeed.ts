/**
 * The single PageSpeed Insights request (SPEC.md §6, §10).
 *
 * One call to `requestPageSpeed` makes at most one fetch, to a fixed endpoint,
 * with `redirect: "manual"`, and never retries. The API key travels only in the
 * `x-goog-api-key` header. Provider error text is used only to classify the
 * failure; it is never returned or logged.
 */
import { createAuditError, type FailureDetails, type FailureKind } from "./errors";
import { isRecord } from "./guards";
import { MAX_PROVIDER_RESPONSE_BYTES } from "./limits";
import type { AuditError, Device } from "./schemas";

export const PSI_ENDPOINT =
  "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";

/**
 * Partial-response field mask (§6 first candidate). It drops CrUX field data,
 * full-page screenshots, i18n, timing, entities, stack packs and environment.
 * Pending live validation in the opt-in smoke test (`scripts/smoke.ts`).
 */
export const PSI_FIELDS =
  "analysisUTCTimestamp,lighthouseResult(requestedUrl,finalUrl,finalDisplayedUrl,mainDocumentUrl,fetchTime,lighthouseVersion,runtimeError,runWarnings,configSettings/formFactor,categories,audits)";

/** Documented `strategy` enum values; the provider default is desktop, so always send one. */
const STRATEGY_BY_DEVICE: Record<Device, string> = { mobile: "MOBILE", desktop: "DESKTOP" };

/** Documented `category` enum values, sent as repeated parameters. */
const PSI_CATEGORIES = ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"] as const;

/** Prefix of a Lighthouse failure reported in a non-2xx provider body (§10). */
const LIGHTHOUSE_ERROR_PREFIX = "Lighthouse returned error:";

/** Google error reasons that mean the key or project was rejected. */
const KEY_OR_PROJECT_REJECTION_REASONS: ReadonlySet<string> = new Set([
  "api_key_invalid",
  "keyinvalid",
  "keyexpired",
  "api_key_expired",
  "api_key_service_blocked",
  "api_key_http_referrer_blocked",
  "api_key_ip_address_blocked",
  "api_key_android_app_blocked",
  "api_key_ios_app_blocked",
  "iprefererblocked",
  "service_disabled",
  "accessnotconfigured",
  "consumer_invalid",
  "consumer_suspended",
  "billing_disabled",
]);

const RATE_QUOTA_REASONS: ReadonlySet<string> = new Set([
  "ratelimitexceeded",
  "userratelimitexceeded",
  "rate_limit_exceeded",
]);
const DAILY_QUOTA_REASONS: ReadonlySet<string> = new Set(["dailylimitexceeded"]);
const GENERIC_QUOTA_REASONS: ReadonlySet<string> = new Set(["quotaexceeded", "resource_exhausted"]);

/** Longest Retry-After value, in seconds, that is passed on. */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/** Inputs for one provider request. `fetch` is injected so tests never call Google. */
export interface PageSpeedRequest {
  /** Validated, serialized target URL. */
  targetUrl: string;
  device: Device;
  apiKey: string;
  /** Covers the whole exchange, including reading the body. */
  timeoutMs: number;
  /** Caller cancellation (the MCP request's signal). */
  signal?: AbortSignal | undefined;
  fetch: typeof fetch;
}

/** Safe facts about the exchange, for logs only. */
export interface ProviderDiagnostics {
  /** HTTP status, when a response arrived. */
  status?: number;
  /** Bytes read from the body. */
  responseBytes?: number;
  /** Google error reason token or an internal tag such as "timeout"; never free text. */
  reason?: string;
}

export type PageSpeedOutcome =
  | { ok: true; body: unknown; diagnostics: ProviderDiagnostics }
  | { ok: false; error: AuditError; diagnostics: ProviderDiagnostics };

/** Builds the provider URL. It contains the target URL but never the key. */
export function buildPageSpeedUrl(targetUrl: string, device: Device): string {
  const url = new URL(PSI_ENDPOINT);
  url.searchParams.set("url", targetUrl);
  url.searchParams.set("strategy", STRATEGY_BY_DEVICE[device]);
  url.searchParams.set("locale", "en");
  for (const category of PSI_CATEGORIES) url.searchParams.append("category", category);
  url.searchParams.set("fields", PSI_FIELDS);
  return url.toString();
}

/**
 * Makes the one provider request and returns the parsed JSON body or a safe
 * error. Timers and listeners are released on every path.
 */
export async function requestPageSpeed(request: PageSpeedRequest): Promise<PageSpeedOutcome> {
  if (request.signal?.aborted) return failure("auditCancelled", { reason: "cancelled" });

  const controller = new AbortController();
  let abortCause: "timeout" | "cancelled" | undefined;
  const abortWith = (cause: "timeout" | "cancelled") => {
    abortCause ??= cause;
    controller.abort();
  };
  const timer = setTimeout(() => abortWith("timeout"), request.timeoutMs);
  const onCallerAbort = () => abortWith("cancelled");
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await request.fetch(buildPageSpeedUrl(request.targetUrl, request.device), {
        method: "GET",
        headers: { "x-goog-api-key": request.apiKey, accept: "application/json" },
        // workerd throws on "error"; reject any 3xx ourselves instead.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      if (abortCause !== undefined) return abortFailure(abortCause);
      return failure("upstreamUnavailable", { reason: "network" });
    }

    const status = response.status;
    if (status >= 300 && status < 400) {
      await cancelBody(response);
      return failure("invalidUpstreamResponse", { status, reason: "redirect" });
    }

    const body = await readBoundedBody(response, MAX_PROVIDER_RESPONSE_BYTES, controller.signal);
    if (body.kind === "aborted" || abortCause !== undefined) {
      return abortFailure(abortCause ?? "cancelled", { status });
    }

    if (status >= 200 && status < 300) {
      if (body.kind === "too-large") {
        return failure("responseTooLarge", { status, responseBytes: body.bytesRead });
      }
      if (body.kind === "error") {
        return failure("upstreamUnavailable", { status, reason: "body-read" });
      }
      const parsed = parseJson(body.bytes);
      if (parsed === undefined) {
        return failure("invalidUpstreamResponse", {
          status,
          responseBytes: body.bytes.byteLength,
          reason: "malformed-json",
        });
      }
      return {
        ok: true,
        body: parsed,
        diagnostics: { status, responseBytes: body.bytes.byteLength },
      };
    }

    const errorBody = body.kind === "ok" ? parseJson(body.bytes) : undefined;
    const classified = classifyProviderError(status, errorBody, response.headers);
    return {
      ok: false,
      error: createAuditError(classified.kind, classified.details),
      diagnostics: {
        status,
        ...(body.kind === "ok" && { responseBytes: body.bytes.byteLength }),
        ...(classified.reason !== undefined && { reason: classified.reason }),
      },
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function failure(kind: FailureKind, diagnostics: ProviderDiagnostics = {}): PageSpeedOutcome {
  return { ok: false, error: createAuditError(kind), diagnostics };
}

function abortFailure(
  cause: "timeout" | "cancelled",
  diagnostics: ProviderDiagnostics = {},
): PageSpeedOutcome {
  return cause === "timeout"
    ? failure("auditTimeout", { ...diagnostics, reason: "timeout" })
    : failure("auditCancelled", { ...diagnostics, reason: "cancelled" });
}

/** Discards an unread body so the connection can be released. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or errored; nothing left to release.
  }
}

type BodyReadResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "too-large"; bytesRead: number }
  | { kind: "aborted" }
  | { kind: "error" };

/**
 * Reads a (decompressed) response body up to `maxBytes`, whether or not a
 * Content-Length is present. Cancels the stream on overflow or abort.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BodyReadResult> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await cancelBody(response);
    return { kind: "too-large", bytesRead: 0 };
  }
  if (response.body === null) return { kind: "ok", bytes: new Uint8Array(0) };

  const reader = response.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) return { kind: "aborted" };
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { kind: "too-large", bytesRead: total };
      }
      chunks.push(value);
    }
  } catch {
    return signal.aborted ? { kind: "aborted" } : { kind: "error" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) return { kind: "aborted" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

/** Parses UTF-8 JSON; returns undefined when the bytes are not valid JSON. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** The parts of a Google API error body that are used for classification. */
interface GoogleErrorInfo {
  message: string | undefined;
  /** Lower-cased reason tokens from `errors[].reason`, `details[].reason` and `status`. */
  reasons: Set<string>;
  /** First reason in its original spelling, when it is a plain token safe to log. */
  loggableReason: string | undefined;
  /** Lower-cased quota limit names from ErrorInfo metadata. */
  quotaLimits: string[];
}

function readGoogleError(body: unknown): GoogleErrorInfo {
  const info: GoogleErrorInfo = {
    message: undefined,
    reasons: new Set(),
    loggableReason: undefined,
    quotaLimits: [],
  };
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) return info;

  if (typeof error.message === "string") info.message = error.message;
  const addReason = (value: unknown) => {
    if (typeof value !== "string") return;
    info.reasons.add(value.toLowerCase());
    if (info.loggableReason === undefined && /^[A-Za-z_]{1,64}$/.test(value)) {
      info.loggableReason = value;
    }
  };
  for (const item of Array.isArray(error.details) ? error.details : []) {
    if (!isRecord(item)) continue;
    addReason(item.reason);
    if (isRecord(item.metadata) && typeof item.metadata.quota_limit === "string") {
      info.quotaLimits.push(item.metadata.quota_limit.toLowerCase());
    }
  }
  for (const item of Array.isArray(error.errors) ? error.errors : []) {
    if (isRecord(item)) addReason(item.reason);
  }
  addReason(error.status);
  return info;
}

interface ClassifiedProviderError {
  kind: FailureKind;
  details: FailureDetails;
  reason: string | undefined;
}

/**
 * Maps a non-2xx, non-3xx provider response to a failure kind (§10). Quota,
 * key/project rejection and unrelated 4xx responses are kept distinct.
 */
function classifyProviderError(
  status: number,
  body: unknown,
  headers: Headers,
): ClassifiedProviderError {
  const info = readGoogleError(body);
  const reason = info.loggableReason;

  if (info.message?.startsWith(LIGHTHOUSE_ERROR_PREFIX)) {
    const code = /^\s*([A-Z][A-Z0-9_]{0,63})\b/.exec(
      info.message.slice(LIGHTHOUSE_ERROR_PREFIX.length),
    )?.[1];
    return { kind: "pageLoadFailed", details: { providerErrorCode: code }, reason: code };
  }

  const hasReason = (set: ReadonlySet<string>) => [...info.reasons].some((r) => set.has(r));
  const isDaily =
    hasReason(DAILY_QUOTA_REASONS) || info.quotaLimits.some((limit) => limit.includes("perday"));
  const isRate =
    hasReason(RATE_QUOTA_REASONS) ||
    info.quotaLimits.some((limit) => /perminute|per100seconds|persecond/.test(limit));
  if (status === 429 || isDaily || isRate || hasReason(GENERIC_QUOTA_REASONS)) {
    const details: FailureDetails = {
      retryAfterSeconds: status === 429 ? parseRetryAfter(headers.get("retry-after")) : undefined,
    };
    const kind: FailureKind = isDaily
      ? "dailyQuotaExceeded"
      : isRate
        ? "rateLimitExceeded"
        : "capacityExceeded";
    return { kind, details, reason };
  }

  if (hasReason(KEY_OR_PROJECT_REJECTION_REASONS)) {
    return { kind: "serviceUnavailable", details: {}, reason };
  }
  if (status >= 500) return { kind: "upstreamUnavailable", details: {}, reason };
  return { kind: "upstreamRejected", details: {}, reason };
}

/** Accepts only a delta-seconds Retry-After within a sane range. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return seconds > 0 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
}
