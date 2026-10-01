/**
 * Google-free checks of a deployed endpoint (SPEC.md §11).
 *
 * Runs with plain Node (built-in type stripping), without installing
 * dependencies, so the verify job never needs the dependency tree. Output is
 * public in CI logs: it prints only pass/fail per check, HTTP status codes and
 * the release identifier, never response bodies or headers.
 *
 * Usage:
 *   node scripts/post-deploy.ts [--base-url https://audit.mrza.ch] [--release <sha>]
 *
 * The tool-call check runs only while wrangler.jsonc keeps AUDITS_ENABLED
 * "false"; with audits enabled a tool call would contact Google, so it is skipped.
 */
import { readFileSync } from "node:fs";
import { CANONICAL_ORIGIN } from "../src/branding.ts";

const REQUEST_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = "2025-06-18";

interface Options {
  baseUrl: string;
  release: string | undefined;
}

function parseArguments(argv: string[]): Options {
  const options: Options = { baseUrl: CANONICAL_ORIGIN, release: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--base-url" && value !== undefined) {
      options.baseUrl = value.replace(/\/+$/, "");
      index += 1;
    } else if (argv[index] === "--release" && value !== undefined) {
      options.release = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

/** Reads the kill-switch value committed in wrangler.jsonc. */
function auditsEnabledInConfig(): boolean {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const match = /"AUDITS_ENABLED"\s*:\s*"(true|false)"/.exec(config);
  if (match === null) throw new Error("AUDITS_ENABLED not found in wrangler.jsonc");
  return match[1] === "true";
}

function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
}

/** Posts one JSON-RPC message to /mcp and returns the status and parsed message. */
async function mcp(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; message: Record<string, unknown> | undefined }> {
  const response = await request(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6)
    : text;
  try {
    return { status: response.status, message: JSON.parse(json) as Record<string, unknown> };
  } catch {
    return { status: response.status, message: undefined };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Check = { name: string; run: () => Promise<{ pass: boolean; detail: string }> };

async function main(): Promise<void> {
  const { baseUrl, release } = parseArguments(process.argv.slice(2));
  const auditsEnabled = auditsEnabledInConfig();

  const checks: Check[] = [
    {
      name: "GET /healthz returns 200 with the expected release",
      run: async () => {
        const response = await request(`${baseUrl}/healthz`);
        const body: unknown = await response.json().catch(() => undefined);
        const reported = isRecord(body) && typeof body.release === "string" ? body.release : "?";
        const pass =
          response.status === 200 &&
          isRecord(body) &&
          body.ok === true &&
          (release === undefined || reported === release);
        return { pass, detail: `status ${response.status}, release ${reported}` };
      },
    },
    {
      name: "GET / returns the landing page",
      run: async () => {
        const response = await request(`${baseUrl}/`);
        const html = await response.text();
        return {
          pass: response.status === 200 && html.includes("<h1>Lighthouse Audit</h1>"),
          detail: `status ${response.status}`,
        };
      },
    },
    {
      name: "An unknown path returns 404",
      run: async () => {
        const response = await request(`${baseUrl}/post-deploy-check-${Date.now()}`);
        await response.body?.cancel();
        return { pass: response.status === 404, detail: `status ${response.status}` };
      },
    },
    {
      name: "MCP initialize succeeds",
      run: async () => {
        const { status, message } = await mcp(baseUrl, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "post-deploy-check", version: "1.0.0" },
          },
        });
        return { pass: status === 200 && isRecord(message?.result), detail: `status ${status}` };
      },
    },
    {
      name: "MCP tools/list shows exactly one tool",
      run: async () => {
        const { status, message } = await mcp(baseUrl, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const tools = isRecord(message?.result) ? message.result.tools : undefined;
        const pass =
          status === 200 &&
          Array.isArray(tools) &&
          tools.length === 1 &&
          isRecord(tools[0]) &&
          tools[0].name === "run_lighthouse";
        return { pass, detail: `status ${status}, tools ${Array.isArray(tools) ? tools.length : "?"}` };
      },
    },
    {
      name: "A foreign Origin is rejected with 403",
      run: async () => {
        const { status } = await mcp(
          baseUrl,
          { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
          { origin: "https://foreign-origin.example" },
        );
        return { pass: status === 403, detail: `status ${status}` };
      },
    },
  ];

  if (!auditsEnabled) {
    checks.push({
      name: "With AUDITS_ENABLED=false a tool call returns the disabled error",
      run: async () => {
        const { status, message } = await mcp(baseUrl, {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "run_lighthouse", arguments: { url: "https://www.example.com/" } },
        });
        const result = isRecord(message?.result) ? message.result : undefined;
        const structured = isRecord(result?.structuredContent) ? result.structuredContent : undefined;
        const error = isRecord(structured?.error) ? structured.error : undefined;
        const code = typeof error?.code === "string" ? error.code : "?";
        return {
          pass: status === 200 && result?.isError === true && code === "SERVICE_UNAVAILABLE",
          detail: `status ${status}, code ${code}`,
        };
      },
    });
  }

  let failures = 0;
  for (const check of checks) {
    let outcome: { pass: boolean; detail: string };
    try {
      outcome = await check.run();
    } catch (error) {
      outcome = { pass: false, detail: error instanceof Error ? error.name : "error" };
    }
    if (!outcome.pass) failures += 1;
    console.log(`${outcome.pass ? "PASS" : "FAIL"}  ${check.name} (${outcome.detail})`);
  }
  if (auditsEnabled) {
    console.log("SKIP  Tool call check: audits are enabled, and a tool call would contact Google");
  }
  console.log(`${failures === 0 ? "All checks passed" : `${failures} check(s) failed`}; release ${release ?? "not checked"}`);
  if (failures > 0) process.exitCode = 1;
}

await main();
