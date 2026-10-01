/**
 * Static checks of repository files (SPEC.md §13 items 11, 16, 17), run in
 * Node because they read the filesystem: branding consistency, page metadata,
 * production configuration and workflow hardening.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import * as branding from "../src/branding";
import * as limits from "../src/limits";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Minimal HTML entity decoding for the entities used in the pages. */
const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/\s+/g, " ");

const landing = decode(read("public/index.html"));
const privacy = decode(read("public/privacy.html"));
const notFound = decode(read("public/404.html"));

/** Removes JSONC comments and trailing commas (enough for wrangler.jsonc). */
function parseJsonc(text: string): Record<string, unknown> {
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
}

describe("branding and static metadata", () => {
  it("uses the selected copy on the landing page", () => {
    expect(landing).toContain(`<title>${branding.PAGE_TITLE}</title>`);
    expect(landing).toContain(`name="description" content="${branding.META_DESCRIPTION}"`);
    expect(landing).toContain(`<h1>${branding.PRODUCT_NAME}</h1>`);
    expect(landing).toContain(branding.SUBTITLE);
    expect(landing).toContain(branding.PROVIDER_ATTRIBUTION);
    expect(landing).toContain(branding.INDEPENDENCE_NOTICE);
    expect(landing).toContain(branding.MCP_ENDPOINT_URL);
    expect(landing).toContain(`href="${branding.SUPPORT_URL}"`);
    expect(landing).toContain(`rel="canonical" href="${branding.CANONICAL_ORIGIN}/"`);
    expect(landing).toContain(`property="og:url" content="${branding.CANONICAL_ORIGIN}/"`);
    expect(landing).toContain(`property="og:title" content="${branding.PAGE_TITLE}"`);
    expect(landing).toContain('href="/privacy"');
  });

  it("states that all four categories are covered and uses the specified prompts", () => {
    expect(landing).toContain("performance, accessibility, best practices, and SEO");
    for (const prompt of [
      "“Run a Lighthouse audit of https://mrza.ch on mobile.”",
      "“Which performance, accessibility, or SEO issues should I investigate first?”",
      "“I deployed a change. Run a fresh audit of https://mrza.ch and compare it with the previous result in this conversation.”",
    ]) {
      expect(landing).toContain(prompt);
    }
  });

  it("names the product on the privacy page and links canonical URLs", () => {
    expect(privacy).toContain(`<h1>${branding.PRODUCT_NAME} privacy</h1>`);
    expect(privacy).toContain(`rel="canonical" href="${branding.PRIVACY_URL}"`);
    expect(privacy).toContain(`href="${branding.SUPPORT_URL}"`);
    expect(notFound).toContain("Page not found");
  });

  it("keeps pages compatible with the static CSP (no inline scripts or styles)", () => {
    for (const page of ["public/index.html", "public/privacy.html", "public/404.html"]) {
      const html = read(page);
      expect(html, page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html, page).not.toMatch(/<style|\sstyle=/);
      expect(html, page).not.toMatch(/https?:\/\/(?!audit\.mrza\.ch|mrza\.ch)[^"'\s<]*\.(js|css)\b/);
    }
  });

  it("never uses 'mrza' as a brand, old candidate names or another subdomain", () => {
    const files = [
      ...readdirSync(join(root, "public")).map((file) => `public/${file}`),
      ...readdirSync(join(root, "src")).map((file) => `src/${file}`),
      "README.md",
      "DEPLOYMENT.md",
      "SUBMISSION.md",
      "wrangler.jsonc",
      "package.json",
    ];
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/mrza(?!\.ch)/i);
      expect(text, file).not.toMatch(/PageSpeed Audit|Audit powered by Lighthouse/);
      for (const host of text.match(/[a-z0-9-]+\.mrza\.ch/gi) ?? []) {
        expect(host.toLowerCase(), file).toBe(branding.PRODUCTION_HOSTNAME);
      }
    }
  });
});

describe("configuration", () => {
  const packageJson = JSON.parse(read("package.json")) as Record<string, unknown>;
  const wrangler = parseJsonc(read("wrangler.jsonc"));

  it("uses the lighthouse-audit identifier and the production hostname", () => {
    expect(packageJson.name).toBe(branding.PROJECT_IDENTIFIER);
    expect(wrangler.name).toBe(branding.PROJECT_IDENTIFIER);
    expect(wrangler.routes).toEqual([{ pattern: branding.PRODUCTION_HOSTNAME, custom_domain: true }]);
    expect(wrangler.workers_dev).toBe(false);
    expect(wrangler.preview_urls).toBe(false);
  });

  it("ships with audits disabled, tracing off and no secrets or environments", () => {
    expect(wrangler.vars).toEqual({ AUDITS_ENABLED: "false", PSI_TIMEOUT_MS: String(limits.DEFAULT_PSI_TIMEOUT_MS) });
    expect(wrangler.observability).toMatchObject({
      enabled: true,
      logs: { enabled: true, invocation_logs: false },
      traces: { enabled: false },
    });
    expect(wrangler).not.toHaveProperty("env");
    expect(JSON.stringify(wrangler)).not.toMatch(/PSI_API_KEY/);
  });

  it("runs the Worker first only for dynamic paths and serves a real 404", () => {
    expect(wrangler.assets).toEqual({
      directory: "./public",
      binding: "ASSETS",
      html_handling: "auto-trailing-slash",
      not_found_handling: "404-page",
      run_worker_first: ["/mcp", "/mcp/*", "/healthz"],
    });
  });

  it("keeps the Appendix A limits", () => {
    expect(limits).toMatchObject({
      MAX_INPUT_URL_LENGTH: 2048,
      MAX_MCP_REQUEST_BODY_BYTES: 32 * 1024,
      PROVIDER_REQUESTS_PER_INVOCATION: 1,
      DEFAULT_PSI_TIMEOUT_MS: 55_000,
      MAX_PROVIDER_RESPONSE_BYTES: 4 * 1024 * 1024,
      STALE_PROVIDER_TIMESTAMP_MS: 5 * 60 * 1000,
      AUDIT_PASS_THRESHOLD: 0.9,
      MAX_ISSUES_PER_CATEGORY: 5,
      MAX_ISSUES_TOTAL: 20,
      MAX_EVIDENCE_ROWS: 3,
      MAX_MANUAL_CHECKS: 10,
      MAX_AUDIT_ERRORS: 10,
      MAX_RUN_WARNINGS: 5,
      MAX_TEXT_LENGTH: 400,
      REDUCED_DESCRIPTION_LENGTH: 160,
      MAX_URL_FIELD_LENGTH: 2048,
      MAX_TOOL_RESULT_BYTES: 32 * 1024,
    });
  });

  it("keeps local secrets out of the repository", () => {
    const gitignore = read(".gitignore");
    expect(gitignore).toMatch(/^\.dev\.vars$/m);
    expect(read(".dev.vars.example")).toMatch(/^PSI_API_KEY=replace-with-/m);
  });
});

type Step = { name?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { if?: string; environment?: unknown; env?: Record<string, unknown>; needs?: unknown; steps: Step[] };
type Workflow = { on: Record<string, unknown>; permissions: unknown; env?: unknown; concurrency?: unknown; jobs: Record<string, Job> };

function workflow(path: string): Workflow {
  return parse(read(path)) as Workflow;
}

const ci = workflow(".github/workflows/ci.yml");
const deploy = workflow(".github/workflows/deploy.yml");
const allSteps = (wf: Workflow) => Object.values(wf.jobs).flatMap((job) => job.steps);

describe("workflows", () => {
  it("grant only read access and pin every action to a full commit SHA", () => {
    for (const wf of [ci, deploy]) {
      expect(wf.permissions).toEqual({ contents: "read" });
      for (const step of allSteps(wf)) {
        if (step.uses !== undefined) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("never persist checkout credentials", () => {
    const checkouts = [...allSteps(ci), ...allSteps(deploy)].filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) expect(step.with?.["persist-credentials"]).toBe(false);
  });

  it("CI runs on pull requests and main without secrets or pull_request_target", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push"]);
    const withoutComments = read(".github/workflows/ci.yml").replace(/^\s*#.*$/gm, "");
    expect(withoutComments).not.toMatch(/pull_request_target|secrets\./);
  });

  it("deploys only by manual dispatch from main, without overlapping runs", () => {
    expect(Object.keys(deploy.on)).toEqual(["workflow_dispatch"]);
    expect(deploy.concurrency).toEqual({ group: "deploy-production", "cancel-in-progress": false });
    for (const name of ["build", "deploy"]) {
      const guard = deploy.jobs[name]?.steps[0];
      expect(guard?.if).toBe("github.ref != 'refs/heads/main'");
      expect(guard?.run).toContain("exit 1");
    }
    expect(deploy.jobs.deploy?.needs).toBe("build");
    expect(deploy.jobs.deploy?.environment).toBe("production");
    expect(deploy.jobs.verify?.needs).toBe("deploy");
  });

  it("runs dependency install scripts only in the build job", () => {
    for (const [name, job] of Object.entries(deploy.jobs)) {
      const runs = job.steps.map((step) => step.run ?? "").join("\n");
      if (name === "build") {
        expect(runs).toContain("pnpm install --frozen-lockfile");
      } else {
        expect(runs, name).not.toMatch(/pnpm install|npm ci/);
        for (const line of runs.split("\n").filter((l) => /npm install/.test(l))) {
          expect(line, name).toContain("--ignore-scripts");
        }
      }
    }
  });

  it("exposes the Cloudflare credentials only in the deploy step's env", () => {
    const text = read(".github/workflows/deploy.yml");
    expect(text.match(/secrets\.CLOUDFLARE_API_TOKEN/g)).toHaveLength(1);
    expect(text.match(/secrets\.CLOUDFLARE_ACCOUNT_ID/g)).toHaveLength(1);
    expect(deploy.env).toBeUndefined();
    for (const job of Object.values(deploy.jobs)) {
      expect(JSON.stringify(job.env ?? {})).not.toContain("CLOUDFLARE");
    }
    const withToken = allSteps(deploy).filter((step) => JSON.stringify(step).includes("CLOUDFLARE_API_TOKEN"));
    expect(withToken).toHaveLength(1);
    expect(withToken[0]?.name).toBe("Deploy");
    expect(withToken[0]?.env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    });
  });

  it("deploys the prebuilt bundle and verifies without the token or Google", () => {
    const deployStep = deploy.jobs.deploy?.steps.find((step) => step.name === "Deploy");
    expect(deployStep?.run).toContain("deploy dist/index.js --no-bundle");
    const verifyRuns = (deploy.jobs.verify?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(verifyRuns).toContain("node scripts/post-deploy.ts");
    expect(JSON.stringify(deploy.jobs.verify)).not.toContain("secrets.");
  });
});
