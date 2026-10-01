/**
 * SYNTHETIC FIXTURES — hand-written for tests. Not captured from Google.
 *
 * They mirror the shape of a PageSpeed Insights v5 response projected by the
 * pinned `fields` mask, with Lighthouse 13 style insight audits (`*-insight`),
 * `metrics`/`hidden` audit-ref groups and every score display mode. All URLs
 * use reserved example domains; nothing here describes a real site.
 */

type Json = Record<string, unknown>;

/** Builds an audit object; only the fields a test needs. */
export function audit(id: string, fields: Json = {}): Json {
  return { id, title: `Title of ${id}`, description: `Description of ${id}.`, ...fields };
}

/** A table details object with the given items. */
export function table(items: Json[], extra: Json = {}): Json {
  return { type: "table", headings: [], items, ...extra };
}

/** A metric audit with a numeric value and unit. */
function metric(id: string, numericValue: number, numericUnit = "millisecond"): Json {
  return audit(id, { scoreDisplayMode: "numeric", score: 0.5, numericValue, numericUnit });
}

/** An `auditRefs` entry. */
export function ref(id: string, weight = 0, group?: string): Json {
  return group === undefined ? { id, weight } : { id, weight, group };
}

/**
 * A complete synthetic PSI response for https://www.example.com/ with a mix of
 * failed, passed, informative, manual, not-applicable, error and hidden audits.
 */
export function syntheticPsiResponse(): Json {
  const audits: Record<string, Json> = {
    // Lab metrics (group "metrics"): reported in labMetrics, never as issues.
    "first-contentful-paint": metric("first-contentful-paint", 1834.4),
    "largest-contentful-paint": metric("largest-contentful-paint", 3120.6),
    "total-blocking-time": metric("total-blocking-time", 0),
    "cumulative-layout-shift": metric("cumulative-layout-shift", 0.04567, "unitless"),
    "speed-index": metric("speed-index", 2501.2),

    // Performance insights and diagnostics.
    "render-blocking-insight": audit("render-blocking-insight", {
      scoreDisplayMode: "metricSavings",
      score: 0,
      displayValue: "Est savings of 450 ms",
      metricSavings: { FCP: 450, LCP: 450 },
      details: table([
        { url: "https://www.example.com/styles/main.css", wastedMs: 300, totalBytes: 12000 },
        { url: "https://www.example.com/scripts/vendor.js", wastedMs: 150 },
      ]),
    }),
    "lcp-discovery-insight": audit("lcp-discovery-insight", {
      scoreDisplayMode: "metricSavings",
      score: 0.5,
      metricSavings: { LCP: 900 },
      details: {
        type: "list",
        items: [
          { type: "checklist", items: {} },
          table([{ node: { type: "node", selector: "main > img.hero", snippet: '<img class="hero" src="/hero.jpg">' } }]),
        ],
      },
    }),
    "image-delivery-insight": audit("image-delivery-insight", {
      scoreDisplayMode: "metricSavings",
      score: 0.5,
      metricSavings: { LCP: 150, FCP: 0 },
      details: table(
        [
          { url: "https://www.example.com/hero.jpg", wastedBytes: 120000 },
          { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=", wastedBytes: 50 },
          { url: "https://www.example.com/a.jpg", wastedBytes: 9000 },
          { url: "https://www.example.com/b.jpg", wastedBytes: 8000 },
          { url: "https://www.example.com/c.jpg", wastedBytes: 7000 },
        ],
        { overallSavingsBytes: 144050 },
      ),
    }),
    "document-latency-insight": audit("document-latency-insight", {
      scoreDisplayMode: "metricSavings",
      score: 1,
      metricSavings: { FCP: 0, LCP: 0 },
    }),
    "third-parties-insight": audit("third-parties-insight", {
      scoreDisplayMode: "informative",
      score: null,
      details: table([{ entity: "Example Analytics", transferSize: 4000 }]),
    }),
    "bootup-time": audit("bootup-time", {
      scoreDisplayMode: "numeric",
      score: 0.62,
      displayValue: "2.1 s",
      metricSavings: { TBT: 120 },
      details: table([
        {
          url: "https://www.example.com/scripts/app.js",
          source: { type: "source-location", url: "https://www.example.com/scripts/app.js", line: 1, column: 0 },
          total: 1200,
        },
      ]),
    }),
    "mainthread-work-breakdown": audit("mainthread-work-breakdown", {
      scoreDisplayMode: "informative",
      score: null,
      details: { type: "criticalrequestchain", chains: {} },
    }),
    "uses-http2": audit("uses-http2", { scoreDisplayMode: "notApplicable", score: null }),
    "font-display-insight": audit("font-display-insight", {
      scoreDisplayMode: "metricSavings",
      score: 0,
    }),

    // Hidden-group audits: screenshots and raw data, never issues.
    "screenshot-thumbnails": audit("screenshot-thumbnails", {
      scoreDisplayMode: "informative",
      score: null,
      details: { type: "filmstrip", items: [{ data: "data:image/jpeg;base64,/9j/AAAA" }] },
    }),
    "network-requests": audit("network-requests", {
      scoreDisplayMode: "informative",
      score: null,
      details: table([{ url: "https://www.example.com/", transferSize: 1000 }]),
    }),

    // Accessibility.
    "color-contrast": audit("color-contrast", {
      scoreDisplayMode: "binary",
      score: 0,
      details: table([
        { node: { type: "node", selector: "footer > p", snippet: '<p class="muted">' } },
        { node: { type: "node", selector: "nav a.secondary", snippet: '<a class="secondary" href="/about">' } },
      ]),
    }),
    "image-alt": audit("image-alt", { scoreDisplayMode: "binary", score: 1 }),
    "link-name": audit("link-name", {
      scoreDisplayMode: "binary",
      score: 0,
      details: table([{ node: { type: "node", selector: "a.icon", snippet: '<a class="icon" href="/cart">' } }]),
    }),
    "button-name": audit("button-name", { scoreDisplayMode: "notApplicable", score: null }),
    "logical-tab-order": audit("logical-tab-order", { scoreDisplayMode: "manual", score: null }),
    "focus-traps": audit("focus-traps", { scoreDisplayMode: "manual", score: null }),

    // Best practices.
    "errors-in-console": audit("errors-in-console", {
      scoreDisplayMode: "binary",
      score: 0,
      details: table([
        {
          source: "exception",
          description: "Uncaught TypeError",
          sourceLocation: { type: "source-location", url: "https://www.example.com/scripts/app.js", line: 10, column: 4 },
        },
      ]),
    }),
    "is-on-https": audit("is-on-https", { scoreDisplayMode: "binary", score: 1 }),
    "inspector-issues": audit("inspector-issues", { scoreDisplayMode: "binary", score: 0.5 }),

    // SEO.
    "meta-description": audit("meta-description", { scoreDisplayMode: "binary", score: 0 }),
    "document-title": audit("document-title", { scoreDisplayMode: "binary", score: 1 }),
    "structured-data": audit("structured-data", { scoreDisplayMode: "manual", score: null }),
    "robots-txt": audit("robots-txt", {
      scoreDisplayMode: "error",
      score: null,
      errorMessage: "Synthetic error: robots.txt could not be fetched.",
    }),
  };

  return {
    analysisUTCTimestamp: "2026-10-01T09:59:30.000Z",
    lighthouseResult: {
      requestedUrl: "https://www.example.com/",
      finalUrl: "https://www.example.com/",
      finalDisplayedUrl: "https://www.example.com/",
      mainDocumentUrl: "https://www.example.com/",
      fetchTime: "2026-10-01T09:59:31.000Z",
      lighthouseVersion: "13.0.0",
      runWarnings: [],
      configSettings: { formFactor: "mobile" },
      categories: {
        performance: {
          id: "performance",
          title: "Performance",
          score: 0.734,
          auditRefs: [
            ref("first-contentful-paint", 10, "metrics"),
            ref("largest-contentful-paint", 25, "metrics"),
            ref("total-blocking-time", 30, "metrics"),
            ref("cumulative-layout-shift", 25, "metrics"),
            ref("speed-index", 10, "metrics"),
            ref("render-blocking-insight", 0, "insights"),
            ref("lcp-discovery-insight", 0, "insights"),
            ref("image-delivery-insight", 0, "insights"),
            ref("document-latency-insight", 0, "insights"),
            ref("third-parties-insight", 0, "insights"),
            ref("font-display-insight", 0, "insights"),
            ref("bootup-time", 0, "diagnostics"),
            ref("mainthread-work-breakdown", 0, "diagnostics"),
            ref("uses-http2", 0, "diagnostics"),
            ref("screenshot-thumbnails", 0, "hidden"),
            ref("network-requests", 0, "hidden"),
          ],
        },
        accessibility: {
          id: "accessibility",
          title: "Accessibility",
          score: 0.88,
          auditRefs: [
            ref("image-alt", 10, "a11y-names-labels"),
            ref("link-name", 7, "a11y-names-labels"),
            ref("color-contrast", 7, "a11y-color-contrast"),
            ref("button-name", 10, "a11y-names-labels"),
            ref("logical-tab-order", 0),
            ref("focus-traps", 0),
          ],
        },
        "best-practices": {
          id: "best-practices",
          title: "Best Practices",
          score: 0.92,
          auditRefs: [
            ref("is-on-https", 5, "best-practices-trust-safety"),
            ref("errors-in-console", 1, "best-practices-general"),
            ref("inspector-issues", 1, "best-practices-general"),
            ref("render-blocking-insight", 0),
          ],
        },
        seo: {
          id: "seo",
          title: "SEO",
          score: 0.9,
          auditRefs: [
            ref("document-title", 1, "seo-content"),
            ref("meta-description", 1, "seo-content"),
            ref("structured-data", 0),
            ref("robots-txt", 1, "seo-crawl"),
          ],
        },
      },
      audits,
    },
  };
}
