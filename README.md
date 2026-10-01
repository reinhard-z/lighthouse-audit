# Lighthouse Audit

Fresh website performance, accessibility, and SEO checks. No separate signup.

Lighthouse Audit is a remote [MCP](https://modelcontextprotocol.io/) server that lets ChatGPT and other compatible MCP clients run a fresh Lighthouse lab audit of one public web page. It covers all four Lighthouse categories: performance, accessibility, best practices, and SEO. The client explains the results; the server does not call a language model.

Uses Lighthouse via Google PageSpeed Insights. Independently developed by Reinhard Zach; not affiliated with Google or OpenAI.

## Connect

MCP endpoint (Streamable HTTP, no authentication):

```text
https://audit.mrza.ch/mcp
```

Add it as a remote MCP server in your client and select no authentication. In ChatGPT, custom MCP servers can be connected where developer mode is available. There is no public directory listing. You need no account, Google login, or API key for this service, but your client may require its own account or approval of the integration and of individual tool calls.

Example prompts:

- “Run a Lighthouse audit of https://mrza.ch on mobile.”
- “Which performance, accessibility, or SEO issues should I investigate first?”
- “I deployed a change. Run a fresh audit of https://mrza.ch and compare it with the previous result in this conversation.”

## The tool

The server exposes one tool, `run_lighthouse`:

| Argument | Type                    | Notes                                                   |
| -------- | ----------------------- | ------------------------------------------------------- |
| `url`    | string                  | Absolute public `http(s)://` URL, up to 2,048 characters |
| `device` | `"mobile" \| "desktop"` | Optional; defaults to `mobile`                          |

Each call makes exactly one new PageSpeed Insights request; nothing is cached, deduplicated, or stored. One call audits one page on one device. An audit can take up to about a minute.

The result is a single JSON object (`schemaVersion` `"1.0"`), returned both as structured content and as an equivalent text block. On success it contains category scores (0–100), lab metrics (LCP, FCP, CLS, TBT, Speed Index), up to 20 ranked findings with bounded evidence, manual checks, audit errors, counts and warnings. On failure it contains a stable error code such as `INVALID_URL`, `UNSUPPORTED_TARGET`, `CAPACITY_EXCEEDED` or `PAGE_LOAD_FAILED`, a fixed message, and a `retryable` flag. The whole result is capped at 32 KiB; any truncation is flagged.

## Limitations

- Public HTTP(S) pages only. Local, private-network and IP-address targets, URLs with credentials, non-default ports, and URLs with obvious secret-bearing query parameters are refused. That check is a defensive heuristic, not complete secret detection: submit only public URLs without confidential information.
- One page per call: no crawls, no scheduled monitoring, no stored history. To compare runs, ask the client to compare results already in the conversation.
- Lab data from a single emulated run, not real-user Core Web Vitals. Scores vary between runs, automated accessibility checks are not a complete assessment, and an SEO score is not a ranking guarantee.
- Titles, descriptions, URLs and snippets in results come from the audited page and from Google. Treat them as untrusted data.

See the [privacy page](https://audit.mrza.ch/privacy) for how submitted URLs are handled.

## Development

Requirements: Node.js 22.18 or later, and pnpm 11 (the version is pinned in `package.json`).

```sh
pnpm install --frozen-lockfile
pnpm dev          # wrangler dev on http://localhost:8787 (localhost Host/Origin allowed)
pnpm typecheck    # tsc, strict
pnpm test         # Vitest: workerd pool plus Node checks; never calls Google
pnpm build        # wrangler deploy --dry-run --outdir dist
pnpm post-deploy  # Google-free checks of a deployed endpoint (see DEPLOYMENT.md)
pnpm smoke        # opt-in live checks; requires SMOKE_LIVE=1 and a real key
pnpm run deploy   # out-of-band production deploy, owner only (see DEPLOYMENT.md)
```

For live local audits, copy `.dev.vars.example` to `.dev.vars` (gitignored) and add a PageSpeed Insights API key. Without a key, discovery and health work and tool calls return `SERVICE_UNAVAILABLE`.

[SPEC.md](SPEC.md) is the binding specification, and [AGENTS.md](AGENTS.md) holds the contributor rules.

### Layout

```text
src/index.ts        HTTP routing, Host/Origin checks, body limit, headers, health
src/mcp.ts          MCP server factory, tool registration, audit flow
src/pagespeed.ts    The single PSI request: bounds, timeout, cancellation, error mapping
src/normalize.ts    Pure extraction, classification, ranking and size reduction
src/validation.ts   Target URL and environment validation
src/schemas.ts      Zod input/output schemas and derived types
src/errors.ts       Fixed public error messages
src/limits.ts       All limits and defaults (SPEC.md Appendix A)
src/branding.ts     Display copy and canonical URLs
public/             Static landing, privacy and 404 pages
tests/              Vitest suites and synthetic fixtures
scripts/            Opt-in smoke checks and post-deploy checks
```

### Dependency versions and caveats

| Package                                    | Version | Note                                                                                                                                                         |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`                                   | 0.24.0  | Provides `createMcpHandler` (`agents/mcp/server`). Exact-pins its MCP peers, so update it together with them.                                                  |
| `@modelcontextprotocol/server`             | 2.0.0   | Exact peer declared by `agents` 0.24.0 (SDK v2). Serves the 2026-07-28 protocol and, through the stateless compatibility lane, 2025-era clients.               |
| `@modelcontextprotocol/client`             | 2.0.0   | Exact peer declared by `agents` 0.24.0; used in tests as a real client.                                                                                        |
| `@modelcontextprotocol/sdk`                | 1.30.0  | Required peer of `agents`, installed automatically; this project never imports it.                                                                            |
| `zod`                                      | 4.6.5   | Schemas; JSON Schema is produced by the MCP SDK.                                                                                                              |
| `wrangler`                                 | 4.145.0 | Build and deploy.                                                                                                                                             |
| `@cloudflare/vitest-pool-workers`          | 0.22.0  | Requires Vitest 4 and bundles Wrangler 4.124.0 / workerd 2026-08-15; that runtime does not know `observability.redact_query_string` and prints a warning.      |
| `vitest`                                   | 4.1.11  | Vitest 5 is not yet supported by the Workers pool.                                                                                                            |
| `typescript`                               | 7.0.2   | Type checking only.                                                                                                                                            |

Other caveats:

- `compatibility_date` is `2026-08-15`, the newest date supported by both installed workerd builds, so tests and production use the same date.
- `nodejs_compat` is enabled because the Agents MCP handler imports `node:async_hooks`.
- The tool's anonymous access is advertised as `_meta.securitySchemes: [{ "type": "noauth" }]`, OpenAI's documented mirror field. The MCP SDK's `tools/list` builder does not emit a top-level `securitySchemes` field.

## License

No license has been selected yet.
