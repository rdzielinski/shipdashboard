/**
 * Disney AIS collector
 * --------------------------------------------------------------
 * Subscribes to aisstream.io (free real-time AIS over WebSocket), filtered to the
 * eight Disney Cruise Line MMSIs, keeps the latest position per ship in memory, and
 * POSTs a batched snapshot to your Worker's /ingest endpoint on an interval.
 *
 * Run on your always-on PC:
 *   AISSTREAM_KEY=xxxx WORKER_URL=https://disney-ais.<you>.workers.dev/ingest \
 *   INGEST_SECRET=yyyy node collector.js
 *
 * Batching matters: Workers KV free tier allows ~1000 writes/day, so the default
 * 120s flush (= 720 writes/day) stays comfortably under it. Lower FLUSH_MS only if
 * you know your write budget.
 */
import WebSocket from "ws";

const KEY = process.env.AISSTREAM_KEY;
const INGEST_URL = process.env.WORKER_URL;          // .../ingest
const SECRET = process.env.INGEST_SECRET;
const FLUSH_MS = Number(process.env.FLUSH_MS || 120000);

// Verified Disney Cruise Line fleet MMSIs (2026)
const FLEET = {
  "308516000": "Disney Magic",
  "308457000": "Disney Wonder",
  "311042900": "Disney Dream",
  "311058700": "Disney Fantasy",
  "311001098": "Disney Wish",
  "311001221": "Disney Treasure",
  "311001540": "Disney Destiny",
  "311000934": "Disney Adventure",
};
const MMSIS = Object.keys(FLEET);

if (!KEY || !INGEST_URL || !SECRET) {
  console.error("Missing env. Set AISSTREAM_KEY, WORKER_URL, INGEST_SECRET.");
  process.exit(1);
}

let latest = {};
let ws = null;
let backoff = 1000;

function connect() {
  ws = new WebSocket("wss://stream.aisstream.io/v0/stream");

  ws.on("open", () => {
    backoff = 1000;
    ws.send(
      JSON.stringify({
        APIKey: KEY,
        BoundingBoxes: [[[-90, -180], [90, 180]]], // worldwide; MMSI filter does the narrowing
        FiltersShipMMSI: MMSIS,
        FilterMessageTypes: ["PositionReport"],
      })
    );
    console.log(new Date().toISOString(), "connected; watching", MMSIS.length, "ships");
  });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }
    if (msg.MessageType !== "PositionReport") return;

    const md = msg.MetaData || {};
    const pr = (msg.Message && msg.Message.PositionReport) || {};
    const mmsi = String(md.MMSI ?? pr.UserID ?? "");
    if (!FLEET[mmsi]) return;

    const lat = typeof pr.Latitude === "number" ? pr.Latitude : md.latitude;
    const lon = typeof pr.Longitude === "number" ? pr.Longitude : md.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return;

    const hdg = pr.TrueHeading;
    latest[mmsi] = {
      lat: +lat.toFixed(5),
      lon: +lon.toFixed(5),
      cog: pr.Cog != null ? +(+pr.Cog).toFixed(1) : null,
      sog: pr.Sog != null ? +(+pr.Sog).toFixed(1) : null,
      heading: hdg != null && hdg !== 511 ? hdg : null,
      name: md.ShipName ? String(md.ShipName).trim() : FLEET[mmsi],
      ts: md.time_utc || new Date().toISOString(),
    };
    console.log("  pos", FLEET[mmsi].padEnd(17), latest[mmsi].lat, latest[mmsi].lon);
  });

  ws.on("close", () => { console.warn("socket closed; reconnecting in", backoff, "ms"); scheduleReconnect(); });
  ws.on("error", (e) => { console.warn("socket error:", e.message); try { ws.close(); } catch {} });
}

function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

async function flush() {
  const keys = Object.keys(latest);
  if (!keys.length) return;
  const snapshot = latest;
  latest = {}; // new reports accumulate while we POST
  try {
    const r = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(snapshot),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    console.log(new Date().toISOString(), "flushed", keys.length, "ship(s) to Worker");
  } catch (e) {
    console.warn("flush failed:", e.message, "- retrying next interval");
    latest = Object.assign(snapshot, latest); // restore, newer reports win
  }
}

connect();
setInterval(flush, FLUSH_MS);
process.on("SIGINT", () => { console.log("\nstopping"); process.exit(0); });
