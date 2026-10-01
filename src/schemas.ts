/**
 * Tool input/output schemas (SPEC.md §4). Types are derived from these Zod
 * schemas. Everything here is immutable and built once at module scope.
 */
import * as z from "zod";

/** Lighthouse categories in the fixed visiting order used for selection (§7). */
export const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Metric keys accepted from an audit's `metricSavings`. */
export const METRIC_KEYS = ["LCP", "FCP", "TBT", "CLS", "INP"] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export const DEVICES = ["mobile", "desktop"] as const;
export type Device = (typeof DEVICES)[number];

export const AUDIT_ERROR_CODES = [
  "INVALID_URL",
  "UNSUPPORTED_TARGET",
  "SERVICE_UNAVAILABLE",
  "CAPACITY_EXCEEDED",
  "AUDIT_TIMEOUT",
  "PAGE_LOAD_FAILED",
  "UPSTREAM_UNAVAILABLE",
  "INVALID_UPSTREAM_RESPONSE",
  "RESPONSE_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;
export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];

/** Only provider error codes matching this pattern are passed through (§4). */
export const SAFE_PROVIDER_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const CategorySchema = z.enum(CATEGORIES);

/** Tool input. Unknown arguments are rejected (`additionalProperties: false`). */
export const RunLighthouseInputSchema = z.strictObject({
  url: z
    .string()
    .describe(
      "Absolute public http:// or https:// URL of one page, at most 2,048 characters. Add https:// to a bare domain.",
    ),
  device: z
    .enum(DEVICES)
    .default("mobile")
    .describe("Device profile to emulate. One call audits one device; defaults to mobile."),
});
export type RunLighthouseInput = z.infer<typeof RunLighthouseInputSchema>;

const EvidenceRowSchema = z.object({
  url: z.string().optional(),
  selector: z.string().optional(),
  snippet: z.string().optional(),
  wastedBytes: z.number().optional(),
  wastedMs: z.number().optional(),
});
export type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

const MetricSavingsSchema = z.object({
  LCP: z.number().optional(),
  FCP: z.number().optional(),
  TBT: z.number().optional(),
  CLS: z.number().optional(),
  INP: z.number().optional(),
});
export type MetricSavings = z.infer<typeof MetricSavingsSchema>;

const AuditIssueSchema = z.object({
  id: z.string(),
  categories: z.array(CategorySchema),
  kind: z.enum(["failed", "diagnostic"]),
  title: z.string(),
  description: z.string(),
  /** Original Lighthouse audit scale, 0..1. */
  score: z.number().nullable(),
  scoreDisplayMode: z.string(),
  displayValue: z.string().optional(),
  /** Provider estimates: milliseconds, except CLS (unitless). */
  metricSavings: MetricSavingsSchema.optional(),
  estimatedSavingsBytes: z.number().optional(),
  evidence: z.array(EvidenceRowSchema),
  evidenceTruncated: z.boolean(),
});
export type AuditIssue = z.infer<typeof AuditIssueSchema>;

/** Category score on the integer 0..100 scale; null when the provider gave none. */
const CategoryScoreSchema = z.number().int().min(0).max(100).nullable();

const AuditReportSchema = z.object({
  provider: z.literal("google-pagespeed-insights"),
  requestedUrl: z.string(),
  finalUrl: z.string().nullable(),
  device: z.enum(DEVICES),
  /** ISO 8601, service clock. */
  requestStartedAt: z.string(),
  /** ISO 8601, service clock. */
  completedAt: z.string(),
  providerFetchTime: z.string().nullable(),
  lighthouseVersion: z.string().nullable(),
  cachePolicy: z.literal("no-application-cache"),
  scores: z.object({
    performance: CategoryScoreSchema,
    accessibility: CategoryScoreSchema,
    "best-practices": CategoryScoreSchema,
    seo: CategoryScoreSchema,
  }),
  labMetrics: z.object({
    lcpMs: z.number().nullable(),
    fcpMs: z.number().nullable(),
    /** Unitless; zero is valid. */
    cls: z.number().nullable(),
    tbtMs: z.number().nullable(),
    speedIndexMs: z.number().nullable(),
  }),
  issues: z.array(AuditIssueSchema),
  manualChecks: z.array(
    z.object({ id: z.string(), title: z.string(), categories: z.array(CategorySchema) }),
  ),
  auditErrors: z.array(z.object({ id: z.string(), message: z.string() })),
  counts: z.object({
    failed: z.number().int().min(0),
    diagnostic: z.number().int().min(0),
    manual: z.number().int().min(0),
    errored: z.number().int().min(0),
    returnedIssues: z.number().int().min(0),
    omittedIssues: z.number().int().min(0),
  }),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});
export type AuditReport = z.infer<typeof AuditReportSchema>;

const AuditErrorSchema = z.object({
  code: z.enum(AUDIT_ERROR_CODES),
  /** Fixed, service-authored text; never provider text. */
  message: z.string(),
  /** A later explicit attempt may work; not a retry instruction. */
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().positive().optional(),
  providerErrorCode: z.string().regex(SAFE_PROVIDER_ERROR_CODE).optional(),
});
export type AuditError = z.infer<typeof AuditErrorSchema>;

/**
 * The tool's output envelope: a single object at the root, because MCP output
 * schemas must be object schemas. `report` is non-null exactly when `ok` is
 * true and `error` is non-null exactly when `ok` is false.
 */
export const AuditResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    ok: z.boolean(),
    /** Diagnostic correlation only; not a retrievable report ID. */
    requestId: z.string(),
    report: AuditReportSchema.nullable(),
    error: AuditErrorSchema.nullable(),
  })
  .refine(
    (result) =>
      result.ok
        ? result.report !== null && result.error === null
        : result.report === null && result.error !== null,
    { message: "report must be set exactly when ok is true, and error exactly when ok is false" },
  );
export type AuditResult = z.infer<typeof AuditResultSchema>;
