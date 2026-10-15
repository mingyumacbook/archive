// ARCHIVE news collector — runs on GitHub Actions every 2 hours (free).
// Reads the shared channel list, finds each site's RSS feed, saves new stories,
// marks "bloomed" issues (same keyword in 3+ outlets this week) and refreshes
// the monthly keyword board. No AI, no paid services.
import crypto from "node:crypto";

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

const decode = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, " ");
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
    return { title: strip(tag(x, "title")), link: decode(link).trim(), date: date ? Date.parse(date) : NaN, desc: strip(tag(x, "description") || tag(x, "summary") || tag(x, "content")).slice(0, 220) };
  }).filter(i => i.title && /^https?:/.test(i.link));
}

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
      fresh.push({ collection: "feed", id: hid(i.link), data: { title: i.title, title_en: i.title, summary: i.desc, url: i.link, source: c.data.name, channel: c.data.name, kind: RUNWAY.test(text) ? "runway" : "news", tags: tagsOf(text), heat: 1, publishedAt: isNaN(i.date) ? "" : new Date(i.date).toISOString(), fetchedAt: isNaN(i.date) ? now : Math.min(now, i.date) } });
    }
    console.log(`${c.data.name}: ${items.length} items`);
  }
  await upsert(chUpdates);
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

  await upsert([{ collection: "meta", id: "updater", data: { lastRun: now, added: fresh.length, status: "ok", everyHours: 2 } }]);

  // keep the newest 600 stories
  const sorted = all.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
  for (const x of sorted.slice(600)) await del("feed", x.id);
  console.log(`added ${fresh.length}, issues ${issueRows.length}`);
}
main().catch(async e => { console.error(e); try { await upsert([{ collection: "meta", id: "updater", data: { lastRun: Date.now(), status: "error: " + String(e.message).slice(0, 120), everyHours: 2 } }]); } catch {} process.exit(1); });
