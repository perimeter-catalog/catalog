/**
 * Perimeter Catalog — Airtable read-only proxy (Cloudflare Worker)
 * ---------------------------------------------------------------
 * Purpose: keep the Airtable Personal Access Token OFF the public client.
 *   The token lives only as a Worker Secret (env.AIRTABLE_TOKEN).
 *
 * Routes:
 *   GET /v0/{baseId}/{tableId}[/{recordId}]   → Airtable REST proxy (unchanged)
 *   GET /img/{tableId}/{recordId}/{fieldId}/{attachmentId}?s=large|full
 *                                             → STABLE image proxy (NEW)
 *
 * Why /img: Airtable attachment URLs are signed and rotate on every fetch,
 *   so the browser never cache-hits and reloads every thumbnail (ugly
 *   loading shimmer lingers). This route exposes a STABLE URL keyed by the
 *   attachment id; the Worker resolves the current signed URL server-side,
 *   streams the bytes, and serves them with a long immutable Cache-Control.
 *   Browser + Cloudflare edge then cache across sessions. When an image is
 *   replaced in Airtable the attachment id changes → new URL → auto refresh
 *   (no confirmation lag on edits).
 *
 * Deploy:
 *   1) Paste this code into the Worker, click Deploy.
 *   2) Secret AIRTABLE_TOKEN must already exist (unchanged).
 *
 * ── 2026-06-18: added /img image proxy ──
 */

const AIRTABLE_API = "https://api.airtable.com";
const ALLOWED_BASE = "appjzmUh919TATEdP";
const ALLOWED_TABLES = new Set([
  "tblZb6Bxpy1vcovjl", // Main
  "tbl5aqQ4wVa4HrXdN", // Pattern Figures
  "tblt7Y4rElnWHyDp9", // LitTrack (LT)    — read for last-modified stamp
  "tbl5MnlS9rNNnwNUk", // ReferenceUsage (jx) — read for last-modified stamp
  "tblpGYSBD1qzVYe40", // PapersNeeded (PN)   — read for last-modified stamp
]);
const ALLOWED_ORIGINS = new Set([
  "https://perimeter-catalog.github.io",
]);

const IMG_MAX_AGE = 31536000; // 1 year (immutable; key changes when image is replaced)
const LIST_TTL_MS = 60000;    // in-isolate memo TTL for resolving attachment ids

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://perimeter-catalog.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

// In-isolate memo: tableId|fieldId -> { ts, promise<Map recordId -> attachments[]> }
// Collapses a burst of concurrent /img requests into a single Airtable list
// call per table/field, so we never hit the API rate limit on a cold load.
const listMemo = {};

async function getFieldMap(env, tableId, fieldId) {
  const key = tableId + "|" + fieldId;
  const m = listMemo[key];
  if (m && Date.now() - m.ts < LIST_TTL_MS) return m.promise;
  const promise = (async () => {
    const map = new Map();
    let offset = "";
    do {
      let u =
        `${AIRTABLE_API}/v0/${ALLOWED_BASE}/${tableId}` +
        `?returnFieldsByFieldId=true&pageSize=100&fields%5B%5D=${encodeURIComponent(fieldId)}`;
      if (offset) u += `&offset=${encodeURIComponent(offset)}`;
      const r = await fetch(u, {
        headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` },
      });
      if (!r.ok) throw new Error("airtable list " + r.status);
      const d = await r.json();
      for (const rec of d.records) map.set(rec.id, rec.fields[fieldId]);
      offset = d.offset || "";
    } while (offset);
    return map;
  })();
  listMemo[key] = { ts: Date.now(), promise };
  return promise;
}

async function handleImg(request, env, ctx, url, parts) {
  // parts = ["img", tableId, recordId, fieldId, attachmentId]
  const [, tableId, recordId, fieldId, attId] = parts;
  if (!tableId || !recordId || !fieldId || !attId) {
    return new Response("Bad Request", { status: 400 });
  }
  if (!ALLOWED_TABLES.has(tableId)) {
    return new Response("Forbidden", { status: 403 });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let map;
  try {
    map = await getFieldMap(env, tableId, fieldId);
  } catch (e) {
    return new Response("resolve error: " + e.message, { status: 502 });
  }
  const arr = map.get(recordId);
  const att = Array.isArray(arr) ? arr.find((a) => a && a.id === attId) : null;
  if (!att) return new Response("Not Found", { status: 404 });

  const size = url.searchParams.get("s") || "large";
  const src =
    (size !== "full" &&
      att.thumbnails &&
      att.thumbnails[size] &&
      att.thumbnails[size].url) ||
    att.url;
  if (!src) return new Response("No Source", { status: 404 });

  const img = await fetch(src);
  if (!img.ok) return new Response("Upstream " + img.status, { status: 502 });

  const resp = new Response(img.body, {
    status: 200,
    headers: {
      "Content-Type":
        img.headers.get("Content-Type") || att.type || "image/jpeg",
      "Cache-Control": `public, max-age=${IMG_MAX_AGE}, immutable`,
      "Access-Control-Allow-Origin": "*",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // ── NEW: stable image proxy ──
    if (parts[0] === "img") {
      return handleImg(request, env, ctx, url, parts);
    }

    // ── Airtable REST proxy (unchanged) ──
    // Expected path: /v0/{baseId}/{tableId}[/{recordId}]
    if (
      parts[0] !== "v0" ||
      parts[1] !== ALLOWED_BASE ||
      !ALLOWED_TABLES.has(parts[2])
    ) {
      return new Response("Forbidden", { status: 403, headers });
    }

    const target = `${AIRTABLE_API}${url.pathname}${url.search}`;
    const upstream = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` },
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...headers,
        "Content-Type":
          upstream.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  },
};
