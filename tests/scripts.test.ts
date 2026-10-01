/** Operational CLI regression tests with synthetic responses; fetch never reaches the network. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../src/guards";
import { extractReportDraft, fitAuditResult } from "../src/normalize";
import { MAX_TOOL_RESULT_BYTES } from "../src/limits";
import { toCallToolResult } from "../src/tool-result";
import { syntheticPsiResponse } from "./fixtures/psi";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  process.exitCode = 0;
  vi.stubEnv("SMOKE_LIVE", "1");
  vi.stubEnv("PSI_API_KEY", "synthetic-script-test-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected fetch in script test");
  }));
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Executes the actual smoke entry point, including its exit-status handling. */
async function smoke(mode: "provider" | "endpoint"): Promise<void> {
  process.argv = ["node", "scripts/smoke.ts", mode];
  await import("../scripts/smoke");
}

/** Produces a valid synthetic tool result for each requested device. */
function toolResult(device: "mobile" | "desktop") {
  const draft = extractReportDraft(syntheticPsiResponse(), {
    requestedUrl: "https://mrza.ch/",
    device,
    requestStartedAt: new Date("2026-10-01T10:00:00Z"),
    completedAt: new Date("2026-10-01T10:00:30Z"),
  });
  if (!draft.ok) throw new Error("Invalid synthetic fixture");
  return toCallToolResult(fitAuditResult(draft.draft, "script-test", MAX_TOOL_RESULT_BYTES));
}

/** Narrows outgoing script requests before the fake endpoint inspects them. */
function readRequest(init?: RequestInit) {
  const value: unknown = JSON.parse(String(init?.body));
  if (!isRecord(value) || typeof value.method !== "string" || typeof value.id !== "number") {
    throw new Error("Invalid script request");
  }
  const params = isRecord(value.params) ? value.params : {};
  const args = isRecord(params.arguments) ? params.arguments : {};
  return { method: value.method, id: value.id, args };
}

/** Replies to the three smoke RPC methods, optionally replacing one result. */
function endpointResponses(override?: { method: string; result: unknown }) {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const request = readRequest(init);
    let result: unknown;
    if (override !== undefined && request.method === override.method) {
      result = override.result;
    } else if (request.method === "initialize") {
      result = { protocolVersion: "2025-06-18", serverInfo: { name: "synthetic" }, capabilities: {} };
    } else if (request.method === "tools/list") {
      result = { tools: [{ name: "run_lighthouse" }] };
    } else {
      const device = request.args.device;
      if (device !== "mobile" && device !== "desktop") throw new Error("Invalid device");
      result = toolResult(device);
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
}

describe("provider smoke exit status", () => {
  it.each([
    ["HTTP rejection", () => Response.json({ error: { status: "INVALID_ARGUMENT" } }, { status: 400 })],
    ["malformed JSON", () => new Response("{")],
    ["missing report", () => Response.json({})],
    ["runtime failure", () => Response.json({ lighthouseResult: { runtimeError: { code: "NO_FCP" } } })],
  ] as const)("fails on %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    await smoke("provider");
    expect(process.exitCode).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("passes a usable provider report", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(syntheticPsiResponse())));
    await smoke("provider");
    expect(process.exitCode).toBe(0);
  });
});

describe("endpoint smoke exit status", () => {
  it.each([200, 500])("fails on a JSON-RPC error at HTTP %s before making audit calls", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Synthetic failure" },
    }, { status })));
    await smoke("endpoint");
    expect(process.exitCode).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["initialize", {}],
    ["tools/list", { tools: [] }],
    ["tools/call", { isError: true, content: [] }],
    ["tools/call", { structuredContent: { ok: true, report: {} } }],
  ])("fails on an invalid %s result", async (method, result) => {
    vi.stubGlobal("fetch", endpointResponses({ method, result }));
    await smoke("endpoint");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a schema-valid tool failure", async () => {
    vi.stubGlobal("fetch", endpointResponses({
      method: "tools/call",
      result: toCallToolResult({
        schemaVersion: "1.0", requestId: "synthetic", ok: false, report: null,
        error: { code: "AUDIT_TIMEOUT", message: "Synthetic timeout", retryable: true },
      }),
    }));
    await smoke("endpoint");
    expect(process.exitCode).toBe(1);
  });

  it("passes initialization, discovery and three valid audits", async () => {
    vi.stubGlobal("fetch", endpointResponses());
    await smoke("endpoint");
    expect(process.exitCode).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each(["{}", "{", " ".repeat(MAX_TOOL_RESULT_BYTES)])("rejects invalid or oversized text fallback", async (text) => {
    const result = toolResult("mobile");
    result.content[0].text = text;
    vi.stubGlobal("fetch", endpointResponses({ method: "tools/call", result }));
    await smoke("endpoint");
    expect(process.exitCode).toBe(1);
  });

  it("accepts equivalent text with different JSON formatting", async () => {
    const respond = endpointResponses();
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const response = await respond(input, init);
      const message: unknown = await response.json();
      if (isRecord(message) && isRecord(message.result) && Array.isArray(message.result.content)) {
        const textBlock = message.result.content[0];
        if (isRecord(textBlock)) textBlock.text = JSON.stringify(message.result.structuredContent, null, 2);
      }
      return Response.json(message);
    }));
    await smoke("endpoint");
    expect(process.exitCode).toBe(0);
  });

  it("does not expose unexpected exception text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("secret-provider-url"); }));
    await smoke("endpoint");
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toContain("secret-provider-url");
  });
});

/** Makes the post-deploy script read the given committed kill-switch value. */
function stubCommittedSwitch(value: "true" | "false"): void {
  vi.doMock("node:fs", async (importOriginal) => {
    const fs = await importOriginal<typeof import("node:fs")>();
    return {
      ...fs,
      readFileSync: (path: Parameters<typeof fs.readFileSync>[0], options?: unknown) =>
        String(path).endsWith("wrangler.jsonc")
          ? `{ "vars": { "AUDITS_ENABLED": "${value}" } }`
          : fs.readFileSync(path, options as BufferEncoding),
    };
  });
}

/** Synthetic deployed endpoint; records the target of any tools/call. */
function stubEndpoint(code: string): { target: () => unknown } {
  let target: unknown;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    if (path === "/healthz") return Response.json({ ok: true, release: "synthetic" });
    if (path === "/") return new Response("<h1>Lighthouse Audit</h1>");
    if (path !== "/mcp") return new Response("Not found", { status: 404 });
    if (new Headers(init?.headers).has("origin")) return new Response("Forbidden", { status: 403 });
    const request = readRequest(init);
    let result: unknown = {};
    if (request.method === "tools/list") result = { tools: [{ name: "run_lighthouse" }] };
    if (request.method === "tools/call") {
      target = request.args.url;
      result = { isError: true, structuredContent: { error: { code } } };
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  }));
  return { target: () => target };
}

describe("post-deploy disabled-service probe", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
  });

  it.each(["SERVICE_UNAVAILABLE", "INVALID_URL"])("uses an invalid URL when the endpoint returns %s", async (code) => {
    stubCommittedSwitch("false");
    const endpoint = stubEndpoint(code);
    process.argv = ["node", "scripts/post-deploy.ts"];
    await import("../scripts/post-deploy");
    expect(endpoint.target()).toBe("not-a-url");
    expect(process.exitCode).toBe(code === "SERVICE_UNAVAILABLE" ? 0 : 1);
  });

  it("makes no tool call while the committed switch enables audits", async () => {
    stubCommittedSwitch("true");
    const endpoint = stubEndpoint("SERVICE_UNAVAILABLE");
    process.argv = ["node", "scripts/post-deploy.ts"];
    await import("../scripts/post-deploy");
    expect(endpoint.target()).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });
});
