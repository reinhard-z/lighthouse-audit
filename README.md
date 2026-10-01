# Lighthouse Audit

[![CI](https://github.com/reinhard-z/lighthouse-audit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/reinhard-z/lighthouse-audit/actions/workflows/ci.yml)
[![Deploy production](https://github.com/reinhard-z/lighthouse-audit/actions/workflows/deploy.yml/badge.svg)](https://github.com/reinhard-z/lighthouse-audit/actions/workflows/deploy.yml)
[![MCP: Streamable HTTP](https://img.shields.io/badge/MCP-Streamable_HTTP-blue)](#connect)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs_on-Cloudflare_Workers-F38020)](https://developers.cloudflare.com/workers/)
[![Node.js 22.18+](https://img.shields.io/badge/node-%E2%89%A522.18-339933)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Fresh website performance, accessibility, and SEO checks. No separate signup.

Lighthouse Audit is a remote [MCP](https://modelcontextprotocol.io/) server. Connect it to ChatGPT or another MCP client, give it the address of a public web page, and it runs a new Lighthouse audit of that page covering performance, accessibility, best practices and SEO. Your client reads the results and explains them to you. The server itself doesn't use a language model.

Uses Lighthouse via Google PageSpeed Insights. Independently developed by Reinhard Zach; not affiliated with Google or OpenAI.

## Connect

Add this endpoint as a remote MCP server in your client and choose no authentication:

```text
https://audit.mrza.ch/mcp
```

The server uses Streamable HTTP. In ChatGPT, you can add custom MCP servers in developer mode if your plan includes it. The server isn't listed in any directory.

You don't need an account, a Google login or an API key for this service. Your client may still ask you to sign in, or to approve the connection and each tool call.

Things to try:

- “Run a Lighthouse audit of https://mrza.ch on mobile.”
- “Which performance, accessibility, or SEO issues should I investigate first?”
- “I deployed a change. Run a fresh audit of https://mrza.ch and compare it with the previous result in this conversation.”

## The tool

There is one tool, `run_lighthouse`, with two arguments:

| Argument | Type                    | Notes                                                        |
| -------- | ----------------------- | ------------------------------------------------------------ |
| `url`    | string                  | A public `http://` or `https://` URL, up to 2,048 characters |
| `device` | `"mobile" \| "desktop"` | Optional, defaults to `mobile`                               |

Each call sends one request to PageSpeed Insights and audits one page on one device. Nothing is cached or stored, so every call is a new audit. Most audits take around 10 seconds. Clients like ChatGPT stop waiting after about a minute, so the server gives up after 57 seconds and returns `AUDIT_TIMEOUT`. Very heavy pages that take Google longer than that can't be audited.

The result is a single JSON object (`schemaVersion` `"1.0"`), sent both as structured content and as text. It contains:

- the four category scores, from 0 to 100
- lab metrics: LCP, FCP, CLS, TBT and Speed Index
- up to 20 findings, most important first, each with a few examples from the page
- manual checks, audit errors, counts and warnings

If the audit fails, you get an error code instead, such as `INVALID_URL`, `UNSUPPORTED_TARGET`, `CAPACITY_EXCEEDED` or `PAGE_LOAD_FAILED`, with a short message and a `retryable` flag. Results are capped at 32 KiB. If a list or its details had to be shortened, `truncated` is `true`.

## Limitations

It only audits public HTTP(S) pages. Requests for local or private-network addresses, IP addresses, non-default ports, URLs with a username or password, and URLs whose query string looks like it holds a secret are refused. That last check only catches obvious cases, so don't send URLs that contain anything confidential.

It audits one page per call. It can't crawl a site, run on a schedule or keep a history. To compare two runs, ask your client to compare results that are already in the conversation.

The numbers are lab data from a single emulated page load, not real-user Core Web Vitals, and scores vary a little from run to run. Automated accessibility checks find only some of the problems a full review would, and a good SEO score doesn't mean good rankings.

Page titles, descriptions, URLs and snippets in the results come from the audited page and from Google. Treat them as untrusted input.

Capacity is limited and shared. The service runs on free tiers. Google allows this project 25,000 PageSpeed Insights requests a day and 30 a minute, for all users together, and the daily quota resets at midnight Pacific Time. There are no accounts or per-user limits, so one heavy user can use up the quota for everyone. When that happens, audits fail with `CAPACITY_EXCEEDED` until the minute is over or the daily quota resets. Don't retry automatically. Audits may also be switched off at any time to protect the quota.

The [privacy page](https://audit.mrza.ch/privacy) explains what happens to the URLs you submit.

## Development

You need Node.js 22.18 or later and pnpm 11. The exact pnpm version is pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm dev          # wrangler dev on http://localhost:8787
pnpm typecheck    # tsc in strict mode
pnpm test         # Vitest in workerd and Node; never calls Google
pnpm build        # wrangler deploy --dry-run --outdir dist
pnpm post-deploy  # checks a deployed endpoint without calling Google (see DEPLOYMENT.md)
pnpm smoke        # live checks against Google; needs SMOKE_LIVE=1 and a real key
pnpm run deploy   # manual production deploy, owner only (see DEPLOYMENT.md)
```

To run real audits locally, copy `.dev.vars.example` to `.dev.vars` (it's gitignored) and add a PageSpeed Insights API key. Without a key, the server still starts and answers `initialize` and `tools/list`, but tool calls return `SERVICE_UNAVAILABLE`.

[SPEC.md](SPEC.md) is the specification the code follows, and [AGENTS.md](AGENTS.md) has the rules for contributors.

### Layout

```text
src/index.ts        HTTP routing, Host/Origin checks, body limit, headers, health
src/mcp.ts          MCP server setup, tool registration, audit flow
src/pagespeed.ts    The PageSpeed Insights request: limits, timeout, cancellation, errors
src/normalize.ts    Turns the Lighthouse report into the tool result (pure functions)
src/validation.ts   Target URL and environment checks
src/schemas.ts      Zod input and output schemas, and the types derived from them
src/errors.ts       Public error messages
src/limits.ts       All limits and defaults (SPEC.md Appendix A)
src/branding.ts     Display copy and canonical URLs
public/             Landing, privacy and 404 pages
tests/              Vitest suites and synthetic fixtures
scripts/            Live smoke checks and post-deploy checks
```

### Dependencies

| Package                           | Version | Notes                                                                                                        |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `agents`                          | 0.24.0  | Provides `createMcpHandler`. Pins its MCP packages to exact versions, so update them together.               |
| `@modelcontextprotocol/server`    | 2.0.0   | The version `agents` 0.24.0 requires (SDK v2). Serves protocol 2026-07-28 and still works with 2025 clients. |
| `@modelcontextprotocol/client`    | 2.0.0   | The version `agents` 0.24.0 requires. Used as a real MCP client in tests.                                    |
| `@modelcontextprotocol/sdk`       | 1.30.0  | Required by `agents` and installed automatically. This project never imports it.                             |
| `zod`                             | 4.6.5   | Input and output schemas. The MCP SDK turns them into JSON Schema.                                           |
| `wrangler`                        | 4.145.0 | Build and deploy.                                                                                            |
| `@cloudflare/vitest-pool-workers` | 0.22.0  | Needs Vitest 4. Its bundled workerd doesn't know `observability.redact_query_string` and warns about it.     |
| `vitest`                          | 4.1.11  | The Workers pool doesn't support Vitest 5 yet.                                                               |
| `typescript`                      | 7.0.2   | Type checking only.                                                                                          |

A few more things worth knowing:

- `compatibility_date` is `2026-08-15`, the newest date both installed workerd builds support, so tests and production run with the same date.
- `nodejs_compat` is on because the Agents MCP handler imports `node:async_hooks`.
- The tool declares anonymous access in `_meta.securitySchemes: [{ "type": "noauth" }]`, the field OpenAI documents for this. The MCP SDK doesn't output a top-level `securitySchemes` field in `tools/list`.

## License

[MIT](LICENSE) © 2026 Reinhard Zach. The license covers this code. It doesn't grant any rights to the Lighthouse or Google names, or to the PageSpeed Insights API, which has its own terms.
