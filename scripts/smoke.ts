/**
 * Opt-in live smoke checks (SPEC.md §6, §13). These make REAL requests to
 * Google PageSpeed Insights and use the owner's quota. CI never runs them.
 *
 *   SMOKE_LIVE=1 pnpm smoke provider [--save]
 *     One direct PSI request with the pinned `fields` mask and the key in the
 *     x-goog-api-key header. Reports status, projected response size, whether
 *     the header was accepted, and the projected field names. `--save` writes
 *     the raw body to smoke-output/ (gitignored) for the owner to sanitize
 *     before turning it into a fixture.
 *
 *   SMOKE_LIVE=1 pnpm smoke endpoint [--base-url http://localhost:8787]
 *     Against `pnpm dev` (with a real key in .dev.vars) or production after
 *     audits are enabled: initialize, tools/list, then a mobile audit of
 *     https://mrza.ch, a second sequential mobile audit and one desktop audit.
 *
 * The key is read from the PSI_API_KEY environment variable or .dev.vars and
 * is never printed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildPageSpeedUrl, PSI_FIELDS } from "../src/pagespeed";

const SMOKE_TARGET = "https://mrza.ch/";
const OUTPUT_DIRECTORY = "smoke-output";

function readApiKey(): string {
  if (process.env.PSI_API_KEY) return process.env.PSI_API_KEY;
  if (existsSync(".dev.vars")) {
    const match = /^PSI_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/m.exec(readFileSync(".dev.vars", "utf8"));
    if (match?.[1]) return match[1].trim();
  }
  throw new Error("Set PSI_API_KEY or create .dev.vars from .dev.vars.example");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One direct provider request; validates the fields mask and header auth. */
async function provider(save: boolean): Promise<void> {
  const started = Date.now();
  const response = await fetch(buildPageSpeedUrl(SMOKE_TARGET, "mobile"), {
    headers: { "x-goog-api-key": readApiKey(), accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`fields mask: ${PSI_FIELDS}`);
  console.log(`status: ${response.status}; duration: ${seconds} s; projected body: ${Buffer.byteLength(text)} bytes`);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    console.log("body is not JSON");
  }
  if (response.ok && isRecord(body) && isRecord(body.lighthouseResult)) {
    const lighthouse = body.lighthouseResult;
    console.log("x-goog-api-key header: accepted");
    console.log(`top-level fields: ${Object.keys(body).join(", ")}`);
    console.log(`lighthouseResult fields: ${Object.keys(lighthouse).join(", ")}`);
    console.log(`categories: ${isRecord(lighthouse.categories) ? Object.keys(lighthouse.categories).join(", ") : "missing"}`);
    console.log(`audits: ${isRecord(lighthouse.audits) ? Object.keys(lighthouse.audits).length : "missing"}`);
    console.log(`lighthouseVersion: ${String(lighthouse.lighthouseVersion)}; fetchTime: ${String(lighthouse.fetchTime)}`);
  } else if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    const reasons = [
      ...(Array.isArray(error.details) ? error.details : []),
      ...(Array.isArray(error.errors) ? error.errors : []),
    ]
      .map((item) => (isRecord(item) ? item.reason : undefined))
      .filter((reason) => typeof reason === "string");
    console.log(`provider error status: ${String(error.status)}; reasons: ${reasons.join(", ") || "none"}`);
    console.log("Review the message manually; it may mention the field mask or the API key.");
  }

  if (save) {
    mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    const path = `${OUTPUT_DIRECTORY}/psi-${response.status}-${Date.now()}.json`;
    writeFileSync(path, text);
    console.log(`saved raw body to ${path}; sanitize and label it before committing any part of it`);
  }
}

/** Posts a JSON-RPC message to the endpoint and parses JSON or single-event SSE. */
async function rpc(baseUrl: string, id: number, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const json = text.startsWith("event:") || text.startsWith("data:")
    ? (text.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice(6)
    : text;
  return JSON.parse(json);
}

/** The MCP checks against a running endpoint, including three live audits. */
async function endpoint(baseUrl: string): Promise<void> {
  await rpc(baseUrl, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  });
  const list = await rpc(baseUrl, 2, "tools/list", {});
  const tools = isRecord(list) && isRecord(list.result) && Array.isArray(list.result.tools) ? list.result.tools : [];
  console.log(`tools: ${tools.length}`);

  const runs = [
    { label: "mobile #1", device: "mobile" },
    { label: "mobile #2", device: "mobile" },
    { label: "desktop", device: "desktop" },
  ];
  for (const [index, run] of runs.entries()) {
    const started = Date.now();
    const message = await rpc(baseUrl, 10 + index, "tools/call", {
      name: "run_lighthouse",
      arguments: { url: SMOKE_TARGET, device: run.device },
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const result = isRecord(message) && isRecord(message.result) ? message.result : {};
    const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
    const report = isRecord(structured.report) ? structured.report : undefined;
    const error = isRecord(structured.error) ? structured.error : undefined;
    console.log(`${run.label}: ${seconds} s; serialized result ${Buffer.byteLength(JSON.stringify(result))} bytes`);
    if (report) {
      console.log(`  scores ${JSON.stringify(report.scores)}`);
      console.log(`  labMetrics ${JSON.stringify(report.labMetrics)}`);
      console.log(`  requestStartedAt ${String(report.requestStartedAt)}; providerFetchTime ${String(report.providerFetchTime)}`);
      console.log(`  issues ${Array.isArray(report.issues) ? report.issues.length : "?"}; counts ${JSON.stringify(report.counts)}; truncated ${String(report.truncated)}`);
    } else {
      console.log(`  error ${JSON.stringify(error)}`);
    }
  }
}

async function main(): Promise<void> {
  if (process.env.SMOKE_LIVE !== "1") {
    console.error("Refusing to run: these checks call Google PageSpeed Insights. Set SMOKE_LIVE=1 to confirm.");
    process.exitCode = 1;
    return;
  }
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "provider") {
    await provider(rest.includes("--save"));
  } else if (mode === "endpoint") {
    const baseUrlIndex = rest.indexOf("--base-url");
    const baseUrl = baseUrlIndex >= 0 ? rest[baseUrlIndex + 1] : "http://localhost:8787";
    await endpoint((baseUrl ?? "http://localhost:8787").replace(/\/+$/, ""));
  } else {
    console.error("Usage: SMOKE_LIVE=1 pnpm smoke <provider [--save] | endpoint [--base-url URL]>");
    process.exitCode = 1;
  }
}

await main();
