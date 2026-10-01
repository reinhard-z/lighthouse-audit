/**
 * Target URL and environment validation (SPEC.md §4, §8, §9).
 *
 * The URL checks are a defensive heuristic, not complete secret or
 * private-network detection: secrets embedded in paths cannot be detected, and
 * Google, not this Worker, resolves and navigates to the target.
 */
import { createAuditError } from "./errors";
import {
  DEFAULT_PSI_TIMEOUT_MS,
  MAX_INPUT_URL_LENGTH,
  MAX_PSI_TIMEOUT_MS,
  MIN_PSI_TIMEOUT_MS,
} from "./limits";
import type { AuditError } from "./schemas";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: AuditError };

/**
 * Host suffixes Google cannot reach: reserved or special-use names, plus
 * common private-network names (`localdomain`, `lan`, `home`, `corp`).
 * `arpa` also covers `home.arpa`.
 */
const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
  "localdomain",
  "lan",
  "home",
  "corp",
] as const;

/** Query parameter names (compared case-insensitively) that usually carry secrets. */
const SECRET_QUERY_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  "access_token",
  "id_token",
  "refresh_token",
  "token",
  "auth",
  "authorization",
  "api_key",
  "apikey",
  "api-key",
  "password",
  "passwd",
  "pwd",
  "secret",
  "client_secret",
  "signature",
  "sig",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
]);

/** Three base64url segments, the first beginning `eyJ` (a JSON header). */
const JWT_LIKE_VALUE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Dotted-quad form the WHATWG parser produces for any IPv4 notation. */
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Validates a caller-supplied target URL. On success returns the WHATWG
 * serialization (lower-case scheme and host, Punycode), which is used both as
 * the provider input and as `requestedUrl`. Paths, query order and fragments
 * are preserved.
 */
export function validateTargetUrl(input: string): Validated<string> {
  const invalidUrl = { ok: false, error: createAuditError("invalidUrl") } as const;
  const unsupported = { ok: false, error: createAuditError("unsupportedTarget") } as const;

  if (input.length === 0 || input.length > MAX_INPUT_URL_LENGTH) return invalidUrl;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalidUrl;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalidUrl;
  if (url.hostname === "") return invalidUrl;

  const serialized = url.href;
  if (serialized.length > MAX_INPUT_URL_LENGTH) return invalidUrl;

  if (url.username !== "" || url.password !== "") return unsupported;
  // The parser normalizes default ports to "", so any value here is non-default.
  if (url.port !== "") return unsupported;
  if (!isSupportedHostname(url.hostname)) return unsupported;
  if (hasSecretBearingQuery(url.searchParams)) return unsupported;

  return { ok: true, value: serialized };
}

/** True when the parsed hostname is a public, multi-label DNS name. */
function isSupportedHostname(hostname: string): boolean {
  // IPv6 literals keep their brackets in `hostname`.
  if (hostname.startsWith("[")) return false;
  const name = hostname.toLowerCase().replace(/\.+$/, "");
  if (name === "" || IPV4_HOST.test(name)) return false;
  if (!name.includes(".")) return false; // single-label names, including "localhost"
  return !BLOCKED_HOST_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** True when any query parameter looks like it carries a credential. */
function hasSecretBearingQuery(searchParams: URLSearchParams): boolean {
  for (const [name, value] of searchParams) {
    if (SECRET_QUERY_PARAMETER_NAMES.has(name.toLowerCase())) return true;
    if (JWT_LIKE_VALUE.test(value)) return true;
  }
  return false;
}

/** Worker bindings this service reads. Values are untrusted until validated. */
export interface WorkerEnv {
  ASSETS?: Fetcher;
  AUDITS_ENABLED?: unknown;
  PSI_API_KEY?: unknown;
  PSI_TIMEOUT_MS?: unknown;
  /** Release identifier (the deployed commit SHA), set at deploy time. */
  RELEASE?: unknown;
  /** Set to "true" only by `pnpm dev`; enables localhost Host/Origin values. */
  LOCAL_DEVELOPMENT?: unknown;
}

/** Validated configuration needed to run an audit. */
export interface AuditConfig {
  apiKey: string;
  timeoutMs: number;
}

/**
 * Validates the kill switch, the key and the timeout. Fails closed: anything
 * other than the exact string "true" leaves audits disabled, and a missing key
 * or malformed timeout makes the service unavailable rather than falling back.
 */
export function validateAuditConfig(env: WorkerEnv): Validated<AuditConfig> {
  const unavailable = { ok: false, error: createAuditError("serviceUnavailable") } as const;
  if (env.AUDITS_ENABLED !== "true") return unavailable;
  if (typeof env.PSI_API_KEY !== "string" || env.PSI_API_KEY.trim() === "") return unavailable;

  const timeoutMs = parseTimeoutMs(env.PSI_TIMEOUT_MS);
  if (timeoutMs === null) return unavailable;
  return { ok: true, value: { apiKey: env.PSI_API_KEY.trim(), timeoutMs } };
}

/** Parses PSI_TIMEOUT_MS; absent means the default, malformed means null. */
function parseTimeoutMs(value: unknown): number | null {
  if (value === undefined) return DEFAULT_PSI_TIMEOUT_MS;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= MIN_PSI_TIMEOUT_MS && parsed <= MAX_PSI_TIMEOUT_MS ? parsed : null;
}

/** Release identifier for health checks and logs. */
export function releaseOf(env: WorkerEnv): string {
  return typeof env.RELEASE === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(env.RELEASE)
    ? env.RELEASE
    : "unreleased";
}

/** True only for `wrangler dev` started through the `dev` package script. */
export function isLocalDevelopment(env: WorkerEnv): boolean {
  return env.LOCAL_DEVELOPMENT === "true";
}
