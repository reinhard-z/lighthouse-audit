# Deployment

Owner runbook for Lighthouse Audit at `https://audit.mrza.ch`. Everything in this repository is public: do not add keys, account IDs, tokens or private contacts here. Records you prefer not to publish (exact quota caps, the accepted-risk note) can live outside the repository; if so, write here where they are kept.

## Overview

| Environment | Worker             | Hostname        | Deployed by                                   | PSI key                     |
| ----------- | ------------------ | --------------- | --------------------------------------------- | --------------------------- |
| Local       | `wrangler dev`     | `localhost`     | developer                                     | `.dev.vars`, optional       |
| Production  | `lighthouse-audit` | `audit.mrza.ch` | GitHub Actions, manual dispatch with approval | Worker secret `PSI_API_KEY` |

There is deliberately no staging environment (SPEC.md §11). The first production release ships with `AUDITS_ENABLED=false`.

## One-time setup (owner)

### Google PageSpeed Insights

1. Create a dedicated Google Cloud project and enable the PageSpeed Insights API.
2. Create an API key restricted to the PageSpeed Insights API.
3. Check the actual PSI quotas for the project, set conservative caps where adjustable, and keep automatic quota increases disabled. Keep the project without a billing account, so the quota is a hard ceiling and PSI usage costs nothing.
4. Record the quota units, limits and reset behavior. Recorded 2026-10-01 from the project's **Quotas & System Limits** page:

   | Quota              | Unit                     | Limit  | Reset                        | Cap set                      |
   | ------------------ | ------------------------ | ------ | ---------------------------- | ---------------------------- |
   | Queries per day    | PSI requests per project | 25,000 | Daily, midnight Pacific Time | 25,000 (the maximum allowed) |
   | Queries per minute | PSI requests per project | 30     | Per minute                   | 30 (the maximum allowed)     |

   Each tool call makes exactly one PSI request, so these are also the service-wide limits on audits. Both quotas are shared by all callers. Lower caps would not reduce cost (there is none without billing); they would only exhaust the service sooner, so the maximum is kept.

5. Record the acceptance of the anonymous-quota risk (SPEC.md §9): one caller can exhaust the day's quota, after which audits fail with `CAPACITY_EXCEEDED` for everyone until the reset. Mitigations are the kill switch and, optionally later, a rate-limiting binding.

   **Accepted by the owner on 2026-10-01** as a limitation of the free, anonymous design and of the PSI quota. Bursts above 30 audits per minute also fail with `CAPACITY_EXCEEDED` until the minute passes.

### Cloudflare

1. Create an API token from the **Edit Cloudflare Workers** template, restricted to your account and the `mrza.ch` zone. Confirm on the first deploy that it can update the Worker and its Custom Domain. Note that such a token can change any Worker in the account.
2. Check zone security and cache rules: `/mcp` must not get Cloudflare Access, a CAPTCHA or an interactive challenge, and no cache rule may override `Cache-Control: no-store` on `/mcp`.
3. After the first deploy has created the Worker, set the key once:

   ```sh
   pnpm exec wrangler secret put PSI_API_KEY
   ```

   Deploys keep existing secrets. The key never goes to GitHub.

The Custom Domain route in `wrangler.jsonc` creates the DNS record and certificate for `audit.mrza.ch` only. The apex, `www`, email records and other Workers are not touched.

### GitHub

- Create the repository (public) and push `main`.
- Create the environment `production`: you as required reviewer, “Prevent self-review” off, deployment branches limited to `main`.
- Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as **environment** secrets on `production`, not as repository secrets.
- Protect `main`: pull request required, CI required to pass, no force pushes.
- Keep the default of requiring approval before workflows run for first-time outside contributors.
- Set the default `GITHUB_TOKEN` permissions to read-only.
- Enable Dependabot version updates and alerts. `.github/dependabot.yml` covers GitHub Actions and npm; `agents`, `@modelcontextprotocol/*` and `zod` are grouped because `agents` exact-pins its MCP peers.
- Protect your GitHub account with a passkey or hardware-key 2FA. The approval gate prevents unreviewed releases but not someone who controls `main` or your account.

## Before the first release: local live checks

These calls use your PSI quota. CI never runs them.

```sh
cp .dev.vars.example .dev.vars          # add your key; keep AUDITS_ENABLED=true locally
SMOKE_LIVE=1 pnpm smoke provider --save # one direct PSI call: fields mask, header auth, size
pnpm dev                                # in a second terminal
SMOKE_LIVE=1 pnpm smoke endpoint        # mobile, second mobile, desktop audit of https://mrza.ch
```

The post-deploy checks expect audits to be disabled, as committed in `wrangler.jsonc`, but `.dev.vars` enables them locally. Run them against a dev server with audits switched off (`--var` overrides `.dev.vars`); otherwise the last check fails with `INVALID_URL`:

```sh
pnpm dev --var AUDITS_ENABLED:false     # instead of plain pnpm dev
node scripts/post-deploy.ts --base-url http://localhost:8787
```

`--save` writes the raw provider body to `smoke-output/` (gitignored). Sanitize it and label it as sanitized before committing any part of it as a fixture. Record:

| Item | Result |
| ---- | ------ |
| `fields` mask accepted (`src/pagespeed.ts` `PSI_FIELDS`) | Yes (2026-10-01): status 200, all requested fields returned; 4 categories, 153 audits, Lighthouse 13.5.0 |
| Projected response size | 409,212 bytes for one mobile audit (2026-10-01), about 10% of the 4 MiB cap |
| `x-goog-api-key` header accepted | Yes (2026-10-01); no query-parameter fallback needed |
| Typical audit duration (mobile / desktop) | Through the local endpoint (2026-10-01): mobile 10.5 s and 8.3 s, desktop 10.4 s; direct PSI call 9.7 s (mobile). Serialized tool results about 12 KB of the 32 KiB cap |
| Provider error forms seen, with sanitized fixtures | _to be recorded_ |

If PSI rejects the header, stop and decide on the documented `key` query-parameter fallback (SPEC.md §6) before releasing.

## Releasing

1. Merge to `main` through a pull request; CI must pass.
2. In GitHub Actions, run **Deploy production** on `main` (workflow_dispatch). Runs from other refs fail immediately.
3. The **build** job installs, typechecks, tests and dry-run builds, then uploads `dist/`, `public/` and `wrangler.jsonc` as an artifact.
4. Approve the **deploy** job when the `production` environment asks. It installs only Wrangler (install scripts disabled) and deploys the prebuilt bundle with `wrangler deploy dist/index.js --no-bundle --var RELEASE:<commit SHA>`. Confirm on the first run that this path also deploys the static assets and the custom-domain route.
5. The **verify** job runs `node scripts/post-deploy.ts` against `https://audit.mrza.ch` without the Cloudflare token and without calling Google. It checks `/healthz` and the release, the landing page, a 404, MCP `initialize` and `tools/list` (exactly one tool), a 403 for a foreign `Origin` and, while audits are disabled, the disabled error from a tool call. A failed check fails the run; then decide between rollback and fix-forward.

Out-of-band: if the pipeline is broken, `pnpm run deploy` deploys with your own Wrangler login. Record any such deploy here:

| Date | Commit | Reason |
| ---- | ------ | ------ |

## Before enabling audits

1. Make a few real calls and inspect the Workers invocation-log entries in the Cloudflare dashboard. Record which request fields they contain. If they include `Authorization`, `Cookie` or any request body, set `observability.logs.invocation_logs` to `false` in `wrangler.jsonc`. Subrequest tracing stays off in all cases.
2. Get the privacy copy and the support link approved (see the owner-input checklist).
3. Enable audits in a separate, reviewed pull request that changes `"AUDITS_ENABLED": "false"` to `"true"` in `wrangler.jsonc`, then release as above.
4. Repeat the live checks against production: `SMOKE_LIVE=1 pnpm smoke endpoint --base-url https://audit.mrza.ch`. Record the client timeout behavior and the production CPU time per request from the dashboard.

## Kill switch

`AUDITS_ENABLED` in `wrangler.jsonc` is the source of truth. With anything other than `"true"`, discovery, health and the landing page still work, but tool calls return `SERVICE_UNAVAILABLE` without contacting Google.

- **Planned:** change the value to `"false"` in a pull request, merge, and run **Deploy production**.
- **Emergency:** set the `AUDITS_ENABLED` variable to `false` in the Worker's variable settings in the Cloudflare dashboard. This takes effect without a build but is overwritten by the next deploy, so commit the same value to `wrangler.jsonc` before the next release.

Use the kill switch for cost or abuse, not a rollback. There is no key rotation pool, project sharding, paid fallback or retry loop.

## Rollback

For a bad release:

```sh
pnpm exec wrangler deployments list   # recent deployments
pnpm exec wrangler versions list      # available versions
pnpm exec wrangler rollback [<version-id>]
```

A rollback also restores that version's variables. Immediately check `AUDITS_ENABLED` in the dashboard and correct it if needed, then fix forward through `main` and a new dispatch.

## Logging

The Worker logs one JSON line per audit with only these fields: `event`, `release`, `requestId` (random), `device`, `outcome` (error code or `ok`), `durationMs`, `providerStatus`, `responseBytes` and `reason` (a provider reason token or internal tag). It never logs the key, the target URL, the provider URL or query, request bodies, raw Lighthouse output, headers or cookies. Configured observability: Workers logs on, invocation logs on (pending the check above), query strings redacted, traces off.

## Capacity

Measured locally (2026-10-01): Worker bundle 715.10 KiB, 145.60 KiB gzip (`pnpm build`). Production CPU time per request has not been measured; check it against the Workers Free limit (10 ms CPU per invocation) after the first live audits. Do not enable billing or change plans without recording the measurement and deciding explicitly.

## Owner-input checklist

- [ ] Support link or contact for the landing page (`public/index.html`, marked `OWNER-INPUT`)
- [ ] Approval of the privacy copy, including log retention (`public/privacy.html`, marked `OWNER-INPUT`)
- [ ] License
- [x] PSI quotas, caps and the accepted-risk note recorded
- [ ] Live smoke results recorded (table above)
- [ ] Invocation-log fields checked before enabling audits
- [ ] Naming and directory-review checks (see SUBMISSION.md)
