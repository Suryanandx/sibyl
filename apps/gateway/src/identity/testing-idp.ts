/**
 * A tiny OpenID Connect provider for tests: discovery, JWKS, an authorize
 * endpoint that approves at once (with the claims the test chose), and a
 * token endpoint that checks the client secret and the PKCE verifier and
 * returns an RS256-signed ID token carrying the nonce.
 *
 * Live checks use a real mock IdP in Docker (ghcr.io/navikt/mock-oauth2-server,
 * see docs/hosting.md); this one keeps unit tests self-contained.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface TestIdp {
  issuer: string;
  /** Claims for the next sign-ins (merged over sub / email / email_verified). */
  claims: Record<string, unknown>;
  close(): Promise<void>;
}

export async function startTestIdp(options: { clientId: string; clientSecret: string }): Promise<TestIdp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(6).toString("hex");
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, use: "sig", alg: "RS256" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; claims: Record<string, unknown> }>();
  const idp: TestIdp = { issuer: "", claims: {}, close: async () => undefined };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", idp.issuer);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"]
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        nonce: url.searchParams.get("nonce") ?? "",
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        claims: { ...idp.claims }
      });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const form = new URLSearchParams(raw);
        const basic = Buffer.from(String(request.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString("utf8");
        const [id, secret] = basic.split(":").map((part) => decodeURIComponent(part));
        if (id !== options.clientId || secret !== options.clientSecret) return json(401, { error: "invalid_client" });
        const pending = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!pending || createHash("sha256").update(verifier).digest("base64url") !== pending.challenge || form.get("redirect_uri") !== pending.redirectUri) {
          return json(400, { error: "invalid_grant" });
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = jwt(privateKey, kid, { iss: idp.issuer, aud: options.clientId, iat: now, exp: now + 300, nonce: pending.nonce, sub: "subject-1", ...pending.claims });
        return json(200, { access_token: randomBytes(12).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken });
      });
      return;
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  idp.issuer = `http://127.0.0.1:${address.port}`;
  idp.close = () => new Promise((resolve) => server.close(() => resolve()));
  return idp;
}

function jwt(key: KeyObject, kid: string, payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(payload)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), key).toString("base64url")}`;
}
