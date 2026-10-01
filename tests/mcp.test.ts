/**
 * MCP behavior through the real Worker entry, in workerd. A real MCP SDK v2
 * client connects over Streamable HTTP in both protocol eras. Provider calls
 * go to a spy on the global fetch; nothing contacts Google.
 */
import { Validator } from "@cfworker/json-schema";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index";
import { MAX_TOOL_RESULT_BYTES } from "../src/limits";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTION, TOOL_NAME } from "../src/mcp";
import { AuditResultSchema, type AuditResult } from "../src/schemas";
import type { WorkerEnv } from "../src/validation";
import { syntheticPsiResponse } from "./fixtures/psi";

const ENDPOINT = "https://audit.mrza.ch/mcp";
const API_KEY = "test-api-key-not-real";
const ENABLED: WorkerEnv = {
  AUDITS_ENABLED: "true",
  PSI_API_KEY: API_KEY,
  PSI_TIMEOUT_MS: "55000",
  RELEASE: "test-release",
};
const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOLS = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;

let providerFetch: MockInstance<typeof fetch>;

beforeEach(() => {
  providerFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(syntheticPsiResponse()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Sends a request to the Worker as the production hostname would receive it. */
function callWorker(input: RequestInfo | URL, init?: RequestInit, env: WorkerEnv = ENABLED) {
  const request = new Request(input, init);
  const headers = new Headers(request.headers);
  if (!headers.has("host")) headers.set("host", new URL(request.url).host);
  return worker.fetch(new Request(request, { headers }), env, createExecutionContext());
}

/** Connects a real SDK client; `pin` selects the modern era, otherwise legacy. */
async function connect(env: WorkerEnv = ENABLED, era: "modern" | "legacy" = "modern") {
  const client = new Client(
    { name: "lighthouse-audit-tests", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: (input, init) => callWorker(input, init, env),
  });
  await client.connect(transport);
  return client;
}

/** A raw JSON-RPC POST in the 2025 (legacy) era. */
async function legacyPost(body: unknown, protocolVersion = "2025-06-18", headers: HeadersInit = {}) {
  return callWorker(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Reads a JSON-RPC response from a JSON or single-event SSE body. */
async function readRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6)
    : text;
  return JSON.parse(json) as Record<string, unknown>;
}

function structuredOf(result: unknown): AuditResult {
  const parsed = AuditResultSchema.safeParse((result as { structuredContent?: unknown }).structuredContent);
  if (!parsed.success) throw new Error(`structuredContent is not schema-valid: ${parsed.error.message}`);
  return parsed.data;
}

describe("initialization and discovery", () => {
  it("initializes in the modern era and lists exactly one annotated anonymous tool", async () => {
    const client = await connect();
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL);
    expect(client.getServerVersion()).toMatchObject({ name: "lighthouse-audit", title: "Lighthouse Audit" });
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool).toMatchObject({
      name: TOOL_NAME,
      title: "Run Lighthouse audit",
      description: TOOL_DESCRIPTION,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { securitySchemes: [{ type: "noauth" }] },
    });
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: { device: { enum: ["mobile", "desktop"], default: "mobile" } },
    });
    expect(tool?.outputSchema).toMatchObject({ type: "object" });
    await client.close();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(LEGACY_PROTOCOLS)("serves 2025-era clients at protocol %s", async (version) => {
    const response = await legacyPost(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } },
      },
      version,
    );
    expect(response.status).toBe(200);
    const message = await readRpc(response);
    expect(message.result).toMatchObject({ protocolVersion: version, serverInfo: { name: "lighthouse-audit" } });

    const list = await readRpc(
      await legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, version),
    );
    expect((list.result as { tools: unknown[] }).tools).toHaveLength(1);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("works with the SDK client in legacy mode", async () => {
    const client = await connect(ENABLED, "legacy");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
    const result = await client.callTool({ name: TOOL_NAME, arguments: { url: "https://www.example.com/" } });
    expect(structuredOf(result).ok).toBe(true);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("answers unsupported methods without starting an audit", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await callWorker(ENDPOINT, {
        method,
        headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-06-18" },
      });
      expect(response.status, method).toBe(405);
    }
    const preflight = await callWorker(ENDPOINT, {
      method: "OPTIONS",
      headers: {
        origin: "https://audit.mrza.ch",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("lets the SDK reject malformed messages and unknown tools", async () => {
    const malformed = await callWorker(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{not json",
    });
    expect(malformed.status).toBeGreaterThanOrEqual(400);

    const client = await connect();
    await expect(client.callTool({ name: "compare_audits", arguments: {} })).rejects.toThrow();
    expect(providerFetch).not.toHaveBeenCalled();
    await client.close();
  });
});

describe("tool calls", () => {
  it("makes exactly one provider call and returns a bounded, schema-valid report", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { url: "https://www.example.com/", device: "desktop" },
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [input, init] = providerFetch.mock.calls[0] ?? [];
    const providerUrl = new URL(String(input));
    expect(providerUrl.searchParams.get("strategy")).toBe("DESKTOP");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(API_KEY);
    expect(String(input)).not.toContain(API_KEY);
    expect(init?.redirect).toBe("manual");

    const structured = structuredOf(result);
    expect(structured).toMatchObject({ schemaVersion: "1.0", ok: true, error: null });
    expect(structured.report?.device).toBe("desktop");
    expect(structured.report?.scores.performance).toBe(73);
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    await client.close();
  });

  it("returns a text block that parses to the same object as structuredContent", async () => {
    const client = await connect();
    const result = await client.callTool({ name: TOOL_NAME, arguments: { url: "https://www.example.com/" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "")).toEqual(result.structuredContent);
    await client.close();
  });

  it("validates success and failure results against the advertised outputSchema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const validator = new Validator(tools[0]?.outputSchema as object, "2020-12", false);

    const success = await client.callTool({ name: TOOL_NAME, arguments: { url: "https://www.example.com/" } });
    expect(validator.validate(success.structuredContent).valid).toBe(true);

    const failure = await client.callTool({ name: TOOL_NAME, arguments: { url: "http://localhost/" } });
    expect(failure.isError).toBe(true);
    expect(validator.validate(failure.structuredContent).valid).toBe(true);
    await client.close();
  });

  it("makes a new provider call for every identical sequential request", async () => {
    const client = await connect();
    const first = await client.callTool({ name: TOOL_NAME, arguments: { url: "https://www.example.com/" } });
    const second = await client.callTool({ name: TOOL_NAME, arguments: { url: "https://www.example.com/" } });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(structuredOf(first).requestId).not.toBe(structuredOf(second).requestId);
    await client.close();
  });

  it("returns isError with schema-valid structured content for failures, without provider calls", async () => {
    const client = await connect();
    const cases = [
      { url: "not a url", code: "INVALID_URL" },
      { url: "https://www.example.com/?access_token=abc", code: "UNSUPPORTED_TARGET" },
      { url: "http://192.168.1.1/", code: "UNSUPPORTED_TARGET" },
    ];
    for (const { url, code } of cases) {
      const result = await client.callTool({ name: TOOL_NAME, arguments: { url } });
      expect(result.isError).toBe(true);
      const structured = structuredOf(result);
      expect(structured).toMatchObject({ ok: false, report: null, error: { code } });
    }
    expect(providerFetch).not.toHaveBeenCalled();
    await client.close();
  });

  it("rejects unknown tool arguments through schema validation", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: TOOL_NAME,
      arguments: { url: "https://www.example.com/", crawl: true },
    });
    // The SDK answers schema-level errors itself, as a tool error without structured content.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Unrecognized key");
    expect(providerFetch).not.toHaveBeenCalled();
    await client.close();
  });

  it("fails clearly without contacting Google when audits are disabled or the key is missing", async () => {
    for (const env of [
      { ...ENABLED, AUDITS_ENABLED: "false" },
      { ...ENABLED, PSI_API_KEY: undefined },
    ]) {
      const client = await connect(env);
      const result = await client.callTool({ name: TOOL_NAME, arguments: { url: "https://www.example.com/" } });
      expect(result.isError).toBe(true);
      expect(structuredOf(result).error).toEqual({
        code: "SERVICE_UNAVAILABLE",
        message: "Audits are temporarily unavailable.",
        retryable: false,
      });
      await client.close();
    }
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("keeps the post-deploy invalid-target probe Google-free under either kill-switch value", async () => {
    for (const enabled of ["false", "true"]) {
      const client = await connect({ ...ENABLED, AUDITS_ENABLED: enabled });
      const result = await client.callTool({ name: TOOL_NAME, arguments: { url: "not-a-url" } });
      expect(structuredOf(result).error?.code).toBe(
        enabled === "false" ? "SERVICE_UNAVAILABLE" : "INVALID_URL",
      );
      await client.close();
    }
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("maps a provider 3xx to INVALID_UPSTREAM_RESPONSE with no second fetch", async () => {
    providerFetch.mockImplementation(
      async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.net/" } }),
    );
    const client = await connect();
    const result = await client.callTool({ name: TOOL_NAME, arguments: { url: "https://www.example.com/" } });
    expect(structuredOf(result).error?.code).toBe("INVALID_UPSTREAM_RESPONSE");
    expect(providerFetch).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("maps an unexpected exception to INTERNAL_ERROR", async () => {
    const broken = {
      get status(): number {
        throw new Error("unexpected https://www.example.com/?q=secret");
      },
    };
    providerFetch.mockImplementation(async () => broken as unknown as Response);
    const client = await connect();
    const result = await client.callTool({ name: TOOL_NAME, arguments: { url: "https://www.example.com/" } });
    expect(result.isError).toBe(true);
    expect(structuredOf(result).error).toEqual({
      code: "INTERNAL_ERROR",
      message: "The service failed unexpectedly.",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    await client.close();
  });
});

describe("logging", () => {
  it("never logs target URLs, provider queries, keys, raw audits or request content", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    const target = "https://private-target.example.com/account?session=abc123#frag";
    const client = await connect();
    await client.callTool({ name: TOOL_NAME, arguments: { url: target } });
    providerFetch.mockImplementation(async () =>
      Response.json(
        { error: { code: 500, message: `Lighthouse returned error: NO_FCP for ${target}` } },
        { status: 500 },
      ),
    );
    await client.callTool({ name: TOOL_NAME, arguments: { url: target } });
    await client.callTool({ name: TOOL_NAME, arguments: { url: `${target}&token=secret-value` } });
    await client.close();

    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("\n");
    for (const forbidden of [
      "private-target",
      "session=abc123",
      "secret-value",
      API_KEY,
      "pagespeedonline",
      "runPagespeed",
      "Title of",
      "hero.jpg",
      "Lighthouse returned error",
    ]) {
      expect(logged).not.toContain(forbidden);
    }
    // The safe fields are present.
    expect(logged).toContain('"event":"audit"');
    expect(logged).toContain('"release":"test-release"');
    expect(logged).toContain('"outcome":"PAGE_LOAD_FAILED"');
  });

  it("logs whether the client asked for progress notifications", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const client = await connect();
    // Invalid targets return before any provider call.
    await client.callTool({ name: TOOL_NAME, arguments: { url: "not-a-url" } });
    await client.callTool({ name: TOOL_NAME, arguments: { url: "not-a-url" } }, { onprogress: () => {} });
    await client.close();

    const audits = lines.filter((line) => line.includes('"event":"audit"'));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toContain('"progressRequested":false');
    expect(audits[1]).toContain('"progressRequested":true');
  });
});
