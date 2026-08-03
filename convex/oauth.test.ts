/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register } from "convex-mcp-gateway/test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";

// The OAuth bridge routes in convex/http.ts are mounted inside
// `if (OIDC_ISSUER)`, read at module scope. This has to be set before
// convex-test's lazy module map first evaluates http.ts, which happens
// on the first t.fetch below, so a top-level stub is early enough.
//
// It lives in its own file rather than in vitest.config.mts because
// setting OIDC_ISSUER globally would change `resolveIdentity` for the
// whole suite: any unrecognized token would then hit the issuer's
// userinfo endpoint over the network. Vitest isolates test files, so
// convex/mcp.test.ts keeps the unset-issuer behaviour it asserts.
vi.stubEnv("OIDC_ISSUER", "https://idp.example.test");
vi.stubEnv("OIDC_CLIENT_ID", "demo-client-id");

const modules = import.meta.glob(["./**/*.ts", "!**/*.test.ts"]);

function newTest() {
  const t = convexTest(schema, modules);
  register(t);
  return t;
}

/**
 * The AS-metadata handler fetches the upstream's openid-configuration.
 * Stubbing global fetch keeps the test hermetic and lets us assert that
 * the gateway rewrites the upstream document rather than proxying it.
 */
const UPSTREAM_CONFIG = {
  issuer: "https://idp.example.test",
  authorization_endpoint: "https://idp.example.test/authorize",
  token_endpoint: "https://idp.example.test/token",
  userinfo_endpoint: "https://idp.example.test/api/oidc/userinfo",
  jwks_uri: "https://idp.example.test/.well-known/jwks.json",
  response_types_supported: ["code"],
};

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("openid-configuration")) {
        return new Response(JSON.stringify(UPSTREAM_CONFIG), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Any other outbound call is a bug in the test, not a scenario.
      throw new Error(`unexpected outbound fetch: ${url}`);
    }),
  );
});

describe("protected resource metadata (RFC 9728)", () => {
  test("is 404 until the deployment is configured", async () => {
    const t = newTest();
    // The route is mounted unconditionally, but the metadata comes from
    // deployment state written by setOAuthConfig. An unconfigured demo
    // says so rather than serving a half-filled document.
    const res = await t.fetch("/.well-known/oauth-protected-resource/mcp", {
      method: "GET",
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not configured");
  });

  test("serves the resource document after configureOAuth", async () => {
    // Scoped to this test and reset in `finally`: the sibling test
    // below asserts the unconfigured path, so a leaked value would make
    // the pair order-dependent. `configureOAuth` reads this at call
    // time, not at module load, so stubbing here is enough.
    vi.stubEnv("MCP_AUTH_SERVER_URL", "https://demo.convex.site");
    try {
      await runConfiguredResourceChecks();
    } finally {
      vi.stubEnv("MCP_AUTH_SERVER_URL", "");
    }
  });

  async function runConfiguredResourceChecks() {
    const t = newTest();
    await t.mutation(internal.mcp.configureOAuth, {});

    const res = await t.fetch("/.well-known/oauth-protected-resource/mcp", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.authorization_servers).toEqual(["https://demo.convex.site"]);
    // Origin only, no path. Some clients bail silently when the
    // resource URL carries a path beyond the origin, which is why
    // convex/mcp.ts defaults resourceUrl to the auth server URL.
    expect(body.resource).toBe("https://demo.convex.site");
  }

  test("configureOAuth refuses to run unconfigured", async () => {
    const t = newTest();
    // Better a loud failure than an OAuth config quietly pointing at
    // an empty string.
    await expect(t.mutation(internal.mcp.configureOAuth, {})).rejects.toThrow(
      /MCP_AUTH_SERVER_URL/,
    );
  });
});

describe("CORS preflight", () => {
  test.each(["/mcp/", "/mcp"])("%s answers a browser preflight", async (path) => {
    const t = newTest();
    // Browser MCP clients preflight before every POST. Both mounts have
    // to answer, since claude.ai strips the trailing slash.
    const res = await t.fetch(path, {
      method: "OPTIONS",
      headers: {
        origin: "https://claude.ai",
        "access-control-request-method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const allowHeaders =
      res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    // Without authorization and mcp-session-id on this list the browser
    // drops the very headers the transport depends on.
    expect(allowHeaders).toContain("authorization");
    expect(allowHeaders).toContain("mcp-session-id");
  });
});

describe("authorization server metadata (bridge mode)", () => {
  test("wraps the upstream document and substitutes our registration endpoint", async () => {
    const t = newTest();
    const res = await t.fetch("/.well-known/oauth-authorization-server", {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The point of bridge mode: the upstream's endpoints are preserved
    // so the client still logs in against the real IdP...
    expect(body.authorization_endpoint).toBe(
      "https://idp.example.test/authorize",
    );
    expect(body.token_endpoint).toBe("https://idp.example.test/token");
    // ...but registration is redirected to this deployment, which is
    // what lets a DCR-only client reach an IdP that has no DCR.
    expect(String(body.registration_endpoint)).toContain("/oauth/register");
    expect(String(body.registration_endpoint)).not.toContain(
      "idp.example.test",
    );
    // `overrides: { issuer }` in http.ts has to keep the upstream's own
    // issuer, or strict id_token.iss validators reject the whole flow.
    expect(body.issuer).toBe("https://idp.example.test");
  });
});

describe("dynamic client registration", () => {
  async function registerClient(redirectUris: string[]) {
    const t = newTest();
    return await t.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: redirectUris,
        client_name: "test client",
      }),
    });
  }

  test("returns the pre-registered upstream client_id for an allowed redirect", async () => {
    const res = await registerClient(["https://claude.ai/api/mcp/callback"]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBe("demo-client-id");
    expect(body.redirect_uris).toEqual([
      "https://claude.ai/api/mcp/callback",
    ]);
  });

  test("localhost redirects are allowed, for local MCP clients", async () => {
    const res = await registerClient(["http://localhost:6274/oauth/callback"]);
    expect(res.status).toBe(201);
  });

  test("an unlisted redirect is refused, closing the open-redirect hole", async () => {
    // This is the security-relevant assertion: without
    // allowedRedirectPatterns, handing out a real client_id to an
    // arbitrary redirect_uri turns the bridge into an open redirector.
    const res = await registerClient(["https://attacker.example/callback"]);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBeUndefined();
    expect(String(body.error)).toBeTruthy();
  });

  test("one bad redirect poisons the whole registration", async () => {
    // Partial acceptance would still hand the attacker's URI a usable
    // client_id, so the mixed case has to fail closed.
    const res = await registerClient([
      "https://claude.ai/api/mcp/callback",
      "https://attacker.example/callback",
    ]);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
