// VISUAL DEPT. homepage checker — runs with the news collector (every 2 hours, free).
// Every designer homepage and reference site (the default lists plus the ones members added) is opened
// about once a day: is the link alive, and what does the brand say about itself (its own meta description,
// translated to Korean/English). New links added by members are checked on the next run.
// Results are stored per link under a hash of the address, so the shared table never lists anyone's links.
import fs from "node:fs";
import crypto from "node:crypto";

const URL_ = process.env.SUPABASE_URL?.trim().replace(/\/(rest|auth|storage)\/v1\/?.*$/, "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY secrets."); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "Accept-Language": "ko,en;q=0.8", Accept: "text/html,*/*;q=0.8" };
const rest = async (path, opts = {}) => { const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); const t = await r.text(); return t ? JSON.parse(t) : null; };
const upsert = rows => rows.length ? rest("shared_docs?on_conflict=collection,id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) }) : null;
export const norm = u => String(u || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
const key = u => crypto.createHash("sha1").update(norm(u)).digest("hex").slice(0, 16);
const HANGUL = /[가-힣]/;
const decode = s => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
async function tr(text, tl) {
  text = String(text || "").trim(); if (!text) return "";
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text.slice(0, 1200))}`, { headers: { "User-Agent": "Mozilla/5.0" } }); if (r.ok) { const j = await r.json(); const out = (j?.[0] || []).map(x => x?.[0] || "").join("").trim(); if (out) return out; } } catch {}
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return "";
}
async function open(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(/^https?:/i.test(url) ? url : "https://" + url, { headers: UA, redirect: "follow", signal: ctl.signal }); const text = r.ok ? (await r.text()).slice(0, 400000) : ""; return { status: r.status, text }; }
  catch (e) { return { status: 0, text: "" }; } finally { clearTimeout(t); }
}
function about(h) {
  const meta = n => { const m = h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i")) || h.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, "i")); return m ? decode(m[1]).replace(/\s+/g, " ").trim() : ""; };
  const desc = meta("og:description") || meta("description") || meta("twitter:description");
  const title = meta("og:site_name") || decode((h.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim();
  return { desc: desc.slice(0, 320), title: title.slice(0, 120) };
}
async function main() {
  const L = JSON.parse(fs.readFileSync(new URL("./site-list.json", import.meta.url)));
  const want = new Map(); // key -> {url, designer}
  L.designers.forEach(d => d.url && want.set(key(d.url), { url: d.url, designer: true }));
  L.sites.forEach(u => { if (!want.has(key(u))) want.set(key(u), { url: u, designer: false }); });
  const prefs = (await rest("docs?collection=eq.prefs&id=eq.vd&select=data&limit=5000")) || [];
  for (const p of prefs) { const d = p.data || {}; (d.addedDes || []).forEach(x => x && x.url && want.set(key(x.url), { url: x.url, designer: true })); (d.sites || []).forEach(x => x && x.url && !want.has(key(x.url)) && want.set(key(x.url), { url: x.url, designer: false })); }
  const have = new Map(((await rest("shared_docs?collection=eq.sitecheck&select=id,data&limit=5000")) || []).map(r => [r.id, r.data]));
  const now = Date.now(); const todo = [...want.entries()].filter(([k, v]) => { const h = have.get(k); return !h || now - (h.at || 0) > 20 * 3600e3 || (v.designer && !h.desc && now - (h.at || 0) > 6 * 3600e3); });
  const rows = []; let ok = 0, bad = 0;
  let i = 0; await Promise.all(Array.from({ length: 4 }, async () => { while (i < todo.length) { const [k, v] = todo[i++]; const r = await open(v.url);
    const alive = r.status > 0 && r.status < 400 || [401, 403, 429].includes(r.status); alive ? ok++ : bad++;
    const data = { ok: alive, status: r.status, at: Date.now() };
    if (v.designer) { const prev = have.get(k) || {}; const a = r.text ? about(r.text) : { desc: "", title: "" };
      if (a.desc) { data.desc = a.desc; data.title = a.title; if (a.desc !== prev.desc) { const ko = HANGUL.test(a.desc); data.desc_ko = ko ? a.desc : await tr(a.desc, "ko"); data.desc_en = ko ? await tr(a.desc, "en") : a.desc; } else { data.desc_ko = prev.desc_ko; data.desc_en = prev.desc_en; } }
      else if (prev.desc) Object.assign(data, { desc: prev.desc, title: prev.title, desc_ko: prev.desc_ko, desc_en: prev.desc_en }); }
    rows.push({ collection: "sitecheck", id: k, data }); } }));
  for (let j = 0; j < rows.length; j += 100) await upsert(rows.slice(j, j + 100));
  fs.mkdirSync("status", { recursive: true });
  fs.writeFileSync("status/sites.json", JSON.stringify({ at: new Date().toISOString(), links: want.size, checkedNow: rows.length, ok, unreachable: bad, withDescription: rows.filter(r => r.data.desc).length }, null, 1));
  console.log(`homepages: ${rows.length} checked (${ok} ok, ${bad} unreachable) of ${want.size}`);
}
main().catch(e => { console.error(e); process.exit(1); });
