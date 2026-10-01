// Types `exports` from "cloudflare:workers" in tests (what `wrangler types` would generate).
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
