/**
 * Provider request tests, run in workerd. `fetch` is injected; nothing here
 * contacts Google. Provider error bodies are synthetic, modelled on Google's
 * documented API error format.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PROVIDER_RESPONSE_BYTES } from "../src/limits";
import {
  PSI_ENDPOINT,
  PSI_FIELDS,
  requestPageSpeed,
  type PageSpeedOutcome,
  type PageSpeedRequest,
} from "../src/pagespeed";
import type { AuditError } from "../src/schemas";

const TARGET = "https://www.example.com/path?b=2&a=1#frag";
const API_KEY = "test-api-key-not-real";

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

/**
 * A fetch stand-in that records calls and validates the init the way workerd
 * does, by constructing a real Request from it.
 */
function mockFetch(respond: (request: Request) => Response | Promise<Response>) {
  return vi.fn(async (...[input, init]: FetchArgs) => respond(new Request(input, init)));
}

function run(fetch: PageSpeedRequest["fetch"], overrides: Partial<PageSpeedRequest> = {}) {
  return requestPageSpeed({
    targetUrl: TARGET,
    device: "mobile",
    apiKey: API_KEY,
    timeoutMs: 55_000,
    fetch,
    ...overrides,
  });
}

function errorOf(outcome: PageSpeedOutcome): AuditError {
  if (outcome.ok) throw new Error("expected a failure");
  return outcome.error;
}

/** A Google API error body (synthetic). */
function googleError(status: number, fields: Record<string, unknown>): Response {
  return Response.json({ error: { code: status, ...fields } }, { status });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("request shape", () => {
  it("makes one GET with the documented enums, the pinned fields mask and the key in a header", async () => {
    const fetch = mockFetch(() => Response.json({ lighthouseResult: {} }));
    const outcome = await run(fetch, { device: "desktop" });
    expect(outcome.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    const [input, init] = fetch.mock.calls[0] as FetchArgs;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(PSI_ENDPOINT);
    expect(url.searchParams.get("url")).toBe(TARGET);
    expect(url.searchParams.get("strategy")).toBe("DESKTOP");
    expect(url.searchParams.get("locale")).toBe("en");
    expect(url.searchParams.getAll("category")).toEqual([
      "PERFORMANCE",
      "ACCESSIBILITY",
      "BEST_PRACTICES",
      "SEO",
    ]);
    expect(url.searchParams.get("fields")).toBe(PSI_FIELDS);
    expect(url.search).toContain(encodeURIComponent("https://www.example.com/path?b=2&a=1#frag"));

    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(API_KEY);
    expect(String(input)).not.toContain(API_KEY);
    expect(url.searchParams.has("key")).toBe(false);
  });

  it("sends strategy MOBILE for mobile", async () => {
    const fetch = mockFetch(() => Response.json({}));
    await run(fetch);
    const [input] = fetch.mock.calls[0] as FetchArgs;
    expect(new URL(String(input)).searchParams.get("strategy")).toBe("MOBILE");
  });

  it("uses a redirect mode that workerd accepts ('error' would throw)", () => {
    expect(() => new Request(PSI_ENDPOINT, { redirect: "manual" })).not.toThrow();
    expect(() => new Request(PSI_ENDPOINT, { redirect: "error" })).toThrow();
  });
});

describe("responses", () => {
  it("returns the parsed body and byte count on success", async () => {
    const outcome = await run(mockFetch(() => Response.json({ lighthouseResult: { ok: 1 } })));
    expect(outcome).toMatchObject({
      ok: true,
      body: { lighthouseResult: { ok: 1 } },
      diagnostics: { status: 200 },
    });
  });

  it("fails on any 3xx without following Location or fetching again", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const fetch = mockFetch(
        () => new Response(null, { status, headers: { location: "https://attacker.example.net/" } }),
      );
      const error = errorOf(await run(fetch));
      expect(error).toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE", retryable: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("maps malformed JSON to INVALID_UPSTREAM_RESPONSE", async () => {
    const error = errorOf(await run(mockFetch(() => new Response("{not json", { status: 200 }))));
    expect(error.code).toBe("INVALID_UPSTREAM_RESPONSE");
  });

  it("maps a network error to retryable UPSTREAM_UNAVAILABLE", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Network connection lost to https://pagespeedonline.googleapis.com/?url=secret");
    });
    const error = errorOf(await run(fetch));
    expect(error).toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The analysis provider is unavailable.",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("provider error classification", () => {
  it("maps a 429 rate limit to CAPACITY_EXCEEDED with a trustworthy Retry-After", async () => {
    const fetch = mockFetch(() => {
      const response = googleError(429, {
        message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            metadata: { quota_limit: "defaultPerMinutePerProject" },
          },
        ],
      });
      response.headers.set("retry-after", "30");
      return response;
    });
    const error = errorOf(await run(fetch));
    expect(error).toEqual({
      code: "CAPACITY_EXCEEDED",
      message: "The analysis provider's rate limit was reached; do not retry automatically.",
      retryable: true,
      retryAfterSeconds: 30,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an exhausted daily quota and never mentions tomorrow", async () => {
    const fetch = mockFetch(() =>
      googleError(429, {
        message: "Quota exceeded",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            metadata: { quota_limit: "defaultPerDayPerProject" },
          },
        ],
      }),
    );
    const error = errorOf(await run(fetch));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("daily quota");
    expect(error.message.toLowerCase()).not.toContain("tomorrow");
    expect(error).not.toHaveProperty("retryAfterSeconds");
  });

  it("maps a 403 quota reason to CAPACITY_EXCEEDED", async () => {
    const fetch = mockFetch(() =>
      googleError(403, { message: "Daily Limit Exceeded", errors: [{ reason: "dailyLimitExceeded" }] }),
    );
    expect(errorOf(await run(fetch)).code).toBe("CAPACITY_EXCEEDED");
  });

  it("does not label an unrelated 403 as quota exhaustion", async () => {
    const fetch = mockFetch(() =>
      googleError(403, { message: "The caller does not have permission", status: "PERMISSION_DENIED" }),
    );
    expect(errorOf(await run(fetch))).toEqual({
      code: "UPSTREAM_UNAVAILABLE",
      message: "The analysis provider rejected the request.",
      retryable: false,
    });
  });

  it("maps invalid credentials and disabled projects to SERVICE_UNAVAILABLE", async () => {
    const bodies = [
      googleError(400, {
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
      }),
      googleError(403, {
        message: "PageSpeed Insights API has not been used in project 000000000000 before or it is disabled.",
        status: "PERMISSION_DENIED",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" }],
      }),
    ];
    for (const body of bodies) {
      const error = errorOf(await run(mockFetch(() => body.clone())));
      expect(error).toEqual({
        code: "SERVICE_UNAVAILABLE",
        message: "Audits are temporarily unavailable.",
        retryable: false,
      });
    }
  });

  it("maps a 5xx without a Lighthouse code to retryable UPSTREAM_UNAVAILABLE", async () => {
    for (const status of [500, 502, 503]) {
      const fetch = mockFetch(() => googleError(status, { message: "Backend error", status: "UNAVAILABLE" }));
      expect(errorOf(await run(fetch))).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
    }
  });

  it("maps other 4xx responses to non-retryable UPSTREAM_UNAVAILABLE", async () => {
    const fetch = mockFetch(() => new Response("<html>not found</html>", { status: 404 }));
    expect(errorOf(await run(fetch))).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: false });
  });

  it("maps a non-2xx Lighthouse error to PAGE_LOAD_FAILED without provider text", async () => {
    for (const [status, code] of [
      [500, "NO_FCP"],
      [400, "FAILED_DOCUMENT_REQUEST"],
      [500, "ERRORED_DOCUMENT_REQUEST"],
    ] as const) {
      const providerMessage = `Lighthouse returned error: ${code}. Lighthouse was unable to reliably load https://private.example.com/?q=1 (Status code: 500)`;
      const fetch = mockFetch(() => googleError(status, { message: providerMessage }));
      const error = errorOf(await run(fetch));
      expect(error).toEqual({
        code: "PAGE_LOAD_FAILED",
        message: "Google could not load or audit the requested public page.",
        retryable: false,
        providerErrorCode: code,
      });
      expect(JSON.stringify(error)).not.toContain("private.example.com");
    }
  });

  it("omits a Lighthouse code that does not match the safe pattern", async () => {
    const fetch = mockFetch(() =>
      googleError(500, { message: "Lighthouse returned error: something-unexpected happened" }),
    );
    const error = errorOf(await run(fetch));
    expect(error.code).toBe("PAGE_LOAD_FAILED");
    expect(error).not.toHaveProperty("providerErrorCode");
  });
});

describe("time, cancellation and size bounds", () => {
  /** A fetch that never answers until its signal aborts. */
  function hangingFetch() {
    return vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
  }

  it("aborts at the configured timeout and reports AUDIT_TIMEOUT", async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch();
    const pending = run(fetch, { timeoutMs: 55_000 });
    await vi.advanceTimersByTimeAsync(54_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(errorOf(await pending)).toEqual({
      code: "AUDIT_TIMEOUT",
      message: "The audit did not finish within the current time limit.",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes reading the body in the timeout", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const fetch = mockFetch(
      () =>
        new Response(
          new ReadableStream({
            pull() {
              // Never enqueues: the body stalls after the headers arrive.
              return new Promise(() => {});
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const pending = run(fetch, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errorOf(await pending).code).toBe("AUDIT_TIMEOUT");
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation to the provider request", async () => {
    const fetch = hangingFetch();
    const controller = new AbortController();
    const pending = run(fetch, { signal: controller.signal });
    controller.abort();
    const error = errorOf(await pending);
    expect(error).toMatchObject({ code: "AUDIT_TIMEOUT", retryable: true });
    expect(error.message).toBe("The audit was cancelled before it finished.");
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(true);
  });

  it("makes no request when already cancelled", async () => {
    const fetch = hangingFetch();
    const controller = new AbortController();
    controller.abort();
    expect(errorOf(await run(fetch, { signal: controller.signal })).code).toBe("AUDIT_TIMEOUT");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears its timer after a successful response", async () => {
    vi.useFakeTimers();
    await run(mockFetch(() => Response.json({})));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an oversized streamed body without Content-Length and cancels it", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let pulls = 0;
    let cancelled = false;
    const fetch = mockFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const outcome = await run(fetch);
    expect(errorOf(outcome)).toMatchObject({ code: "RESPONSE_TOO_LARGE", retryable: false });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(MAX_PROVIDER_RESPONSE_BYTES / chunk.byteLength + 2);
  });

  it("rejects a declared Content-Length above the limit without reading", async () => {
    let pulls = 0;
    const fetch = mockFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(16));
            },
          }),
          { status: 200, headers: { "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1) } },
        ),
    );
    expect(errorOf(await run(fetch)).code).toBe("RESPONSE_TOO_LARGE");
    expect(pulls).toBeLessThanOrEqual(1);
  });
});
