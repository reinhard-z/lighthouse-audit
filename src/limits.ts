/**
 * Limits and defaults from SPEC.md Appendix A. They are design defaults, not
 * vendor guarantees; change them only with measurements.
 */

/** Maximum input URL length, in characters (§4). */
export const MAX_INPUT_URL_LENGTH = 2048;

/** Maximum MCP request body, in bytes (§8). */
export const MAX_MCP_REQUEST_BODY_BYTES = 32 * 1024;

/** Provider requests per tool invocation; there are no automatic retries (§6). */
export const PROVIDER_REQUESTS_PER_INVOCATION = 1;

/** Default provider timeout in milliseconds, including reading the body (§6). */
export const DEFAULT_PSI_TIMEOUT_MS = 55_000;

/**
 * Accepted range for the PSI_TIMEOUT_MS variable, in milliseconds. The upper
 * bound is the Appendix A default; values outside the range fail closed.
 */
export const MIN_PSI_TIMEOUT_MS = 1_000;
export const MAX_PSI_TIMEOUT_MS = DEFAULT_PSI_TIMEOUT_MS;

/** Maximum decompressed provider response, in bytes (§6). */
export const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * A provider timestamp more than this many milliseconds before
 * `requestStartedAt` produces a staleness warning (§5).
 */
export const STALE_PROVIDER_TIMESTAMP_MS = 5 * 60 * 1000;

/** Lighthouse's pass threshold for scored audits, on the 0..1 scale (§7). */
export const AUDIT_PASS_THRESHOLD = 0.9;

/** Issues selected per category, and in total (§7). */
export const MAX_ISSUES_PER_CATEGORY = 5;
export const MAX_ISSUES_TOTAL = 20;

/** Evidence rows per issue (§7). */
export const MAX_EVIDENCE_ROWS = 3;

/** Manual-check summaries, audit-error summaries and provider run warnings (§7). */
export const MAX_MANUAL_CHECKS = 10;
export const MAX_AUDIT_ERRORS = 10;
export const MAX_RUN_WARNINGS = 5;

/** Descriptive strings and snippets, in Unicode code points (§7). */
export const MAX_TEXT_LENGTH = 400;

/** Description length used by size-reduction step 3, in code points (§7). */
export const REDUCED_DESCRIPTION_LENGTH = 160;

/** URL fields, in Unicode code points (§7). */
export const MAX_URL_FIELD_LENGTH = 2048;

/** Maximum serialized `CallToolResult`, in UTF-8 bytes (§7). */
export const MAX_TOOL_RESULT_BYTES = 32 * 1024;
