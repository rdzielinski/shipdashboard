/**
 * Disney AIS relay — Cloudflare Worker
 * --------------------------------------------------------------
 *  GET  /ships    -> latest fleet positions as { "<mmsi>": {lat,lon,cog,sog,heading,ts,name} }
 *  POST /ingest   -> collector pushes a snapshot here (Bearer INGEST_SECRET); merged into KV
 *
 *  Bindings (see wrangler.toml):
 *    env.POSITIONS      KV namespace
 *    env.INGEST_SECRET  secret  (npx wrangler secret put INGEST_SECRET)
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // ---- public read: the dashboard polls this ----
    if (url.pathname === "/ships" && req.method === "GET") {
      const data = (await env.POSITIONS.get("positions")) || "{}";
      return new Response(data, {
        headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    // ---- authenticated write: the collector pushes here ----
    if (url.pathname === "/ingest" && req.method === "POST") {
      const auth = req.headers.get("authorization") || "";
      if (!env.INGEST_SECRET || auth !== `Bearer ${env.INGEST_SECRET}`) {
        return json({ error: "unauthorized" }, 401);
      }
      let incoming;
      try {
        incoming = await req.json();
      } catch {
        return json({ error: "bad json" }, 400);
      }
      if (!incoming || typeof incoming !== "object") return json({ error: "expected object" }, 400);

      // merge over last-known so a partial snapshot never drops a ship
      const existing = JSON.parse((await env.POSITIONS.get("positions")) || "{}");
      const merged = { ...existing, ...incoming };
      await env.POSITIONS.put("positions", JSON.stringify(merged));
      return json({ ok: true, received: Object.keys(incoming).length, total: Object.keys(merged).length });
    }

    if (url.pathname === "/") {
      return new Response("Disney AIS relay is running. Try GET /ships", { headers: CORS });
    }
    return json({ error: "not found" }, 404);
  },
};
