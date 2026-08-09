// Reference server for the Fermentation Lid.
//
// Implements the HTTP contract in docs/api.md and serves the dashboard. No
// dependencies beyond Node itself — storage is plain files under ./data, which
// is plenty for one jar sampled once a minute and easy to inspect by hand.
//
//   node server.mjs                 → http://localhost:8090
//   PORT=9000 node server.mjs
//   ADMIN_KEY=secret node server.mjs
//
// This is a reference implementation for personal use. It has no TLS, no user
// accounts and no rate limiting; run it on your own network.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID, randomBytes, randomInt } from "node:crypto";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRiseCurve, findFeedingArtifacts, validateFeedingBaseline } from "./peak-detection.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
const DASHBOARD = join(HERE, "..", "dashboard");
const LIDS_FILE = join(DATA, "lids.json");
const PORT = Number(process.env.PORT || 8090);
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";

mkdirSync(DATA, { recursive: true });

// --- Storage -----------------------------------------------------------------
// lids.json holds the lids; one JSON-lines file per lid holds its readings.

const loadLids = () => (existsSync(LIDS_FILE) ? JSON.parse(readFileSync(LIDS_FILE, "utf8")) : []);
const saveLids = (lids) => writeFileSync(LIDS_FILE, JSON.stringify(lids, null, 2));
const readingsFile = (lidId) => join(DATA, `${lidId}.jsonl`);

function loadReadings(lidId) {
  const f = readingsFile(lidId);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}

function appendReadings(lidId, rows) {
  appendFileSync(readingsFile(lidId), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
}

// Excluding is rare (only on a feeding), so a full rewrite is fine.
function excludeReadings(lidId, timestamps) {
  const set = new Set(timestamps);
  const rows = loadReadings(lidId).map(r => (set.has(r.ts) ? { ...r, excluded: true } : r));
  writeFileSync(readingsFile(lidId), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
}

const usable = (rows) => rows.filter(r => !r.excluded);

// --- Helpers -----------------------------------------------------------------

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.on("data", c => {
    raw += c;
    if (raw.length > 2_000_000) { reject(new Error("body too large")); req.destroy(); }
  });
  req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid JSON")); } });
  req.on("error", reject);
});

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const lidByToken = (token) => loadLids().find(l => token && l.token === token);

/** A viewer may only read a lid that is paired to its device id. */
const lidForDevice = (req, lidId) => {
  const deviceId = req.headers["x-device-id"];
  const lid = loadLids().find(l => l.id === lidId);
  return lid && lid.appDeviceId && lid.appDeviceId === deviceId ? lid : null;
};

function updateLid(lidId, patch) {
  const lids = loadLids();
  const lid = lids.find(l => l.id === lidId);
  Object.assign(lid, patch);
  saveLids(lids);
  return lid;
}

/** Peak detection over the readings since the last feeding. */
function analyseLid(lid) {
  if (lid.baselineMm == null) return null;
  const sinceTs = lid.lastFedAt ? Math.floor(new Date(lid.lastFedAt).getTime() / 1000)
                                : Math.floor(Date.now() / 1000) - 24 * 3600;
  const samples = usable(loadReadings(lid.id)).filter(r => r.ts >= sinceTs);
  return analyzeRiseCurve(samples, lid.baselineMm, lid.lastFedAt ? sinceTs : null);
}

// --- Static files ------------------------------------------------------------

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
               ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  // normalize + prefix check keeps ../ out of the served tree
  const file = normalize(join(DASHBOARD, rel));
  if (!file.startsWith(normalize(DASHBOARD)) || !existsSync(file)) {
    res.writeHead(404); res.end("Not found"); return;
  }
  res.writeHead(200, { "Content-Type": (MIME[extname(file)] || "application/octet-stream") + "; charset=utf-8" });
  res.end(readFileSync(file));
}

// --- Routes ------------------------------------------------------------------

async function route(req, res, url) {
  const p = url.pathname;

  // Provision a lid → token for the firmware, pair code for the dashboard
  if (req.method === "POST" && p === "/api/admin/lids") {
    if (req.headers["x-admin-key"] !== ADMIN_KEY) return json(res, 401, { error: "Unauthorized" });
    const body = await readBody(req);
    const lids = loadLids();
    const lid = {
      id: randomUUID(),
      token: randomBytes(24).toString("hex"),
      pairCode: randomInt(0, 36 ** 6).toString(36).toUpperCase().padStart(6, "0"),
      name: typeof body.name === "string" ? body.name.slice(0, 100) : null,
      appDeviceId: null, starterId: null,
      baselineMm: null, lastFedAt: null, peakDetectedAt: null,
      firmwareVersion: null, batteryPct: null, lastSeenAt: null,
      createdAt: new Date().toISOString(),
    };
    lids.push(lid);
    saveLids(lids);
    return json(res, 200, { lidId: lid.id, token: lid.token, pairCode: lid.pairCode, name: lid.name });
  }

  // Pair a lid to a viewer device
  if (req.method === "POST" && p === "/api/lid/pair") {
    const { pairCode, deviceId, starterId, name } = await readBody(req);
    if (!pairCode || !deviceId) return json(res, 400, { error: "pairCode and deviceId required" });
    const lids = loadLids();
    const lid = lids.find(l => l.pairCode === String(pairCode).toUpperCase());
    if (!lid) return json(res, 404, { error: "Invalid pair code" });
    lid.appDeviceId = deviceId;
    lid.starterId = starterId || null;
    if (name) lid.name = String(name).slice(0, 100);
    saveLids(lids);
    return json(res, 200, { lidId: lid.id, paired: true });
  }

  // Ingest from the lid. Idempotent on (lid, timestamp) so the firmware can
  // safely re-send its whole buffer after a network outage.
  if (req.method === "POST" && p === "/api/lid/measurements") {
    const lid = lidByToken(req.headers["x-lid-token"]);
    if (!lid) return json(res, 401, { error: "Unauthorized" });
    const body = await readBody(req);
    if (!Array.isArray(body.samples) || !body.samples.length || body.samples.length > 500) {
      return json(res, 400, { error: "samples must be an array of 1-500 readings" });
    }
    const now = Math.floor(Date.now() / 1000);
    const known = new Set(loadReadings(lid.id).map(r => r.ts));
    const fresh = [];
    for (const s of body.samples) {
      const ts = Number.isFinite(s.ts) ? Math.floor(s.ts) : now;
      if (known.has(ts)) continue;
      known.add(ts);
      fresh.push({ ts, distanceMm: Math.round(s.distanceMm), tempC: s.tempC ?? null, excluded: false });
    }
    if (fresh.length) appendReadings(lid.id, fresh.sort((a, b) => a.ts - b.ts));
    updateLid(lid.id, {
      lastSeenAt: new Date().toISOString(),
      firmwareVersion: body.firmwareVersion ?? lid.firmwareVersion,
      batteryPct: body.batteryPct ?? lid.batteryPct,
    });

    // Record the first confirmed peak of this segment, so clients just read it.
    try {
      const current = loadLids().find(l => l.id === lid.id);
      if (current.baselineMm != null && !current.peakDetectedAt) {
        const a = analyseLid(current);
        if (a?.peakReached && a.peakTime) {
          updateLid(lid.id, { peakDetectedAt: new Date(a.peakTime * 1000).toISOString() });
          console.log(`[peak] lid ${lid.id} peaked at ${a.peakHeightMm} mm`);
        }
      }
    } catch (e) { console.error("peak detection:", e.message); }

    return json(res, 200, { accepted: fresh.length, duplicates: body.samples.length - fresh.length });
  }

  const lidMatch = p.match(/^\/api\/lid\/([^/]+)\/(curve|fed|baseline)$/);
  if (lidMatch) {
    const [, lidId, action] = lidMatch;
    const lid = lidForDevice(req, lidId);
    if (!lid) return json(res, 401, { error: "Unauthorized" });

    if (req.method === "GET" && action === "curve") {
      const sinceParam = Number(url.searchParams.get("since"));
      const since = Number.isFinite(sinceParam) && sinceParam > 0
        ? sinceParam : Math.floor(Date.now() / 1000) - 24 * 3600;
      const samples = usable(loadReadings(lidId))
        .filter(r => r.ts >= since)
        .map(r => ({
          ts: r.ts, distanceMm: r.distanceMm, tempC: r.tempC,
          heightMm: lid.baselineMm != null && r.distanceMm >= 0 ? lid.baselineMm - r.distanceMm : null,
        }));
      return json(res, 200, {
        lidId: lid.id, name: lid.name, starterId: lid.starterId,
        baselineMm: lid.baselineMm, lastFedAt: lid.lastFedAt, peakDetectedAt: lid.peakDetectedAt,
        analysis: analyseLid(lid), batteryPct: lid.batteryPct, lastSeenAt: lid.lastSeenAt,
        samples,
      });
    }

    // "Fed now": new baseline, new segment, and clean up this feeding's own mess.
    if (req.method === "POST" && action === "fed") {
      const rows = usable(loadReadings(lidId));
      const valid = rows.filter(r => r.distanceMm >= 0).sort((a, b) => b.ts - a.ts);
      if (!valid.length) return json(res, 400, { error: "no_data", message: "No valid readings yet." });

      const recent = valid.slice(0, 3).map(r => r.distanceMm);
      const baselineMm = median(recent);
      const feedingTs = Math.floor(Date.now() / 1000);

      // The level as it stood 20-30 min ago, i.e. before the jar was touched.
      const pre = valid.filter(r => r.ts <= feedingTs - 20 * 60 && r.ts >= feedingTs - 30 * 60)
                       .map(r => r.distanceMm);
      const verdict = validateFeedingBaseline(recent, baselineMm, pre.length ? median(pre) : null);
      if (!verdict.ok) {
        return json(res, 409, { error: verdict.reason, message: verdict.message, candidateMm: baselineMm });
      }

      const lastFedAt = new Date(feedingTs * 1000).toISOString();
      updateLid(lidId, { baselineMm, lastFedAt, peakDetectedAt: null });

      const artifacts = findFeedingArtifacts(rows, feedingTs, baselineMm);
      if (artifacts.length) excludeReadings(lidId, artifacts);
      return json(res, 200, { baselineMm, lastFedAt, cleaned: artifacts.length });
    }

    if (req.method === "POST" && action === "baseline") {
      const body = await readBody(req);
      let baselineMm = null;
      if (typeof body.baselineMm === "number" && body.baselineMm >= 0 && body.baselineMm <= 4000) {
        baselineMm = Math.round(body.baselineMm);
      } else if (body.mode === "current") {
        const valid = usable(loadReadings(lidId)).filter(r => r.distanceMm >= 0).sort((a, b) => b.ts - a.ts);
        if (!valid.length) return json(res, 400, { error: "No valid readings yet" });
        baselineMm = median(valid.slice(0, 5).map(r => r.distanceMm));
      } else {
        return json(res, 400, { error: "Provide baselineMm or mode: 'current'" });
      }
      updateLid(lidId, { baselineMm });
      return json(res, 200, { baselineMm });
    }
  }

  if (req.method === "GET" && !p.startsWith("/api/")) return serveStatic(res, p);
  return json(res, 404, { error: "Not found" });
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  route(req, res, url).catch(err => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message || "Server error" });
  });
}).listen(PORT, () => {
  console.log(`Fermentation Lid server on http://localhost:${PORT}`);
  if (ADMIN_KEY === "change-me") console.log('Admin key is the default "change-me" — set ADMIN_KEY to change it.');
  const lids = loadLids();
  if (!lids.length) console.log("No lids yet. Run:  node setup.mjs \"Kitchen lid\"");
  else for (const l of lids) {
    console.log(`  ${l.name || "(unnamed)"}  →  http://localhost:${PORT}/?lid=${l.id}&device=${l.appDeviceId || "UNPAIRED"}`);
  }
});
