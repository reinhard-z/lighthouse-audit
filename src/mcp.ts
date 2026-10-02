/**
 * The Worker's Streamable HTTP MCP handler (SPEC.md §3, §8).
 *
 * The handler is created once at module scope; it builds a fresh `McpServer`
 * from `server.ts` per request. Request-specific inputs (bindings, fetch,
 * clock) reach the tool through an AsyncLocalStorage scope opened by
 * `handleMcpRequest`, never through mutable module state.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "agents/mcp/server";
import { CANONICAL_ORIGIN, PRODUCTION_HOSTNAME } from "./branding";
import { createAuditServer, type AuditRuntime } from "./server";

/** Hostnames accepted only during local development (`pnpm dev`, MCP Inspector). */
export const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

const runtimeScope = new AsyncLocalStorage<AuditRuntime>();

/** Server factory for the handler: the tool reads the current request's runtime. */
function createScopedServer() {
  return createAuditServer(() => runtimeScope.getStore());
}

/** Logs SDK-reported errors by name only; messages may echo request content. */
function reportHandlerError(error: Error): void {
  const runtime = runtimeScope.getStore();
  runtime?.log({ event: "mcp_error", release: runtime.release, errorName: error.name });
}

/** Production: only the canonical Host and Origin (§8). SDK validation stays on. */
const productionHandler = createMcpHandler(createScopedServer, {
  route: "/mcp",
  allowedHostnames: [PRODUCTION_HOSTNAME],
  allowedOriginHostnames: [PRODUCTION_HOSTNAME],
  corsOptions: { origin: CANONICAL_ORIGIN },
  onerror: reportHandlerError,
});

/** Local development: also localhost, for `wrangler dev` and MCP Inspector. */
const developmentHandler = createMcpHandler(createScopedServer, {
  route: "/mcp",
  allowedHostnames: [PRODUCTION_HOSTNAME, ...LOCAL_HOSTNAMES],
  allowedOriginHostnames: [PRODUCTION_HOSTNAME, ...LOCAL_HOSTNAMES],
  corsOptions: { origin: "*" },
  onerror: reportHandlerError,
});

/** Serves one `/mcp` request with the given runtime in scope. */
export function handleMcpRequest(
  request: Request,
  runtime: AuditRuntime,
  context: ExecutionContext,
  localDevelopment: boolean,
): Promise<Response> {
  const handler = localDevelopment ? developmentHandler : productionHandler;
  return runtimeScope.run(runtime, () => handler(request, runtime.env, context));
}
