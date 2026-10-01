/**
 * Display copy and canonical URLs (SPEC.md §2). This is the only place that
 * defines branding text; static pages are checked against it in tests.
 * Changing the display name must not require changing the tool name, the
 * output schema, the Worker identifier or the hostname.
 */

/** Public product name. */
export const PRODUCT_NAME = "Lighthouse Audit";

/** Repository, package and Worker identifier. */
export const PROJECT_IDENTIFIER = "lighthouse-audit";

/** Developer attribution. */
export const DEVELOPER_NAME = "Reinhard Zach";

export const SUBTITLE =
  "Fresh website performance, accessibility, and SEO checks. No separate signup.";

export const PAGE_TITLE = "Lighthouse Audit — Website Performance & SEO Checks";

export const META_DESCRIPTION =
  "Run fresh Lighthouse website audits for performance, accessibility, SEO, and best practices via PageSpeed Insights. No separate signup.";

export const PROVIDER_ATTRIBUTION = "Uses Lighthouse via Google PageSpeed Insights.";

export const INDEPENDENCE_NOTICE =
  "Independently developed by Reinhard Zach; not affiliated with Google or OpenAI.";

/** Production hostname; the only accepted `Host` in production (§8). */
export const PRODUCTION_HOSTNAME = "audit.mrza.ch";

/** Canonical origin; the only accepted browser `Origin` in production (§8). */
export const CANONICAL_ORIGIN = `https://${PRODUCTION_HOSTNAME}`;

export const MCP_ENDPOINT_URL = `${CANONICAL_ORIGIN}/mcp`;
export const PRIVACY_URL = `${CANONICAL_ORIGIN}/privacy`;
