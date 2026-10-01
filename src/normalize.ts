/**
 * Pure, deterministic conversion of a projected PSI response into a bounded
 * report (SPEC.md §4 field sources, §5, §7).
 *
 * `extractReportDraft` validates the relevant structure and classifies,
 * ranks and selects findings. `fitAuditResult` then applies the size-reduction
 * steps until the serialized tool result fits the byte cap. Neither function
 * performs I/O or reads the clock.
 *
 * Titles, descriptions, URLs and snippets come from the audited page and from
 * Google. They are untrusted data: they are bounded here and never interpreted.
 */
import { createAuditError } from "./errors";
import { finiteNumber, isRecord, nonEmptyString } from "./guards";
import {
  AUDIT_PASS_THRESHOLD,
  MAX_AUDIT_ERRORS,
  MAX_EVIDENCE_ROWS,
  MAX_ISSUES_PER_CATEGORY,
  MAX_MANUAL_CHECKS,
  MAX_RUN_WARNINGS,
  MAX_TEXT_LENGTH,
  MAX_URL_FIELD_LENGTH,
  REDUCED_DESCRIPTION_LENGTH,
  STALE_PROVIDER_TIMESTAMP_MS,
} from "./limits";
import {
  CATEGORIES,
  METRIC_KEYS,
  type AuditError,
  type AuditIssue,
  type AuditReport,
  type AuditResult,
  type Category,
  type Device,
  type EvidenceRow,
  type MetricSavings,
} from "./schemas";
import { failureResult, serializedToolResultBytes, successResult } from "./tool-result";

/** Stable service warnings (§5, §7). */
export const WARNINGS = {
  scoreVariance: "Scores can vary between runs; a single run is not a stable measurement.",
  accessibilityScope:
    "Automated accessibility checks are not a complete accessibility assessment.",
  labData:
    "Metrics are lab measurements from one emulated run, not real-user Core Web Vitals; TBT is not INP.",
  seoScope: "An SEO score, including 100, is not a search-ranking guarantee.",
  redirected: "The final URL differs from the requested URL; the audit describes the redirect target.",
  staleProviderTimestamp:
    "The provider's measurement time is more than five minutes before this request started; the result may not reflect the latest deployment.",
  unclassifiedAudits:
    "Some audits had an unrecognized display mode or a missing score and are reported as diagnostics.",
  reducedEvidence: "Evidence was reduced to one row per issue to fit the response size limit.",
  removedEvidence: "Evidence was removed to fit the response size limit.",
  shortenedDescriptions: "Issue descriptions were shortened to fit the response size limit.",
  removedDescriptions: "Issue descriptions were removed to fit the response size limit.",
  droppedIssues: "Lower-ranked issues were removed to fit the response size limit.",
  shortenedSummaries:
    "Manual-check and audit-error lists were shortened to fit the response size limit.",
} as const;

const CATEGORY_LABELS: Record<Category, string> = {
  performance: "performance",
  accessibility: "accessibility",
  "best-practices": "best practices",
  seo: "SEO",
};

/** Lab metric field sources and their expected units (§4). */
const LAB_METRIC_SOURCES = [
  { field: "lcpMs", auditId: "largest-contentful-paint", unit: "millisecond", label: "LCP" },
  { field: "fcpMs", auditId: "first-contentful-paint", unit: "millisecond", label: "FCP" },
  { field: "cls", auditId: "cumulative-layout-shift", unit: "unitless", label: "CLS" },
  { field: "tbtMs", auditId: "total-blocking-time", unit: "millisecond", label: "TBT" },
  { field: "speedIndexMs", auditId: "speed-index", unit: "millisecond", label: "Speed Index" },
] as const;

/** Audit-ref groups that never produce findings: lab metrics and raw data (§7). */
const EXCLUDED_GROUPS: ReadonlySet<unknown> = new Set(["metrics", "hidden"]);

/** Display modes whose score is compared with the pass threshold. */
const SCORED_MODES: ReadonlySet<string> = new Set(["binary", "numeric", "metricSavings"]);

/** Metric savings that order performance candidates, in milliseconds. */
const RANKING_METRICS = ["LCP", "FCP", "TBT"] as const;

/** Longest scoreDisplayMode string carried into the output. */
const MAX_DISPLAY_MODE_LENGTH = 64;

export interface NormalizeContext {
  /** Validated, serialized target URL. */
  requestedUrl: string;
  device: Device;
  requestStartedAt: Date;
  completedAt: Date;
}

/** A selected issue plus the category whose quota it used (for size reduction). */
interface SelectedIssue {
  issue: AuditIssue;
  selectedBy: Category;
}

/** An intermediate report that still knows how issues were selected. */
export interface ReportDraft {
  core: Omit<AuditReport, "issues" | "manualChecks" | "auditErrors" | "counts" | "truncated" | "warnings">;
  issues: SelectedIssue[];
  manualChecks: AuditReport["manualChecks"];
  auditErrors: AuditReport["auditErrors"];
  /** Counted over unique audit IDs before any truncation. */
  totals: { failed: number; diagnostic: number; manual: number; errored: number };
  truncated: boolean;
  warnings: string[];
}

export type DraftOutcome =
  | { ok: true; draft: ReportDraft }
  | { ok: false; error: AuditError; reason: string };

/**
 * Validates and normalizes a projected PSI response body. A Lighthouse runtime
 * error is a failure, not a partial report.
 */
export function extractReportDraft(body: unknown, context: NormalizeContext): DraftOutcome {
  const invalid = (reason: string): DraftOutcome => ({
    ok: false,
    error: createAuditError("invalidUpstreamResponse"),
    reason,
  });
  if (!isRecord(body)) return invalid("body-not-object");
  const lighthouse = body.lighthouseResult;
  if (!isRecord(lighthouse)) return invalid("missing-lighthouse-result");

  const runtimeError = lighthouse.runtimeError;
  // Older Lighthouse versions report success as runtimeError.code "NO_ERROR".
  if (isRecord(runtimeError) && runtimeError.code !== "NO_ERROR") {
    const code = typeof runtimeError.code === "string" ? runtimeError.code : undefined;
    return {
      ok: false,
      error: createAuditError("pageLoadFailed", { providerErrorCode: code }),
      reason: "runtime-error",
    };
  }

  const categories = lighthouse.categories;
  const audits = lighthouse.audits;
  if (!isRecord(categories) || !isRecord(audits)) return invalid("missing-categories-or-audits");

  const warnings: string[] = [];
  const reportWarnings: string[] = [];
  let truncated = false;

  // Provider run warnings come first, bounded in count and length.
  const runWarnings = Array.isArray(lighthouse.runWarnings)
    ? lighthouse.runWarnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  if (runWarnings.length > MAX_RUN_WARNINGS) truncated = true;
  for (const warning of runWarnings.slice(0, MAX_RUN_WARNINGS)) {
    warnings.push(truncateText(warning, MAX_TEXT_LENGTH));
  }

  const scores = extractScores(categories, reportWarnings);
  const labMetrics = extractLabMetrics(audits, reportWarnings);

  const finalUrlSource =
    nonEmptyString(lighthouse.finalDisplayedUrl) ??
    nonEmptyString(lighthouse.mainDocumentUrl) ??
    nonEmptyString(lighthouse.finalUrl);
  const finalUrl =
    finalUrlSource === undefined ? null : truncateText(finalUrlSource, MAX_URL_FIELD_LENGTH);
  if (finalUrl !== null && finalUrl !== context.requestedUrl) {
    reportWarnings.push(WARNINGS.redirected);
  }

  const fetchTimeSource =
    nonEmptyString(lighthouse.fetchTime) ?? nonEmptyString(body.analysisUTCTimestamp);
  const providerFetchTime =
    fetchTimeSource === undefined ? null : truncateText(fetchTimeSource, MAX_TEXT_LENGTH);
  if (providerFetchTime !== null) {
    const providerTime = Date.parse(providerFetchTime);
    if (
      Number.isFinite(providerTime) &&
      context.requestStartedAt.getTime() - providerTime > STALE_PROVIDER_TIMESTAMP_MS
    ) {
      reportWarnings.push(WARNINGS.staleProviderTimestamp);
    }
  }

  const versionSource = nonEmptyString(lighthouse.lighthouseVersion);
  const lighthouseVersion =
    versionSource === undefined ? null : truncateText(versionSource, MAX_TEXT_LENGTH);

  const findings = classifyAudits(categories, audits);
  if (findings.unclassified) reportWarnings.push(WARNINGS.unclassifiedAudits);
  const issues = selectIssues(findings.candidates);

  const omitted = findings.candidates.length - issues.length;
  if (omitted > 0) truncated = true;
  if (issues.some(({ issue }) => issue.evidenceTruncated)) truncated = true;
  if (findings.manualChecks.length > MAX_MANUAL_CHECKS) truncated = true;
  if (findings.auditErrors.length > MAX_AUDIT_ERRORS) truncated = true;

  warnings.push(
    ...reportWarnings,
    WARNINGS.scoreVariance,
    WARNINGS.labData,
    WARNINGS.accessibilityScope,
    WARNINGS.seoScope,
  );

  return {
    ok: true,
    draft: {
      core: {
        provider: "google-pagespeed-insights",
        requestedUrl: context.requestedUrl,
        finalUrl,
        device: context.device,
        requestStartedAt: context.requestStartedAt.toISOString(),
        completedAt: context.completedAt.toISOString(),
        providerFetchTime,
        lighthouseVersion,
        cachePolicy: "no-application-cache",
        scores,
        labMetrics,
      },
      issues,
      manualChecks: findings.manualChecks.slice(0, MAX_MANUAL_CHECKS),
      auditErrors: findings.auditErrors.slice(0, MAX_AUDIT_ERRORS),
      totals: {
        failed: findings.candidates.filter((c) => c.issue.kind === "failed").length,
        diagnostic: findings.candidates.filter((c) => c.issue.kind === "diagnostic").length,
        manual: findings.manualChecks.length,
        errored: findings.auditErrors.length,
      },
      truncated,
      warnings,
    },
  };
}

/** Category scores on the 0..100 scale; null (with a warning) when absent or invalid. */
function extractScores(
  categories: Record<string, unknown>,
  warnings: string[],
): AuditReport["scores"] {
  const scoreOf = (category: Category): number | null => {
    const entry = categories[category];
    const score = isRecord(entry) ? finiteNumber(entry.score) : undefined;
    if (score === undefined || score < 0 || score > 1) {
      warnings.push(`No ${CATEGORY_LABELS[category]} score was returned.`);
      return null;
    }
    return Math.round(score * 100);
  };
  return {
    performance: scoreOf("performance"),
    accessibility: scoreOf("accessibility"),
    "best-practices": scoreOf("best-practices"),
    seo: scoreOf("seo"),
  };
}

/**
 * Lab metrics from the five metric audits' `numericValue`, accepted only with
 * the expected unit. Milliseconds are rounded to integers, CLS to 3 decimals.
 */
function extractLabMetrics(
  audits: Record<string, unknown>,
  warnings: string[],
): AuditReport["labMetrics"] {
  const metrics: AuditReport["labMetrics"] = {
    lcpMs: null,
    fcpMs: null,
    cls: null,
    tbtMs: null,
    speedIndexMs: null,
  };
  for (const source of LAB_METRIC_SOURCES) {
    const audit = audits[source.auditId];
    const value = isRecord(audit) ? finiteNumber(audit.numericValue) : undefined;
    if (value === undefined || !isRecord(audit) || audit.numericUnit !== source.unit) {
      warnings.push(`Lab metric ${source.label} was unavailable or used an unexpected unit.`);
      continue;
    }
    metrics[source.field] =
      source.unit === "unitless" ? Math.round(value * 1000) / 1000 : Math.round(value);
  }
  return metrics;
}

/** Where an audit appears in one category's `auditRefs`. */
interface RefPosition {
  index: number;
  weight: number;
}

/** A failed or diagnostic issue before selection. */
interface Candidate {
  issue: AuditIssue;
  positions: Map<Category, RefPosition>;
}

interface Findings {
  /** In order of first appearance across the category visiting order. */
  candidates: Candidate[];
  manualChecks: AuditReport["manualChecks"];
  auditErrors: AuditReport["auditErrors"];
  /** True when any audit fell back to diagnostic due to an unknown mode or missing score. */
  unclassified: boolean;
}

/**
 * Associates audits with categories through `auditRefs` (excluding the
 * `metrics` and `hidden` groups) and classifies each unique audit by its
 * `scoreDisplayMode` (§7 classification table).
 */
function classifyAudits(
  categories: Record<string, unknown>,
  audits: Record<string, unknown>,
): Findings {
  const positionsById = new Map<string, Map<Category, RefPosition>>();
  for (const category of CATEGORIES) {
    const entry = categories[category];
    const refs = isRecord(entry) && Array.isArray(entry.auditRefs) ? entry.auditRefs : [];
    refs.forEach((ref: unknown, index) => {
      if (!isRecord(ref) || typeof ref.id !== "string" || EXCLUDED_GROUPS.has(ref.group)) return;
      const positions = positionsById.get(ref.id) ?? new Map<Category, RefPosition>();
      if (!positions.has(category)) {
        positions.set(category, { index, weight: finiteNumber(ref.weight) ?? 0 });
      }
      positionsById.set(ref.id, positions);
    });
  }

  const findings: Findings = { candidates: [], manualChecks: [], auditErrors: [], unclassified: false };
  for (const [id, positions] of positionsById) {
    const audit = audits[id];
    if (!isRecord(audit)) continue;
    const categoriesOfAudit = CATEGORIES.filter((category) => positions.has(category));
    const mode = typeof audit.scoreDisplayMode === "string" ? audit.scoreDisplayMode : undefined;
    const title = truncateText(nonEmptyString(audit.title) ?? id, MAX_TEXT_LENGTH);

    if (mode === "notApplicable") continue;
    if (mode === "manual") {
      findings.manualChecks.push({ id, title, categories: categoriesOfAudit });
      continue;
    }
    if (mode === "error") {
      const message = nonEmptyString(audit.errorMessage) ?? "The audit reported an error without a message.";
      findings.auditErrors.push({ id, message: truncateText(message, MAX_TEXT_LENGTH) });
      continue;
    }

    const score = finiteNumber(audit.score);
    let kind: AuditIssue["kind"];
    if (mode !== undefined && SCORED_MODES.has(mode) && score !== undefined) {
      if (score >= AUDIT_PASS_THRESHOLD) continue;
      kind = "failed";
    } else if (mode === "informative") {
      kind = "diagnostic";
    } else {
      // Unknown mode, or a scored mode without a usable score: never "failed".
      kind = "diagnostic";
      findings.unclassified = true;
    }

    const issue = buildIssue(id, audit, title, mode, score, kind, categoriesOfAudit);
    const hasSavings = issue.metricSavings !== undefined || issue.estimatedSavingsBytes !== undefined;
    if (mode === "informative" && issue.evidence.length === 0 && !hasSavings) continue;
    findings.candidates.push({ issue, positions });
  }
  return findings;
}

function buildIssue(
  id: string,
  audit: Record<string, unknown>,
  title: string,
  mode: string | undefined,
  score: number | undefined,
  kind: AuditIssue["kind"],
  categories: Category[],
): AuditIssue {
  const rows = extractEvidence(audit.details);
  const issue: AuditIssue = {
    id,
    categories,
    kind,
    title,
    description: truncateText(nonEmptyString(audit.description) ?? "", MAX_TEXT_LENGTH),
    score: score ?? null,
    scoreDisplayMode: truncateText(mode ?? "unknown", MAX_DISPLAY_MODE_LENGTH),
    evidence: rows.slice(0, MAX_EVIDENCE_ROWS),
    evidenceTruncated: rows.length > MAX_EVIDENCE_ROWS,
  };
  const displayValue = nonEmptyString(audit.displayValue);
  if (displayValue !== undefined) issue.displayValue = truncateText(displayValue, MAX_TEXT_LENGTH);
  const metricSavings = extractMetricSavings(audit.metricSavings);
  if (metricSavings !== undefined) issue.metricSavings = metricSavings;
  const savingsBytes = isRecord(audit.details) ? finiteNumber(audit.details.overallSavingsBytes) : undefined;
  if (savingsBytes !== undefined && savingsBytes > 0) issue.estimatedSavingsBytes = savingsBytes;
  return issue;
}

/** Known metric keys with finite values greater than zero; undefined when none. */
function extractMetricSavings(value: unknown): MetricSavings | undefined {
  if (!isRecord(value)) return undefined;
  const savings: MetricSavings = {};
  let found = false;
  for (const key of METRIC_KEYS) {
    const amount = finiteNumber(value[key]);
    if (amount !== undefined && amount > 0) {
      savings[key] = amount;
      found = true;
    }
  }
  return found ? savings : undefined;
}

/**
 * Evidence rows from `table` and `opportunity` details, and from tables nested
 * one level inside a `list`, in provider order. Collects at most one row more
 * than the cap so truncation can be detected. Other detail types are ignored.
 */
function extractEvidence(details: unknown): EvidenceRow[] {
  if (!isRecord(details)) return [];
  const tables: unknown[] = [];
  if (details.type === "table" || details.type === "opportunity") {
    tables.push(details.items);
  } else if (details.type === "list" && Array.isArray(details.items)) {
    for (const nested of details.items) {
      if (isRecord(nested) && nested.type === "table") tables.push(nested.items);
    }
  }

  const rows: EvidenceRow[] = [];
  for (const items of tables) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const row = evidenceRowOf(item);
      if (row !== undefined) rows.push(row);
      if (rows.length > MAX_EVIDENCE_ROWS) return rows;
    }
  }
  return rows;
}

/** Maps listed fields of one table item; undefined when nothing usable remains. */
function evidenceRowOf(item: unknown): EvidenceRow | undefined {
  if (!isRecord(item)) return undefined;
  const row: EvidenceRow = {};
  const url = nonEmptyString(item.url) ?? sourceLocationUrl(item);
  // Embedded images (data: URLs) are discarded, not shortened.
  if (url !== undefined && !/^data:/i.test(url)) row.url = truncateText(url, MAX_URL_FIELD_LENGTH);
  if (isRecord(item.node)) {
    const selector = nonEmptyString(item.node.selector);
    if (selector !== undefined) row.selector = truncateText(selector, MAX_TEXT_LENGTH);
    const snippet = nonEmptyString(item.node.snippet);
    if (snippet !== undefined) row.snippet = truncateText(stripDataUris(snippet), MAX_TEXT_LENGTH);
  }
  const wastedBytes = finiteNumber(item.wastedBytes);
  if (wastedBytes !== undefined) row.wastedBytes = wastedBytes;
  const wastedMs = finiteNumber(item.wastedMs);
  if (wastedMs !== undefined) row.wastedMs = wastedMs;
  return Object.keys(row).length > 0 ? row : undefined;
}

/** URL of the first source-location value in a table item. */
function sourceLocationUrl(item: Record<string, unknown>): string | undefined {
  for (const value of Object.values(item)) {
    if (isRecord(value) && value.type === "source-location") {
      const url = nonEmptyString(value.url);
      if (url !== undefined) return url;
    }
  }
  return undefined;
}

/** Replaces inline data: URIs (such as base64 images) in markup snippets. */
function stripDataUris(snippet: string): string {
  return snippet.replace(/data:[^\s"'<>)]*/gi, "data:[omitted]");
}

/** Largest single LCP/FCP/TBT saving of an issue in milliseconds, or 0. */
function millisecondSavings(issue: AuditIssue): number {
  return Math.max(0, ...RANKING_METRICS.map((key) => issue.metricSavings?.[key] ?? 0));
}

/**
 * Orders one category's candidates (§7). This is a sort order over provider
 * data, not a severity score. `Array.prototype.sort` is stable, so ties keep
 * `auditRefs` order.
 */
function rankCategory(category: Category, candidates: Candidate[]): Candidate[] {
  const position = (candidate: Candidate): RefPosition => {
    const found = candidate.positions.get(category);
    if (found === undefined) throw new Error("candidate is not in this category");
    return found;
  };
  const inCategory = candidates
    .filter((candidate) => candidate.positions.has(category))
    .sort((a, b) => position(a).index - position(b).index);

  if (category === "performance") {
    const withSavings = inCategory
      .filter((candidate) => millisecondSavings(candidate.issue) > 0)
      .sort((a, b) => millisecondSavings(b.issue) - millisecondSavings(a.issue));
    const rest = inCategory.filter((candidate) => millisecondSavings(candidate.issue) === 0);
    return [...withSavings, ...rest];
  }
  const failed = inCategory
    .filter((candidate) => candidate.issue.kind === "failed")
    .sort((a, b) => position(b).weight - position(a).weight);
  const diagnostic = inCategory.filter((candidate) => candidate.issue.kind === "diagnostic");
  return [...failed, ...diagnostic];
}

/**
 * Visits categories in order and takes up to five not-yet-selected candidates
 * from each, without backfilling. Yields at most 20 issues.
 */
function selectIssues(candidates: Candidate[]): SelectedIssue[] {
  const selectedIds = new Set<string>();
  const selected: SelectedIssue[] = [];
  for (const category of CATEGORIES) {
    let taken = 0;
    for (const candidate of rankCategory(category, candidates)) {
      if (taken >= MAX_ISSUES_PER_CATEGORY) break;
      if (selectedIds.has(candidate.issue.id)) continue;
      selectedIds.add(candidate.issue.id);
      selected.push({ issue: candidate.issue, selectedBy: category });
      taken += 1;
    }
  }
  return selected;
}

/** Assembles the public report from a draft. */
function toReport(draft: ReportDraft): AuditReport {
  const returnedIssues = draft.issues.length;
  return {
    ...draft.core,
    issues: draft.issues.map(({ issue }) => issue),
    manualChecks: draft.manualChecks,
    auditErrors: draft.auditErrors,
    counts: {
      ...draft.totals,
      returnedIssues,
      omittedIssues: draft.totals.failed + draft.totals.diagnostic - returnedIssues,
    },
    truncated: draft.truncated,
    warnings: draft.warnings,
  };
}

/**
 * Returns a successful result whose serialized `CallToolResult` fits within
 * `maxBytes`, applying the §7 reduction steps in order and stopping as soon as
 * it fits. Core scores, metrics, timestamps, counts and truncation flags are
 * always kept; if they alone cannot fit, returns RESPONSE_TOO_LARGE.
 */
export function fitAuditResult(draft: ReportDraft, requestId: string, maxBytes: number): AuditResult {
  const state: ReportDraft = {
    ...draft,
    issues: draft.issues.map(({ issue, selectedBy }) => ({
      issue: { ...issue, evidence: [...issue.evidence] },
      selectedBy,
    })),
    manualChecks: [...draft.manualChecks],
    auditErrors: [...draft.auditErrors],
    warnings: [...draft.warnings],
  };
  const current = () => successResult(requestId, toReport(state));
  const fits = () => serializedToolResultBytes(current()) <= maxBytes;
  if (fits()) return current();

  /** Applies one reduction step; records the flag and warning only if it changed something. */
  const step = (warning: string, apply: () => boolean): boolean => {
    if (apply()) {
      state.truncated = true;
      state.warnings.push(warning);
    }
    return fits();
  };

  const reduceEvidence = (keep: number) => () => {
    let changed = false;
    for (const { issue } of state.issues) {
      if (issue.evidence.length > keep) {
        issue.evidence = issue.evidence.slice(0, keep);
        issue.evidenceTruncated = true;
        changed = true;
      }
    }
    return changed;
  };
  const reduceDescriptions = (maxLength: number) => () => {
    let changed = false;
    for (const { issue } of state.issues) {
      const shortened = maxLength === 0 ? "" : truncateText(issue.description, maxLength);
      if (shortened !== issue.description) {
        issue.description = shortened;
        changed = true;
      }
    }
    return changed;
  };

  if (step(WARNINGS.reducedEvidence, reduceEvidence(1))) return current();
  if (step(WARNINGS.removedEvidence, reduceEvidence(0))) return current();
  if (step(WARNINGS.shortenedDescriptions, reduceDescriptions(REDUCED_DESCRIPTION_LENGTH))) {
    return current();
  }
  if (step(WARNINGS.removedDescriptions, reduceDescriptions(0))) return current();

  // Step 5: drop issues one at a time, re-measuring after each.
  if (state.issues.length > 0) {
    state.truncated = true;
    state.warnings.push(WARNINGS.droppedIssues);
    while (state.issues.length > 0) {
      dropLowestRankedIssue(state.issues);
      if (fits()) return current();
    }
  }

  // Step 6: halve both summary lists until the result fits or they are empty.
  if (state.manualChecks.length > 0 || state.auditErrors.length > 0) {
    state.truncated = true;
    state.warnings.push(WARNINGS.shortenedSummaries);
    while (state.manualChecks.length > 0 || state.auditErrors.length > 0) {
      state.manualChecks = state.manualChecks.slice(0, Math.floor(state.manualChecks.length / 2));
      state.auditErrors = state.auditErrors.slice(0, Math.floor(state.auditErrors.length / 2));
      if (fits()) return current();
    }
  }

  return failureResult(requestId, createAuditError("responseTooLarge"));
}

/**
 * Removes the lowest-ranked issue of the category with the most remaining
 * issues, counting each issue under the category that selected it. Ties go
 * to the category visited last.
 */
function dropLowestRankedIssue(issues: SelectedIssue[]): void {
  let target: Category | undefined;
  let targetCount = 0;
  for (const category of CATEGORIES) {
    const count = issues.filter((selected) => selected.selectedBy === category).length;
    if (count > 0 && count >= targetCount) {
      target = category;
      targetCount = count;
    }
  }
  for (let index = issues.length - 1; index >= 0; index -= 1) {
    if (issues[index]?.selectedBy === target) {
      issues.splice(index, 1);
      return;
    }
  }
}

/**
 * Caps a string at `maxCodePoints` Unicode code points without splitting a
 * surrogate pair. A shortened string ends with "…" (counted in the cap).
 */
export function truncateText(value: string, maxCodePoints: number): string {
  if (value.length <= maxCodePoints) return value;
  const codePoints = Array.from(value);
  if (codePoints.length <= maxCodePoints) return value;
  if (maxCodePoints <= 0) return "";
  return `${codePoints.slice(0, maxCodePoints - 1).join("")}…`;
}
