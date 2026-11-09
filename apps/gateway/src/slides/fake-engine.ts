/** Test helper: a fake Sibyl Slides engine behind a fetch function. */
import { createSlidesClient, type SlidesClient } from "./client.js";

export interface FakeEngine {
  fetch: typeof fetch;
  client: SlidesClient;
  calls: Array<{ url: string; method: string; body?: unknown; auth?: string | null }>;
  /** Make the next generate call fail with this status. */
  failNext?: number;
  /** Actual cost the engine reports for each generation (usage accounting). */
  costUsd?: number;
  /** What GET /api/v1/sibyl/config answers (404 when unset, like an older engine). */
  config?: { model: string; pricing: { prompt: number; completion: number } | null };
}

export function createFakeEngine(options: { token?: string; baseUrl?: string } = {}): FakeEngine {
  const baseUrl = options.baseUrl ?? "http://engine.test";
  let counter = 0;
  const engine: FakeEngine = {
    calls: [],
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const auth = new Headers(init?.headers).get("authorization");
      engine.calls.push({ url: url.pathname + url.search, method, ...(body ? { body } : {}), auth });
      if (engine.failNext) {
        const status = engine.failNext;
        engine.failNext = undefined;
        return new Response(JSON.stringify({ detail: "engine broke" }), { status });
      }
      if (method === "POST" && url.pathname === "/api/v1/ppt/presentation/generate") {
        counter += 1;
        const id = `pres-${counter}`;
        return Response.json({
          presentation_id: id,
          path: `/app_data/${id}/Deck.pptx`,
          edit_path: `/presentation?id=${id}`,
          ...(engine.costUsd !== undefined ? { cost_usd: engine.costUsd, estimated: false } : {})
        });
      }
      const exportMatch = /^\/api\/v1\/ppt\/presentation\/([^/]+)\/export$/.exec(url.pathname);
      if (method === "POST" && exportMatch) {
        return Response.json({ path: `/app_data/${exportMatch[1]}/Deck.${(body as { export_as: string }).export_as}` });
      }
      const thumbMatch = /^\/api\/v1\/ppt\/presentation\/([^/]+)\/thumbnail$/.exec(url.pathname);
      if (method === "GET" && thumbMatch) {
        return new Response(`PNG ${thumbMatch[1]}`, { headers: { "content-type": "image/png" } });
      }
      const getMatch = /^\/api\/v1\/ppt\/presentation\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && getMatch) {
        return Response.json({ id: getMatch[1], title: "Deck", slides: [{}, {}, {}] });
      }
      if (url.pathname === "/api/v1/sibyl/config") {
        if (!engine.config) return new Response("not found", { status: 404 });
        return Response.json(engine.config);
      }
      if (url.pathname === "/api/v1/ppt/template/all") {
        return Response.json({ items: [{ id: "general", name: "General" }, { id: "modern", name: "Modern", description: "Clean" }], total: 2 });
      }
      if (url.pathname.startsWith("/app_data/")) {
        return new Response(`FILE ${url.pathname}`, { headers: { "content-type": url.pathname.endsWith(".pdf") ? "application/pdf" : "application/octet-stream" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    client: undefined as unknown as SlidesClient
  };
  engine.client = createSlidesClient({ baseUrl, fetch: engine.fetch, ...(options.token ? { token: options.token } : {}) });
  return engine;
}
