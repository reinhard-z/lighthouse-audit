/**
 * Local stdio mode (SPEC.md §3, §13). In-process tests connect a real SDK
 * client through linked in-memory transports and send provider calls to a
 * mock fetch. One test spawns the actual `src/stdio.ts` process without a key,
 * so it cannot reach Google, and checks that stdout carries only MCP messages.
 */
import { spawn } from "node:child_process";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditResultSchema, type AuditResult } from "../src/schemas";
import { TOOL_NAME } from "../src/server";
import type { SafeLogEntry } from "../src/server";
import { LOCAL_RELEASE, localEnv, localRuntime, serveLocal } from "../src/stdio";
import { syntheticPsiResponse } from "./fixtures/psi";

const API_KEY = "stdio-test-api-key-not-real";
const TARGET_URL = "https://www.example.com/landing?ref=stdio";

const openHandles: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (openHandles.length > 0) await openHandles.pop()?.close();
  vi.restoreAllMocks();
});

/** Serves the local runtime in memory and connects an SDK client to it. */
async function connectLocal(variables: Record<string, string | undefined>) {
  const providerFetch = vi.fn<typeof fetch>(async () => Response.json(syntheticPsiResponse()));
  const logs: SafeLogEntry[] = [];
  const runtime = { ...localRuntime(localEnv(variables), (entry) => logs.push(entry)), fetch: providerFetch };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  openHandles.push(serveLocal(runtime, serverTransport));
  const client = new Client({ name: "lighthouse-audit-stdio-tests", version: "1.0.0" });
  await client.connect(clientTransport);
  openHandles.push(client);
  return { client, providerFetch, logs };
}

/** Calls the tool and returns its schema-validated structured result. */
async function runAudit(client: Client): Promise<AuditResult> {
  const result = await client.callTool({ name: TOOL_NAME, arguments: { url: TARGET_URL } });
  return AuditResultSchema.parse((result as { structuredContent?: unknown }).structuredContent);
}

describe("local stdio mode", () => {
  it("maps only the key and timeout from the environment and always enables audits", () => {
    expect(localEnv({ PSI_API_KEY: API_KEY, PSI_TIMEOUT_MS: "30000", AUDITS_ENABLED: "false", OTHER: "x" })).toEqual({
      AUDITS_ENABLED: "true",
      PSI_API_KEY: API_KEY,
      PSI_TIMEOUT_MS: "30000",
    });
  });

  it("lists the same single tool as the Worker", async () => {
    const { client, providerFetch } = await connectLocal({});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tools[0]?.outputSchema?.type).toBe("object");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("returns SERVICE_UNAVAILABLE without a key and makes no provider call", async () => {
    const { client, providerFetch, logs } = await connectLocal({ PSI_API_KEY: " " });
    const result = await runAudit(client);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("SERVICE_UNAVAILABLE");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(logs).toEqual([expect.objectContaining({ release: LOCAL_RELEASE, outcome: "SERVICE_UNAVAILABLE" })]);
  });

  it("makes exactly one provider call per tool call with the operator's key in the header", async () => {
    const { client, providerFetch, logs } = await connectLocal({ PSI_API_KEY: API_KEY });
    const first = await runAudit(client);
    const second = await runAudit(client);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(providerFetch).toHaveBeenCalledTimes(2);

    const [requestUrl, init] = providerFetch.mock.calls[0] ?? [];
    expect(String(requestUrl)).not.toContain(API_KEY);
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(API_KEY);
    expect(init?.redirect).toBe("manual");

    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain("example.com");
  });

  it("serves an SDK client as a process without a key", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/stdio.ts"],
      // Only PATH: no key, so nothing in this test can reach Google.
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    let stderrText = "";
    transport.stderr?.on("data", (chunk: unknown) => (stderrText += String(chunk)));
    const client = new Client({ name: "lighthouse-audit-stdio-process-test", version: "1.0.0" });
    await client.connect(transport);
    openHandles.push(client);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
    const result = await runAudit(client);
    expect(result.error?.code).toBe("SERVICE_UNAVAILABLE");
    expect(stderrText).toContain("PSI_API_KEY is not set");
  }, 30_000);

  it("writes nothing but JSON-RPC messages to stdout", async () => {
    // The SDK client skips unparseable lines, so read the raw stream instead.
    const child = spawn(process.execPath, ["--import", "tsx", "src/stdio.ts"], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    openHandles.push({ close: async () => void child.kill() });
    let stdout = "";
    const listed = new Promise<void>((resolve) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('"id":2')) resolve();
      });
    });
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    child.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
    await listed;

    const lines = stdout.split("\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  }, 30_000);
});
