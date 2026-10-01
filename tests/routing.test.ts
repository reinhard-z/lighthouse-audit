/**
 * HTTP routing, Static Assets, Host/Origin checks, body limits and response
 * headers, in workerd. `exports.default` runs the deployed configuration,
 * including Static Assets and `run_worker_first`; `worker.fetch` is used where
 * a test needs specific bindings or Host values.
 */
import { createExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index";
import { MAX_MCP_REQUEST_BODY_BYTES } from "../src/limits";
import type { WorkerEnv } from "../src/validation";

const ORIGIN = "https://audit.mrza.ch";
const ENABLED: WorkerEnv = { AUDITS_ENABLED: "true", PSI_API_KEY: "test-api-key-not-real" };

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

let providerFetch: MockInstance<typeof fetch>;

beforeEach(() => {
  providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("routing tests must not reach the provider");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Calls the full deployed pipeline (Static Assets + Worker) with production config. */
function deployed(path: string, init: RequestInit = {}) {
  // Requests at the edge always carry Host; a synthetic Request does not.
  const headers = new Headers(init.headers);
  headers.set("host", "audit.mrza.ch");
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }));
}

/** Calls the Worker entry directly with explicit Host and bindings. */
function direct(url: string, init: RequestInit & { host?: string } = {}, env: WorkerEnv = ENABLED) {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? new URL(url).host);
  return worker.fetch(new Request(url, { ...init, headers }), env, createExecutionContext());
}

function expectWorkerHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("static pages", () => {
  it("serves the landing page with the static security headers", async () => {
    const response = await deployed("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h1>Lighthouse Audit</h1>");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("serves /privacy with 200 and no redirect", async () => {
    const response = await deployed("/privacy", { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Lighthouse Audit privacy");
  });

  it("returns a real 404 page for unknown paths, never the landing page", async () => {
    for (const path of ["/audit?url=https://www.example.com/", "/nope", "/mcp.html"]) {
      const response = await deployed(path, { redirect: "manual" });
      expect(response.status, path).toBe(404);
      const html = await response.text();
      expect(html).toContain("Page not found");
      expect(html).not.toContain("<h1>Lighthouse Audit</h1>");
    }
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe("worker routes", () => {
  it("reports health without contacting the provider", async () => {
    const response = await deployed("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, release: "unreleased" });
    expectWorkerHeaders(response);

    const post = await deployed("/healthz", { method: "POST" });
    expect(post.status).toBe(405);
    expectWorkerHeaders(post);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("reports the configured release", async () => {
    const response = await direct(`${ORIGIN}/healthz`, {}, { RELEASE: "0123abcd" });
    expect(await response.json()).toEqual({ ok: true, release: "0123abcd" });
  });

  it("serves MCP initialize at /mcp with no-store headers", async () => {
    const response = await deployed("/mcp", { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
    expect(response.status).toBe(200);
    expectWorkerHeaders(response);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("returns a JSON 404 for paths under /mcp/", async () => {
    const response = await deployed("/mcp/extra", { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
    expect(response.status).toBe(404);
    expectWorkerHeaders(response);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("returns the kill-switch error from a production tools/call", async () => {
    const response = await deployed("/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_lighthouse", arguments: { url: "https://www.example.com/" } },
      }),
    });
    const text = await response.text();
    expect(text).toContain("SERVICE_UNAVAILABLE");
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe("Host and Origin validation", () => {
  it("accepts origin-less server clients and the canonical origin", async () => {
    for (const headers of [MCP_HEADERS, { ...MCP_HEADERS, origin: ORIGIN }]) {
      const response = await direct(`${ORIGIN}/mcp`, { method: "POST", headers, body: INITIALIZE });
      expect(response.status).toBe(200);
    }
  });

  it("rejects foreign origins with 403 on every Worker route", async () => {
    for (const origin of ["https://evil.example.net", "null", "http://audit.mrza.ch", "http://localhost:6274"]) {
      for (const path of ["/mcp", "/healthz"]) {
        const response = await direct(`${ORIGIN}${path}`, {
          method: path === "/mcp" ? "POST" : "GET",
          headers: { ...MCP_HEADERS, origin },
          ...(path === "/mcp" && { body: INITIALIZE }),
        });
        expect(response.status, `${origin} ${path}`).toBe(403);
        expectWorkerHeaders(response);
      }
    }
    const preflight = await direct(`${ORIGIN}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.net", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(403);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("accepts only the production Host in production", async () => {
    for (const host of ["evil.example.net", "localhost:8787", "audit.mrza.ch.evil.example", "x@audit.mrza.ch"]) {
      const response = await direct(`${ORIGIN}/mcp`, { host, method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
      expect(response.status, host).toBe(403);
    }
  });

  it("allows localhost Host and Origin only in local development", async () => {
    const local = { ...ENABLED, LOCAL_DEVELOPMENT: "true" };
    const init = {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "http://localhost:6274" },
      body: INITIALIZE,
    };
    expect((await direct("http://localhost:8787/mcp", init, local)).status).toBe(200);
    expect((await direct("http://localhost:8787/mcp", init, ENABLED)).status).toBe(403);
  });
});

describe("request body limit", () => {
  it("rejects a declared body above 32 KiB", async () => {
    const response = await direct(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, "content-length": String(MAX_MCP_REQUEST_BODY_BYTES + 1) },
      body: "x".repeat(MAX_MCP_REQUEST_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expectWorkerHeaders(response);
  });

  it("rejects a streamed body above 32 KiB without a Content-Length", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(4096));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > MAX_MCP_REQUEST_BODY_BYTES * 2) controller.close();
      },
    });
    const request = new Request(`${ORIGIN}/mcp`, { method: "POST", headers: MCP_HEADERS, body });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await direct(`${ORIGIN}/mcp`, { method: "POST", headers: MCP_HEADERS, body: request.body });
    expect(response.status).toBe(413);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("accepts a body at the limit", async () => {
    const padded = INITIALIZE.padEnd(MAX_MCP_REQUEST_BODY_BYTES, " ");
    const response = await direct(`${ORIGIN}/mcp`, { method: "POST", headers: MCP_HEADERS, body: padded });
    expect(response.status).toBe(200);
  });
});
