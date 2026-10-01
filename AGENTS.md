# AGENTS.md

Lighthouse Audit is an anonymous, stateless remote MCP server on one Cloudflare Worker. It runs Lighthouse audits through the Google PageSpeed Insights (PSI) API and returns bounded, structured results. Production: `https://audit.mrza.ch/mcp`.

## Source of truth

[SPEC.md](SPEC.md) is the binding specification. Read the relevant section before you change anything. If the code and the spec disagree, or the spec is silent on a decision that matters, ask the owner. Do not guess. Change the spec only when the owner asks you to.

| Topic                                         | Spec section |
| --------------------------------------------- | ------------ |
| Scope and out-of-scope list                   | §1           |
| Naming and branding copy                      | §2           |
| Stack, routes, headers                        | §3           |
| Tool input/output contract, field sources     | §4           |
| PSI request, `fields` mask, payload limits    | §6           |
| Normalization, ranking, truncation            | §7           |
| URL validation, Host/Origin, secrets, logging | §8           |
| Kill switch, quotas                           | §9           |
| Error codes and `retryable`                   | §10          |
| Landing page, `wrangler.jsonc`, CI/CD         | §11          |
| File layout                                   | §12          |
| Required tests                                | §13          |
| Build order, completion report                | §14          |
| All limits and defaults                       | Appendix A   |

## Status

V1 is implemented: the Worker, the tool, the static pages, the tests, both workflows and the docs. Production deployment, live smoke checks and enabling audits are owner actions (see DEPLOYMENT.md).

## Commands

Node.js 22.18+ and pnpm 11 (pinned in `package.json`). Dependency install scripts run only for packages allowed in `pnpm-workspace.yaml`.

```sh
pnpm install --frozen-lockfile
pnpm dev          # wrangler dev on localhost:8787 with LOCAL_DEVELOPMENT=true
pnpm typecheck    # tsc --noEmit, strict
pnpm test         # Vitest: "workers" project in workerd, "node" project for repository checks
pnpm build        # wrangler deploy --dry-run --outdir dist
pnpm post-deploy  # node scripts/post-deploy.ts: Google-free endpoint checks (--base-url, --release)
pnpm smoke        # opt-in live checks; refuses to run without SMOKE_LIVE=1 (owner only)
pnpm run deploy   # out-of-band wrangler deploy (owner only)
```

Run `pnpm typecheck && pnpm test && pnpm build` before reporting a code change. Update the snapshot in `tests/__snapshots__/` only when a normalization change is intended, and review the diff.

## Code quality

- Prefer straightforward, readable code with descriptive names, small functions and explicit control flow. Keep each module focused on one responsibility; avoid clever shortcuts, speculative abstractions and unrelated refactors.
- Write brief comments for all but the most basic functions, types and interfaces. Explain purpose, invariants, units and non-obvious decisions rather than narrating the code. Update comments when behavior changes.
- Keep TypeScript strict. Treat untrusted values as `unknown`, validate them at boundaries and narrow types before use. Avoid `any`, unchecked type assertions, non-null assertions and suppression comments that hide unresolved errors.
- Derive types from shared schemas where practical. Reuse existing validation and constants instead of duplicating contracts or introducing magic numbers; keep specified limits in `src/limits.ts`.
- Keep normalization and ranking pure and deterministic. Make I/O and request-specific state explicit; never put mutable request data in module globals.
- Handle expected failures explicitly using the specified error contract. Do not swallow errors, invent success defaults for missing data or expose raw upstream exceptions. Preserve meaningful distinctions such as zero, missing and null.
- Ensure asynchronous work is awaited or explicitly handled. Clean up timers, streams and cancellation listeners on both success and failure, within the spec's timeout and size limits.
- Prefer the existing stack and platform APIs. Add dependencies only for a concrete need, check compatibility and maintainability, and keep dependency changes and the pnpm lockfile consistent.

## Change workflow and verification

- Read the affected code, tests and relevant spec sections before editing. Inspect the working tree and preserve existing user changes; do not reset, overwrite or clean up unrelated work.
- Make the smallest complete change that addresses the task. Follow existing conventions and fix root causes instead of adding special cases that mask a problem.
- Test observable behavior and contract boundaries rather than private implementation details. For behavior changes, cover meaningful success, failure and edge cases; add a regression test for a bug where practical. Keep the required §13 coverage intact.
- Keep tests independent and reproducible. Use labelled synthetic or sanitized fixtures and controlled time where needed; avoid real network dependencies and timing-sensitive sleeps.
- Run the relevant checks for the change using the repository's actual scripts once available. Do not weaken assertions, disable checks or update snapshots blindly to make a failure disappear. Documentation-only edits need a diff and consistency review, not application tests.
- Review the final diff for accidental changes, sensitive data, stale comments and unnecessary complexity. Keep documentation and command examples aligned with the implementation; spec changes still require an owner request.
- Report verification honestly: distinguish passed, failed and unrun checks, and separate measured results from assumptions. Do not commit or push unless requested.

## Hard rules

These are the rules most likely to be broken by accident. The spec has the full list.

- **Scope:** one tool, one provider, one Worker. No accounts, OAuth, database, cache, deduplication, queues, Durable Objects, crawler, scheduling, comparison tool, audit IDs or widget (§1). Do not add any of these unless the owner asks.
- **Naming:** the product is **Lighthouse Audit**, the developer is **Reinhard Zach**, and the identifier is `lighthouse-audit`. Never use "mrza" as a brand. Branding copy lives only in `src/branding.ts`.
- **Domain:** never touch the apex, `www`, email records or other Workers on `mrza.ch`.
- **One fetch, never to the target:** each tool call makes exactly one PSI request with `redirect: "manual"` and fails on any 3xx. Never use `redirect: "error"`, because it throws in workerd. The Worker never fetches the target URL itself. No retries.
- **Secrets:** send `PSI_API_KEY` in the `x-goog-api-key` header, never in the URL. The key lives in Worker secrets or a gitignored `.dev.vars`. It never goes in the repo or GitHub.
- **Logging:** never log the key, target URL, query, upstream URL, request body, raw Lighthouse output, headers or cookies. Keep subrequest tracing off.
- **Tests:** tests never call Google. Worker-facing tests (routing, provider, MCP) run in workerd via `@cloudflare/vitest-pool-workers`.
- **MCP:** use Cloudflare's `createMcpHandler` with the SDK v2 server and a fresh server per request. Do not write JSON-RPC by hand or mix SDK v1 and v2 APIs. Pin the peer versions the Agents release declares.
- **Limits:** keep all limits in `src/limits.ts` and take their values from Appendix A.
- **Public repo:** everything you commit is public. Fixtures must be synthetic or sanitized and labelled as such. Do not commit keys, account IDs or tokens, and do not invent emails, URLs or contacts. Never use `pull_request_target`.

## Owner-only actions

Do not do any of the following yourself:

- dispatch the deploy workflow or run `wrangler deploy`
- create cloud resources, DNS records, GitHub environments or secrets
- choose a license
- submit to a directory
- turn on `AUDITS_ENABLED` in production

You may finish code, workflows, mocked tests, the dry-run build and documentation without asking.

## Reporting

When you finish a piece of work, report it as §14 describes: what you changed, the exact commands you ran, the checks you did not run and the measured numbers. Do not claim "production ready" without evidence.
