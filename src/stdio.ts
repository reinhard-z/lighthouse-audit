/**
 * Local stdio entry for self-hosting (SPEC.md §3). Serves the same single tool
 * over stdio in Node, with the operator's own PageSpeed Insights key from the
 * environment. Started with `pnpm stdio`; the hosted Worker does not use it.
 *
 * stdout carries only MCP messages. Diagnostics go to stderr, with the same
 * safe fields as the Worker logs (§8).
 */
import { pathToFileURL } from "node:url";
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createAuditServer, type AuditRuntime, type SafeLogEntry } from "./server";
import type { WorkerEnv } from "./validation";

/** Release identifier reported in local logs; local runs are not deployments. */
export const LOCAL_RELEASE = "local";

/**
 * Maps process environment variables to the configuration the audit flow
 * validates. Local mode has no separate kill switch: audits are enabled, and a
 * missing or empty `PSI_API_KEY` makes tool calls return SERVICE_UNAVAILABLE,
 * as it does in the Worker.
 */
export function localEnv(variables: Readonly<Record<string, string | undefined>>): WorkerEnv {
  return {
    AUDITS_ENABLED: "true",
    PSI_API_KEY: variables.PSI_API_KEY,
    PSI_TIMEOUT_MS: variables.PSI_TIMEOUT_MS,
  };
}

/** Writes one safe diagnostic line to stderr, never to the protocol channel. */
function writeStderrLog(entry: SafeLogEntry): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

/** Runtime for the stdio process; one runtime serves every call on the connection. */
export function localRuntime(env: WorkerEnv, log: (entry: SafeLogEntry) => void = writeStderrLog): AuditRuntime {
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    randomId: () => crypto.randomUUID(),
    release: LOCAL_RELEASE,
    log,
  };
}

/**
 * Serves MCP over stdio with the given runtime. `transport` replaces the
 * process's stdin/stdout, which tests use to connect in memory.
 */
export function serveLocal(
  runtime: AuditRuntime,
  transport?: ServeStdioOptions["transport"],
): StdioServerHandle {
  return serveStdio(() => createAuditServer(() => runtime), {
    ...(transport !== undefined && { transport }),
    // SDK errors are logged by name only; messages may echo request content.
    onerror: (error) => runtime.log({ event: "mcp_error", release: runtime.release, errorName: error.name }),
  });
}

/** Process entry: serve on stdin/stdout until the client disconnects. */
function main(): void {
  const env = localEnv(process.env);
  if (typeof env.PSI_API_KEY !== "string" || env.PSI_API_KEY.trim() === "") {
    process.stderr.write(
      "Lighthouse Audit: PSI_API_KEY is not set, so tool calls return SERVICE_UNAVAILABLE.\n",
    );
  }
  serveLocal(localRuntime(env));
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) main();
