/**
 * URL and configuration validation. Runs in workerd so the WHATWG URL parser
 * is the one production uses.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PSI_TIMEOUT_MS } from "../src/limits";
import { releaseOf, validateAuditConfig, validateTargetUrl } from "../src/validation";

function accepted(input: string): string {
  const result = validateTargetUrl(input);
  if (!result.ok) throw new Error(`expected ${input} to be accepted, got ${result.error.code}`);
  return result.value;
}

function rejectionCode(input: string): string | undefined {
  const result = validateTargetUrl(input);
  return result.ok ? undefined : result.error.code;
}

describe("validateTargetUrl", () => {
  it("accepts public HTTP(S) URLs and returns the WHATWG serialization", () => {
    expect(accepted("https://www.example.com")).toBe("https://www.example.com/");
    expect(accepted("HTTP://WWW.Example.COM/Path")).toBe("http://www.example.com/Path");
    expect(accepted("https://www.example.com:443/")).toBe("https://www.example.com/");
  });

  it("preserves paths, significant query order and fragments", () => {
    expect(accepted("https://shop.example.com/p/1?b=2&a=1&utm_source=x#reviews")).toBe(
      "https://shop.example.com/p/1?b=2&a=1&utm_source=x#reviews",
    );
  });

  it("converts Unicode domains to Punycode", () => {
    expect(accepted("https://bücher.example.com/")).toBe("https://xn--bcher-kva.example.com/");
    expect(accepted("https://münchen.de/")).toBe("https://xn--mnchen-3ya.de/");
  });

  it("allows ambiguous parameter names that are common on public pages", () => {
    for (const name of ["key", "code", "session", "sid"]) {
      expect(accepted(`https://www.example.com/?${name}=abc`)).toContain(`${name}=abc`);
    }
  });

  it("rejects invalid syntax, schemes and lengths as INVALID_URL", () => {
    for (const input of [
      "",
      "example.com",
      "www.example.com/path",
      "not a url",
      "ftp://www.example.com/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      `https://www.example.com/${"a".repeat(2048)}`,
    ]) {
      expect(rejectionCode(input), input).toBe("INVALID_URL");
    }
  });

  it("rejects a URL whose serialization exceeds the limit", () => {
    // 680 characters that each percent-encode to three.
    expect(rejectionCode(`https://www.example.com/${"é".repeat(680)}`)).toBe("INVALID_URL");
  });

  it("rejects credentials and non-default ports", () => {
    for (const input of [
      "https://user:pass@www.example.com/",
      "https://user@www.example.com/",
      "https://www.example.com:8443/",
      "http://www.example.com:443/",
    ]) {
      expect(rejectionCode(input), input).toBe("UNSUPPORTED_TARGET");
    }
  });

  it("rejects localhost, single-label names and private suffixes, with trailing dots", () => {
    for (const input of [
      "http://localhost/",
      "http://LOCALHOST./",
      "http://app.localhost/",
      "http://intranet/",
      "http://printer.local/",
      "http://db.internal./",
      "http://1.0.0.127.in-addr.arpa/",
      "http://router.home.arpa/",
      "http://site.test/",
      "http://site.example/",
      "http://site.invalid/",
      "http://abcdefghijklmnop.onion/",
      "http://box.localdomain/",
      "http://nas.lan/",
      "http://nas.home/",
      "http://wiki.corp/",
      "http://wiki.CORP./",
    ]) {
      expect(rejectionCode(input), input).toBe("UNSUPPORTED_TARGET");
    }
  });

  it("does not block names that merely contain a reserved word", () => {
    expect(accepted("https://localhost-tools.example.com/")).toBe("https://localhost-tools.example.com/");
    expect(accepted("https://test.example.org/")).toBe("https://test.example.org/");
  });

  it("rejects IPv4 and IPv6 literals in every numeric form", () => {
    for (const input of [
      "http://127.0.0.1/",
      "http://127.0.0.1./",
      "http://8.8.8.8/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://0x7f.1/",
      "http://127.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[2001:db8::1]/",
    ]) {
      expect(rejectionCode(input), input).toBe("UNSUPPORTED_TARGET");
    }
  });

  it("rejects obvious secret-bearing query parameters, case-insensitively", () => {
    for (const name of [
      "access_token",
      "ID_TOKEN",
      "refresh_token",
      "token",
      "auth",
      "Authorization",
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
      "X-Amz-Signature",
      "x-amz-credential",
      "x-amz-security-token",
      "X-Goog-Signature",
      "x-goog-credential",
    ]) {
      expect(rejectionCode(`https://www.example.com/?page=1&${name}=v`), name).toBe(
        "UNSUPPORTED_TARGET",
      );
    }
  });

  it("rejects JWT-like query values under any name", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    expect(rejectionCode(`https://www.example.com/?state=${jwt}`)).toBe("UNSUPPORTED_TARGET");
    expect(accepted("https://www.example.com/?q=eyJ-not-a-token")).toContain("q=eyJ-not-a-token");
  });
});

describe("validateAuditConfig", () => {
  const enabled = { AUDITS_ENABLED: "true", PSI_API_KEY: "test-key", PSI_TIMEOUT_MS: "55000" };

  it("accepts an enabled configuration with a key", () => {
    expect(validateAuditConfig(enabled)).toEqual({
      ok: true,
      value: { apiKey: "test-key", timeoutMs: 55000 },
    });
  });

  it("uses the default timeout when the variable is absent", () => {
    const { PSI_TIMEOUT_MS: _omitted, ...withoutTimeout } = enabled;
    const result = validateAuditConfig(withoutTimeout);
    expect(result.ok && result.value.timeoutMs).toBe(DEFAULT_PSI_TIMEOUT_MS);
  });

  it("fails closed when audits are disabled, the key is missing or the timeout is malformed", () => {
    for (const env of [
      { ...enabled, AUDITS_ENABLED: "false" },
      { ...enabled, AUDITS_ENABLED: "TRUE" },
      { ...enabled, AUDITS_ENABLED: undefined },
      { ...enabled, PSI_API_KEY: undefined },
      { ...enabled, PSI_API_KEY: "  " },
      { ...enabled, PSI_TIMEOUT_MS: "soon" },
      { ...enabled, PSI_TIMEOUT_MS: "999999" },
      { ...enabled, PSI_TIMEOUT_MS: "0" },
    ]) {
      const result = validateAuditConfig(env);
      expect(result.ok ? undefined : result.error.code).toBe("SERVICE_UNAVAILABLE");
    }
  });
});

describe("releaseOf", () => {
  it("reports a safe release identifier or 'unreleased'", () => {
    expect(releaseOf({ RELEASE: "0123abcd" })).toBe("0123abcd");
    expect(releaseOf({})).toBe("unreleased");
    expect(releaseOf({ RELEASE: "<script>" })).toBe("unreleased");
  });
});
