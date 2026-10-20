// VISUAL DEPT. news collector — runs on GitHub Actions every 2 hours (free).
// Reads the shared channel list, finds each site's RSS feed, saves new stories,
// marks "bloomed" issues (same keyword in 3+ outlets this week) and refreshes
// the monthly keyword board. No AI, no paid services.
import crypto from "node:crypto";
import { buildDict } from "./i18n-dict.mjs";

const URL_ = process.env.SUPABASE_URL?.trim().replace(/\/(rest|auth|storage)\/v1\/?.*$/, "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY secrets."); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const UA = { "User-Agent": "Mozilla/5.0 (compatible; ARCHIVE-reader/1.0; +https://github.com)" , Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8" };

async function rest(path, opts = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const list = c => rest(`shared_docs?collection=eq.${c}&select=id,data,updated_at&limit=2000`);
// one row per (collection, id): Postgres refuses an upsert that touches the same row twice (code 21000)
const dedupe = rows => [...new Map(rows.map(r => [`${r.collection}|${r.id}`, r])).values()];
const upsert = rows => (rows = dedupe(rows)).length ? rest("shared_docs?on_conflict=collection,id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))) }) : null;
const del = (c, id) => rest(`shared_docs?collection=eq.${c}&id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });

const decode = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&nbsp;/g, " ");
const strip = s => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (x, name) => { const m = x.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : ""; };

async function get(url, ms = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { headers: UA, redirect: "follow", signal: ctl.signal }); if (!r.ok) return null; return { url: r.url, text: await r.text(), type: r.headers.get("content-type") || "" }; }
  catch { return null; } finally { clearTimeout(t); }
}
const isFeed = t => /<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(t.slice(0, 2000));
async function discover(site) {
  const home = await get(site);
  if (home) {
    if (isFeed(home.text)) return home.url;
    const m = [...home.text.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)].map(x => x[0].match(/href=["']([^"']+)["']/i)?.[1]).filter(Boolean);
    for (const h of m) { const u = new URL(decode(h), home.url).href; const f = await get(u); if (f && isFeed(f.text)) return f.url; }
  }
  for (const p of ["/feed/", "/feed", "/rss", "/rss.xml", "/feed.xml", "/feed/rss", "/rss/all.xml/", "/index.xml"]) {
    const f = await get(new URL(p, site).href); if (f && isFeed(f.text)) return f.url;
  }
  return null;
}
function parse(xml) {
  const items = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(m => m[0]);
  const entries = [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map(m => m[0]);
  return [...items, ...entries].map(x => {
    let link = strip(tag(x, "link")); if (!link) link = (x.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] || "";
    const date = strip(tag(x, "pubDate") || tag(x, "published") || tag(x, "updated") || tag(x, "dc:date"));
    const raw = tag(x, "content:encoded") + tag(x, "description") + tag(x, "content");
    const img = (x.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*>/i) || x.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i) || x.match(/<enclosure[^>]+url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i) || decode(raw).match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || "";
    return { title: strip(tag(x, "title")), link: decode(link).trim(), date: date ? Date.parse(date) : NaN, desc: strip(tag(x, "description") || tag(x, "summary") || tag(x, "content")).slice(0, 420), img: decode(img).trim() };
  }).filter(i => i.title && /^https?:/.test(i.link));
}

// the article's own main picture (og:image), so the banner image always matches the story
async function ogImage(url) {
  const r = await get(url, 12000); if (!r) return "";
  const h = r.text.slice(0, 400000);
  const m = h.match(/<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["'][^>]*content=["']([^"']+)["']/i) || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|og:image:url|twitter:image)["']/i);
  if (!m) return ""; try { const u = new URL(decode(decode(m[1])).trim(), r.url).href; return /^https?:/.test(u) ? u : ""; } catch { return ""; }
}

// translation (free Google Translate web endpoint, no key): English stories get Korean title/summary, Korean stories get English ones
const HANGUL = /[\uac00-\ud7a3]/;
async function tr(text, tl) {
  text = String(text || "").trim(); if (!text) return "";
  for (let i = 0; i < 4; i++) { // retry: the free endpoint sometimes refuses bursts
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text.slice(0, 1800))}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctl.signal });
      if (r.ok) { const j = await r.json(); const out = (j?.[0] || []).map(x => x?.[0] || "").join("").trim(); if (out) { await new Promise(r => setTimeout(r, 150)); return out; } }
    } catch {} finally { clearTimeout(t); }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return "";
}
let trOK = 0, trFail = 0;
async function translateRow(d) {
  const ko = HANGUL.test(d.title || "");
  const tl = ko ? "en" : "ko";
  const [tt, ss] = await Promise.all([tr(d.title, tl), d.summary ? tr(d.summary, tl) : Promise.resolve("")]);
  if (!tt) { trFail++; return false; }
  if (ko) { d.title_ko = d.title; d.summary_ko = d.summary || ""; d.title_en = tt; d.summary_en = ss; }
  else { d.title_en = d.title; d.summary_en = d.summary || ""; d.title_ko = tt; d.summary_ko = ss; }
  d.tr = 1; trOK++; return true;
}

// ---- pictures: every candidate the article publishes (og:image, twitter:image, JSON-LD crops, large <img>),
// measured from the file header, so the app can show a landscape picture on computers and a portrait one on phones.
function imgCandidates(h, base) {
  const out = []; const add = u => { if (!u) return; try { u = new URL(decode(decode(String(u))).trim(), base).href; } catch { return; } if (/^https?:/.test(u) && !/\.svg(\?|$)|logo|icon|avatar|sprite|placeholder|1x1|pixel/i.test(u) && !out.includes(u)) out.push(u); };
  for (const m of h.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/gi)) add(m[1]);
  for (const m of h.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::url)?|twitter:image)["']/gi)) add(m[1]);
  for (const m of h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { const walk = o => { if (!o) return; if (Array.isArray(o)) return o.forEach(walk); if (typeof o === "object") { if (o.image) { const im = o.image; (Array.isArray(im) ? im : [im]).forEach(x => add(typeof x === "string" ? x : x && (x.url || x.contentUrl))); } if (o["@graph"]) walk(o["@graph"]); } }; walk(JSON.parse(m[1])); } catch {} }
  const art = h.search(/<article[\s>]/i); const body = art >= 0 ? h.slice(art, art + 250000) : ""; let k = 0;
  for (const m of body.matchAll(/<img[^>]+(?:srcset|data-srcset)=["']([^"']+)["']/gi)) { if (++k > 4) break; const best = m[1].split(/,\s+/).map(x => x.trim().split(/\s+/)).filter(x => x[0]).sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0))[0]; if (best) add(best[0]); }
  return out.slice(0, 12);
}
async function imgSize(url) { // width/height from the first bytes of the file (JPEG, PNG, GIF, WebP)
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { headers: { ...UA, Range: "bytes=0-131071", Accept: "image/*" }, signal: ctl.signal }); if (!r.ok && r.status !== 206) return null;
    const reader = r.body.getReader(); const parts = []; let n = 0; while (n < 131072) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; } try { ctl.abort(); } catch {}
    const b = Buffer.concat(parts.map(x => Buffer.from(x)));
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.slice(0, 3).toString() === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") { const k = b.slice(12, 16).toString(); if (k === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }; if (k === "VP8L") { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; } if (k === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }; }
    if (b[0] === 0xff && b[1] === 0xd8) { let i = 2; while (i < b.length - 9) { if (b[i] !== 0xff) { i++; continue; } const mk = b[i + 1]; if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) }; i += 2 + b.readUInt16BE(i + 2); } }
  } catch {} finally { clearTimeout(t); }
  return null;
}
async function pictures(url, fallback) {
  const r = await get(url, 12000); const cands = r ? imgCandidates(r.text.slice(0, 900000), r.url) : []; if (fallback && !cands.includes(fallback)) cands.push(fallback);
  const sized = []; for (const u of cands.slice(0, 8)) { const s = await imgSize(u); if (s && s.w >= 360 && s.h >= 300) sized.push({ u, ...s, a: s.w / s.h }); }
  const land = sized.filter(x => x.a >= 1.2).sort((a, b) => b.w * b.h - a.w * a.h)[0] || sized.filter(x => x.a >= 0.95).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const port = sized.filter(x => x.a <= 0.85 && x.h >= 700).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const any = land || sized.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  return { img: any ? any.u : (cands[0] || fallback || ""), imgW: any ? any.w : 0, imgH: any ? any.h : 0, imgV: port ? port.u : "", imgVW: port ? port.w : 0, imgVH: port ? port.h : 0 };
}
const applyPics = (d, p) => { Object.assign(d, p); d.imgSrc = "v2"; };
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch {} } })); }

const KW = {
  "sheer": ["sheer", "organza", "transparent", "see-through", "chiffon", "시스루", "시어"],
  "skirt": ["skirt", "스커트"], "lingerie": ["lingerie", "bra", "slip dress", "corset", "란제리", "슬립"],
  "check": ["check", "plaid", "tartan", "houndstooth", "gingham", "체크"], "tailoring": ["blazer", "tailoring", "suit", "tailored", "테일러링", "블레이저"],
  "leather": ["leather", "suede", "레더", "가죽"], "denim": ["denim", "jeans", "데님"], "knit": ["knit", "cardigan", "니트", "가디건"],
  "purple": ["purple", "lilac", "lavender", "aubergine", "퍼플", "라일락"], "orange": ["orange", "오렌지"], "metallic": ["metallic", "gold", "silver", "sequin", "메탈릭", "골드"],
  "leopard": ["leopard", "animal print", "레오파드"], "boho": ["boho", "bohemian", "보헤미안"], "belt": ["belt", "buckle", "벨트"],
  "creative director": ["creative director", "appointed", "appointment", "steps down", "exits", "departure", "debut", "디렉터", "데뷔"],
  "retail": ["sales", "revenue", "earnings", "profit", "quarter", "store opening", "매출", "실적"], "korea": ["korea", "korean", "seoul", "k-fashion", "musinsa", "한국", "서울", "무신사"],
  "sustainability": ["sustainab", "recycled", "upcycl", "circular", "지속가능"], "accessories": ["bag", "shoe", "sneaker", "heel", "jewel", "백", "슈즈"]
};
const KO = { sheer: "시어", skirt: "스커트", lingerie: "란제리 레이어링", check: "체크", tailoring: "테일러링", leather: "레더", denim: "데님", knit: "니트", purple: "퍼플·라일락", orange: "오렌지", metallic: "메탈릭", leopard: "레오파드", boho: "보호", belt: "벨트", "creative director": "디렉터 이동", retail: "리테일·실적", korea: "국내 시장", sustainability: "지속가능성", accessories: "액세서리" };
const RUNWAY = /runway|collection|fashion show|ready-to-wear|\b(ss|fw|aw)\d{2}\b|spring[ /-]?20\d\d|fall[ /-]?20\d\d|resort 20\d\d|pre-fall|couture|컬렉션|런웨이/i;
const tagsOf = s => { const l = s.toLowerCase(); return Object.entries(KW).filter(([, w]) => w.some(k => l.includes(k))).map(([k]) => k).slice(0, 4); };
const hid = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

async function main() {
  const now = Date.now();
  const channels = (await list("channels")) || [];
  const tracked = channels.filter(c => c.data?.track && !c.data?.paywall && c.data?.url);
  const feedRows = (await list("feed")) || [];
  const known = new Set(feedRows.map(r => r.data?.url));
  const fresh = []; const chUpdates = [];
  for (const c of tracked) {
    let feedUrl = c.data.rss;
    if (!feedUrl) { feedUrl = await discover(c.data.url); if (feedUrl) chUpdates.push({ collection: "channels", id: c.id, data: { ...c.data, rss: feedUrl } }); }
    if (!feedUrl) { console.log(`no feed: ${c.data.name}`); continue; }
    const f = await get(feedUrl); if (!f) { console.log(`feed failed: ${c.data.name}`); continue; }
    const items = parse(f.text).filter(i => isNaN(i.date) || now - i.date < 72 * 3600e3).slice(0, 8);
    for (const i of items) {
      if (known.has(i.link)) continue; known.add(i.link);
      const text = `${i.title} ${i.desc}`;
      fresh.push({ collection: "feed", id: hid(i.link), data: { title: i.title, title_en: i.title, summary: i.desc, img: /^https?:/.test(i.img) ? i.img : "", url: i.link, source: c.data.name, channel: c.data.name, kind: RUNWAY.test(text) ? "runway" : "news", tags: tagsOf(text), heat: 1, publishedAt: isNaN(i.date) ? "" : new Date(i.date).toISOString(), fetchedAt: isNaN(i.date) ? now : Math.min(now, i.date) } });
    }
    console.log(`${c.data.name}: ${items.length} items`);
  }
  await upsert(chUpdates);
  // pictures: the article's own large main picture (og:image) first, the feed's small thumbnail only as a fallback.
  // New stories get one now; older stories (last 14 days) that don't have the article picture yet are filled in, up to 300 per run.
  const needImg = fresh;
  await pool(needImg, 6, async r => { applyPics(r.data, await pictures(r.data.url, r.data.img)); });
  const backfill = feedRows.filter(r => r.data && r.data.kind !== "issue" && r.data.url && r.data.imgSrc !== "v2" && now - (r.data.fetchedAt || 0) < 14 * 864e5).sort((a, b) => (b.data.fetchedAt || 0) - (a.data.fetchedAt || 0)).slice(0, 140);
  const filled = [];
  await pool(backfill, 6, async r => { applyPics(r.data, await pictures(r.data.url, r.data.img)); filled.push({ collection: "feed", id: r.id, data: r.data }); });
  // translations: new stories, plus up to 250 older stories that don't have one yet (failed ones are retried every run)
  await pool(fresh, 2, async r => { await translateRow(r.data); });
  const filledIds = new Set(filled.map(r => r.id));
  const needTr = feedRows.filter(r => r.data && r.data.kind !== "issue" && r.data.title && !r.data.tr).sort((a, b) => (b.data.fetchedAt || 0) - (a.data.fetchedAt || 0)).slice(0, 250);
  await pool(needTr, 2, async r => { if (await translateRow(r.data) && !filledIds.has(r.id)) { filled.push({ collection: "feed", id: r.id, data: r.data }); filledIds.add(r.id); } });
  console.log(`translations: ${trOK} done, ${trFail} failed`);
  try { const fs = await import("node:fs"); fs.mkdirSync("status", { recursive: true }); const rowsAll = [...feedRows.map(r => r.data), ...fresh.map(r => r.data)].filter(d => d && d.kind !== "issue");
    fs.writeFileSync("status/news.json", JSON.stringify({ at: new Date().toISOString(), stories: rowsAll.length, translated: rowsAll.filter(d => d.tr).length, notTranslated: rowsAll.filter(d => !d.tr).map(d => d.title).slice(0, 20), trOK, trFail, pictures: { checked: rowsAll.filter(d => d.imgSrc === "v2").length, landscape: rowsAll.filter(d => d.imgW && d.imgW / d.imgH >= 1.2).length, portrait: rowsAll.filter(d => d.imgV).length } }, null, 1)); } catch {}
  if (filled.length) await upsert(filled);
  console.log(`pictures: ${needImg.filter(r => r.data.img).length}/${needImg.length} new, ${filled.filter(r => r.data.img).length}/${filled.length} older`);
  for (let i = 0; i < fresh.length; i += 200) await upsert(fresh.slice(i, i + 200));

  // bloom detection: same keyword in 3+ outlets within 7 days
  const all = [...feedRows.map(r => ({ id: r.id, ...r.data })), ...fresh.map(r => ({ id: r.id, ...r.data }))].filter(x => x.kind !== "issue");
  const week = all.filter(x => now - (x.fetchedAt || 0) < 7 * 864e5);
  const byTag = {};
  week.forEach(x => (x.tags || []).forEach(t => { (byTag[t] ||= []).push(x); }));
  const issueRows = [], heatRows = [], heatOf = new Map();
  const wk = `${new Date().getUTCFullYear()}-${Math.ceil((new Date().getUTCDate()) / 7)}-${new Date().getUTCMonth() + 1}`;
  for (const [t, xs] of Object.entries(byTag)) {
    const srcs = [...new Set(xs.map(x => x.source))];
    if (srcs.length < 3) continue;
    xs.forEach(x => { const h = Math.max(srcs.length, heatOf.get(x.id) || 0); heatOf.set(x.id, h); if ((x.heat || 1) !== h) heatRows.push({ collection: "feed", id: x.id, data: { ...x, id: undefined, heat: h } }); });
    const top = xs.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))[0];
    issueRows.push({ collection: "feed", id: `issue-${t.replace(/\W+/g, "-")}-${wk}`, data: { title: `${KO[t] || t} — 이번 주 ${srcs.length}개 매체`, title_en: `${t} — ${srcs.length} outlets this week`, summary: srcs.join(" · "), url: top.url, source: "ARCHIVE", channel: "", kind: "issue", tags: [t], heat: srcs.length, publishedAt: "", fetchedAt: now } });
  }
  heatRows.forEach(r => delete r.data.id);
  await upsert([...heatRows, ...issueRows]);

  // monthly keyword board (forecast sections are kept as they are)
  const month = all.filter(x => now - (x.fetchedAt || 0) < 30 * 864e5);
  const mt = {};
  month.forEach(x => (x.tags || []).forEach(t => { const m = (mt[t] ||= { srcs: new Set(), n: 0, links: [] }); m.srcs.add(x.source); m.n++; if (m.links.length < 3) m.links.push(x.url); }));
  const central = Object.entries(mt).filter(([t]) => !["retail", "creative director", "accessories"].includes(t)).map(([t, m]) => ({ en: t.replace(/\b\w/g, c => c.toUpperCase()), ko: KO[t] || t, why: `최근 30일 ${m.srcs.size}개 매체에서 ${m.n}건 언급 (키워드 집계)`, outlets: [...m.srcs].slice(0, 8), links: m.links, heat: m.srcs.size })).sort((a, b) => b.heat - a.heat).slice(0, 6);
  const cur = ((await list("trends")) || []).find(r => r.id === "now")?.data || {};
  if (central.length >= 3) await upsert([{ collection: "trends", id: "now", data: { ...cur, central, month: new Date().toISOString().slice(0, 7), updatedAt: now, source: "keywords" } }]);

  // translations for tags and outlet names shown in the app (English ↔ Korean)
  try { const strs = []; all.forEach(x => { (x.tags || []).forEach(t => strs.push(t)); if (x.source && x.source !== "ARCHIVE") strs.push(x.source); }); await buildDict({ URL_, H, id: "news", strings: strs }); } catch (e) { console.log("i18n news:", e.message); }
  await upsert([{ collection: "meta", id: "updater", data: { lastRun: now, added: fresh.length, status: "ok", everyHours: 2 } }]);

  // keep the newest 600 stories
  const sorted = all.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
  for (const x of sorted.slice(600)) await del("feed", x.id);
  console.log(`added ${fresh.length}, issues ${issueRows.length}`);
}
main().catch(async e => { console.error(e); try { await upsert([{ collection: "meta", id: "updater", data: { lastRun: Date.now(), status: "error: " + String(e.message).slice(0, 120), everyHours: 2 } }]); } catch {} process.exit(1); });
