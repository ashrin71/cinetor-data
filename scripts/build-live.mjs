// Builds live.json: snapshot + pinned channels + public playlists, merged by channel name, every link
// checked. Runs daily on GitHub Actions; jsDelivr serves the result to the Cinetor app and gateway.
// Output shape matches the gateway's /api/public/v1/live `channels` (the app reads only that).
import fs from "node:fs";
import { PINNED_CHANNELS } from "./pinned.mjs";

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const PLAYLISTS = [
  { url: "https://raw.githubusercontent.com/abusaeeidx/Mrgify-BDIX-IPTV/main/playlist.m3u", country: "BD" },
  { url: "https://iptv-org.github.io/iptv/categories/sports.m3u", group: "Sports" },
  { url: "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8" },
];

function normalizeGroupName(g = "") {
  if (/bangla|bengali/i.test(g)) return "Bangla";
  if (/sports?|cricket|football/i.test(g)) return "Sports";
  if (/india|hindi|tamil|telugu/i.test(g)) return "Indian";
  if (/news/i.test(g)) return "News";
  if (/movie|cinema/i.test(g)) return "Movies";
  if (/kid|cartoon|anim/i.test(g)) return "Kids";
  if (/music/i.test(g)) return "Music";
  if (/documentary|nature|history/i.test(g)) return "Documentary";
  if (/religio|islam|hindu|christian/i.test(g)) return "Religious";
  if (/entertain|general/i.test(g)) return "Entertainment";
  return g.trim() || "International";
}

function normChannelKey(name) {
  const n = String(name || "").toLowerCase().replace(/\[[^\]]*]|\([^)]*\)/g, " ");
  if (!/[a-z]{2}/.test(n)) return "";
  const short = n.replace(/\b(fhd|uhd|hd|sd|4k|live|tv|channel|ⓢ|ⓖ)\b/g, " ").replace(/[^a-z0-9]+/g, "");
  return short.length >= 4 && /[a-z]/.test(short) ? short : n.replace(/\b(fhd|uhd|hd|sd|4k|live)\b/g, " ").replace(/[^a-z0-9]+/g, "");
}

function parseM3u(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const attr = (k) => line.match(new RegExp(`${k}="([^"]*)"`))?.[1] || "";
      cur = { name: line.slice(line.lastIndexOf(",") + 1).trim(), logo: attr("tvg-logo"), group: attr("group-title").split(";").pop(), headers: {} };
    } else if (line.startsWith("#EXTVLCOPT") && cur) {
      const ref = line.match(/http-referr?er=(.+)$/i)?.[1];
      const ua = line.match(/http-user-agent=(.+)$/i)?.[1];
      if (ref) cur.headers.Referer = ref.trim();
      if (ua) cur.headers["User-Agent"] = ua.trim();
    } else if (!line.startsWith("#") && cur) {
      if (/^https?:\/\//i.test(line) && !/\.mpd(\?|$)/i.test(line) && !/youtu/i.test(line)) out.push({ ...cur, url: line });
      cur = null;
    }
  }
  return out;
}

async function fetchT(url, opts = {}, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- merge
const catalog = [];
const byId = new Map();
const byName = new Map();
const add = (ch) => {
  if (byId.has(ch.id)) return;
  catalog.push(ch);
  byId.set(ch.id, ch);
  const k = normChannelKey(ch.name);
  if (k && !byName.has(k)) byName.set(k, ch);
};
for (const p of PINNED_CHANNELS) add({ ...p, servers: [...p.servers] });
const snap = JSON.parse(fs.readFileSync(new URL("../live-snapshot.json", import.meta.url)));
for (const [id, name, logo, group, country, , , servers] of snap.channels || []) {
  if (!id || !name || !servers?.length) continue;
  const g = normalizeGroupName(group);
  add({
    id, name, logo: logo || "", group: g, country: country || "",
    url: servers[0][0],
    servers: servers.map(([url, q], i) => ({ url, label: `Server ${i + 1}`, quality: q || 0 })),
    popular: /sports|news|movies/i.test(g) || /bangla|star|sony|zee/i.test(name),
  });
}
for (const pl of PLAYLISTS) {
  let text = "";
  try {
    const r = await fetchT(pl.url);
    if (r.ok) text = await r.text();
  } catch {}
  for (const e of parseM3u(text)) {
    const key = normChannelKey(e.name);
    if (!key) continue;
    let ch = byName.get(key);
    if (!ch) {
      const group = pl.group || normalizeGroupName(e.group);
      ch = {
        id: `pl-${key.slice(0, 40)}`,
        name: e.name.replace(/\s*\((\d+|\d+p|[^)]*)\)/g, "").replace(/^\[[^\]]*]\s*/, "").trim(),
        logo: e.logo || "", group,
        country: pl.country === "BD" && /bangla|bdix|\[bd]|sports|news/i.test(`${e.group} ${e.name}`) ? "BD" : "",
        url: e.url, servers: [], popular: /sports/i.test(group),
      };
      add(ch);
    }
    if (ch.servers.some((s) => s.url === e.url)) continue;
    const hdrs = Object.keys(e.headers).length ? e.headers : undefined;
    ch.servers.push({ url: e.url, label: `Server ${ch.servers.length + 1}`, quality: Number(e.name.match(/(\d{3,4})p/)?.[1] || 0), ...(hdrs ? { headers: hdrs } : {}) });
    if (!ch.logo && e.logo) ch.logo = e.logo;
  }
}

// ---------- check (4 KB max per link: some "channels" are endless TS streams)
const state = new Map();
async function check(s) {
  try {
    const r = await fetchT(s.url, { headers: { ...(s.headers || {}), Range: "bytes=0-2047" }, redirect: "follow" }, 12000);
    if (r.status === 404 || r.status === 410) { r.body?.cancel().catch(() => {}); return "dead"; }
    if (!r.ok && r.status !== 206) { r.body?.cancel().catch(() => {}); return null; }
    const type = r.headers.get("content-type") || "";
    let head = "";
    const reader = r.body?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      try {
        while (head.length < 4096) {
          const { value, done } = await reader.read();
          if (done) break;
          head += dec.decode(value, { stream: true });
        }
      } finally { reader.cancel().catch(() => {}); }
    }
    return head.includes("#EXTM3U") || /video|mpegurl|octet|mp2t/i.test(type) ? "ok" : null;
  } catch (e) {
    return /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ERR_INVALID_URL/.test(e?.cause?.code || "") ? "dead" : null;
  }
}
const urls = [...new Map(catalog.flatMap((c) => c.servers).map((s) => [s.url, s])).values()];
let i = 0;
await Promise.all(Array.from({ length: 48 }, async () => {
  while (i < urls.length) {
    const s = urls[i++];
    const st = await check(s);
    if (st) state.set(s.url, st);
  }
}));

// ---------- publish: dead servers dropped, verified first; geo-blocked/slow (unknown) kept
const channels = [];
for (const ch of catalog) {
  const rank = (s) => (state.get(s.url) === "ok" ? 0 : 1);
  const servers = ch.servers.filter((s) => state.get(s.url) !== "dead")
    .sort((a, b) => rank(a) - rank(b) || (b.quality || 0) - (a.quality || 0))
    .map((s, n) => ({ ...s, label: `Server ${n + 1}${s.quality ? ` · ${s.quality}p` : ""}` }));
  if (!servers.length) continue;
  channels.push({ ...ch, url: servers[0].url, servers, verified: state.get(servers[0].url) === "ok" });
}
const dead = [...state.values()].filter((v) => v === "dead").length;
const ok = [...state.values()].filter((v) => v === "ok").length;
fs.writeFileSync(new URL("../live.json", import.meta.url), JSON.stringify({ updatedAt: new Date().toISOString(), count: channels.length, channels }));
fs.writeFileSync(new URL("../live-stats.json", import.meta.url), JSON.stringify({ updatedAt: new Date().toISOString(), channels: channels.length, links: urls.length, ok, dead }, null, 1));
console.log(`channels ${channels.length}, links ${urls.length}, ok ${ok}, dead ${dead}`);
