# Disney Fleet — live AIS backend

Two pieces feed live ship positions to the home dashboard:

- **`worker.js`** — a Cloudflare Worker. Serves `GET /ships` (the dashboard polls it)
  and accepts `POST /ingest` (the collector pushes to it). Stores latest positions in KV.
- **`collector.js`** — a Node script for your always-on PC. Subscribes to aisstream.io's
  free real-time AIS feed, filtered to the eight Disney MMSIs, and batches positions to the Worker.

```
aisstream.io  ──ws──▶  collector.js (home PC)  ──POST /ingest──▶  Worker ──▶ KV
                                                                     ▲
                                              dashboard  ──GET /ships─┘
```

## 1. Deploy the Worker

```bash
npx wrangler kv namespace create POSITIONS      # copy the printed id into wrangler.toml
npx wrangler secret put INGEST_SECRET           # pick any long random string; reuse it below
npx wrangler deploy                             # note the printed URL, e.g. https://disney-ais.<you>.workers.dev
```

Check it: `curl https://disney-ais.<you>.workers.dev/ships` → `{}` (empty until the collector runs).

## 2. Run the collector

Get a free key at https://aisstream.io (sign in → API keys), then:

```bash
npm install
AISSTREAM_KEY=your_aisstream_key \
WORKER_URL=https://disney-ais.<you>.workers.dev/ingest \
INGEST_SECRET=the_same_secret_from_step_1 \
node collector.js
```

You'll see `pos Disney Fantasy 26.5 -79.1` lines as reports arrive, and a `flushed N ship(s)`
line every 2 minutes. Keep it alive in tmux, or use pm2 (`pm2 start collector.js`) or a
systemd unit so it restarts on reboot.

Optional: `FLUSH_MS=120000` controls how often it writes (default 120s). Workers KV free tier
is ~1000 writes/day, so 120s (720/day) is safe — don't go below ~90s on the free plan.

## 3. Point the dashboard at it

In `disney-fleet-dashboard.html`, set near the top of the script:

```js
const POSITIONS_URL = "https://disney-ais.<you>.workers.dev/ships";
```

Reload. Ship dots flip from gold (approx) to green (live AIS) and update every 60s.

## Notes

- A ship only appears once aisstream hears it — mid-ocean ships can be sparse, ships near
  shore/port report constantly. Last-known position persists in KV between reports.
- `/ships` is public (AIS is public data). `/ingest` is protected by `INGEST_SECRET`.
- Fleet MMSIs are hard-coded in both `collector.js` and the dashboard; update both if the
  fleet changes (Believe arrives 2027).
