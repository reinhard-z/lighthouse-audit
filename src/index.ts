/**
 * Worker entry: HTTP routing, Host/Origin checks, body limits, response
 * headers and health (SPEC.md §3, §8, §11).
 *
 * Static Assets serve `/`, `/privacy` and the 404 page without running this
 * script; only `/mcp`, `/mcp/*` and `/healthz` run the Worker first.
 * Nothing on these routes except a `tools/call` can reach the provider.
 */
import { CANONICAL_ORIGIN, PRODUCTION_HOSTNAME } from "./branding";
import { MAX_MCP_REQUEST_BODY_BYTES } from "./limits";
import { LOCAL_HOSTNAMES, handleMcpRequest } from "./mcp";
import type { AuditRuntime, SafeLogEntry } from "./server";
import { isLocalDevelopment, releaseOf, type WorkerEnv } from "./validation";

/** Headers on every Worker-generated response; `_headers` covers static assets only. */
const WORKER_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export default {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isMcp = url.pathname === "/mcp";
    const isWorkerRoute = isMcp || url.pathname.startsWith("/mcp/") || url.pathname === "/healthz";
    if (!isWorkerRoute) return serveStaticAsset(request, env);

    const release = releaseOf(env);
    try {
      const localDevelopment = isLocalDevelopment(env);
      const rejection = checkHostAndOrigin(request, url, localDevelopment);
      if (rejection !== undefined) return withWorkerHeaders(rejection);

      if (url.pathname === "/healthz") return withWorkerHeaders(health(request, release));
      if (!isMcp) return withWorkerHeaders(jsonError(404, "not_found"));

      const bounded = await withBoundedBody(request);
      if (bounded instanceof Response) return withWorkerHeaders(bounded);

      const runtime: AuditRuntime = {
        env,
        fetch: (input, init) => fetch(input, init),
        now: () => new Date(),
        randomId: () => crypto.randomUUID(),
        release,
        log: writeLog,
      };
      return withWorkerHeaders(await handleMcpRequest(bounded, runtime, context, localDevelopment));
    } catch (error) {
      writeLog({
        event: "mcp_error",
        release,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return withWorkerHeaders(jsonError(500, "internal_error"));
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

/** Writes one structured log line containing only safe diagnostic fields. */
function writeLog(entry: SafeLogEntry): void {
  console.log(JSON.stringify(entry));
}

/** Delegates to Static Assets, which serve `public/404.html` for unknown paths. */
function serveStaticAsset(request: Request, env: WorkerEnv): Promise<Response> | Response {
  if (env.ASSETS === undefined) return withWorkerHeaders(jsonError(404, "not_found"));
  return env.ASSETS.fetch(request);
}

/**
 * Production accepts only `Host: audit.mrza.ch`. A browser `Origin`, when
 * present, must be the canonical origin; requests without one (server-side
 * MCP clients) are accepted. Local development also allows localhost.
 */
function checkHostAndOrigin(request: Request, url: URL, localDevelopment: boolean): Response | undefined {
  const allowedHost = (hostname: string) =>
    hostname === PRODUCTION_HOSTNAME ||
    (localDevelopment && (LOCAL_HOSTNAMES as readonly string[]).includes(hostname));
  // Judge the Host header itself, as the SDK's own validation does.
  const hostHeader = request.headers.get("host");
  if (hostHeader === null || !allowedHost(hostnameOf(hostHeader))) {
    return jsonError(403, "forbidden_host");
  }
  if (!allowedHost(url.hostname.toLowerCase())) return jsonError(403, "forbidden_host");

  const origin = request.headers.get("origin");
  if (origin === null || origin === CANONICAL_ORIGIN) return undefined;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return jsonError(403, "forbidden_origin");
  }
  const localOrigin =
    localDevelopment &&
    (originUrl.protocol === "http:" || originUrl.protocol === "https:") &&
    (LOCAL_HOSTNAMES as readonly string[]).includes(originUrl.hostname);
  return localOrigin ? undefined : jsonError(403, "forbidden_origin");
}

/** Lower-cased hostname of a Host header value, without any port. */
function hostnameOf(hostHeader: string): string {
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(hostHeader)) return "";
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Cheap liveness check; never contacts the provider. */
function health(request: Request, release: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method_not_allowed", { Allow: "GET, HEAD" });
  }
  return Response.json({ ok: true, release });
}

/**
 * Reads a POST body up to the MCP limit, whatever Content-Length claims, and
 * returns an equivalent request with the buffered body, or a 413 response.
 * Other methods carry no body the handler reads and pass through unchanged.
 */
async function withBoundedBody(request: Request): Promise<Request | Response> {
  if (request.method !== "POST") return request;
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_MCP_REQUEST_BODY_BYTES) {
    await request.body?.cancel().catch(() => {});
    return jsonError(413, "payload_too_large");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return jsonError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

function jsonError(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers });
}

/** Copies a response with the Worker security and caching headers applied. */
function withWorkerHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(WORKER_RESPONSE_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
