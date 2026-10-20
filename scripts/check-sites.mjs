// VISUAL DEPT. homepage checker — runs with the news collector (every 2 hours, free).
// Every designer homepage and reference site (the default lists plus the ones members added) is opened
// about once a day: is the link alive, and what does the brand say about itself (its own meta description,
// translated to Korean/English) and who the director is when the brand says so itself (homepage / about page,
// or Wikidata). New links added or edited by members are checked on the next run.
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
const SUR = "김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉경";
const STOP = /^(브랜드|컬렉션|디자인|디자이너|대표|소개|제품|스토어|매장|문의|회사|팀|스튜디오|공식|온라인|이용|정보|고객|서비스)$/;
function directorFrom(h) {
  const txt = decode(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  // 1) structured data the brand published itself
  for (const m of h.matchAll(/"(?:founder|creator)"\s*:\s*(?:\[\s*)?\{[^{}]*?"name"\s*:\s*"([^"]{3,40})"/gi)) { const n = m[1].trim(); if (/^[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){1,2}$/.test(n) || /^[가-힣]{2,4}$/.test(n)) return { name: n, how: "structured data" }; }
  // 2) an explicit role next to a name, in English or Korean
  const ROLE = "(?:[Cc]reative [Dd]irector|[Aa]rtistic [Dd]irector|[Dd]esigner|[Ff]ounder|CREATIVE DIRECTOR|ARTISTIC DIRECTOR|DESIGNER|FOUNDER)";
  const NAME = "([A-Z][A-Za-z]+(?:[- ][A-Z][A-Za-z]+){1,2})";
  const BAD = /\b(The|Our|And|Team|Brand|Studio|Collection|Collections|Seoul|Korea|Paris|Shop|Store|Official|Since|Based|Of|In|At|For|With|AND|THE|OUR|TEAM|BRAND|STUDIO|SHOP)\b/;
  const tidy = n => n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[- ])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : n;
  const en = txt.match(new RegExp(`${ROLE}(?:\\s*(?:&|and|/)\\s*${ROLE})?\\s*[:,\\-–—]?\\s+${NAME}\\b`));
  if (en && !BAD.test(en[1])) return { name: tidy(en[1]), how: "homepage text" };
  const en2 = txt.match(new RegExp(`\\b${NAME}\\s*[,(]\\s*(?:the\\s+)?${ROLE}\\b`));
  if (en2 && !BAD.test(en2[1])) return { name: tidy(en2[1]), how: "homepage text" };
  const ko = txt.match(new RegExp(`(?:크리에이티브 디렉터|디렉터|디자이너|대표 디자이너|설립자)\\s*[:：]?\\s*([${SUR}][가-힣]{1,2}?)(?=(?:가|는|이|의|와|님)?(?![가-힣]))`));
  if (ko && !STOP.test(ko[1])) return { name: ko[1], how: "homepage text" };
  const ko2 = txt.match(new RegExp(`(?<![가-힣])([${SUR}][가-힣]{1,2})\\s*(?:크리에이티브 디렉터|디렉터|디자이너)(?:가|는|이|의)?\\s`));
  if (ko2 && !STOP.test(ko2[1])) return { name: ko2[1], how: "homepage text" };
  return null;
}
async function wikidataDirector(brand) {
  try {
    const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=3&search=${encodeURIComponent(brand)}`, { headers: { "User-Agent": "VISUAL-DEPT-checker/1.0 (github.com/mingyumacbook/archive)" } });
    const j = await r.json();
    for (const hit of j.search || []) {
      if (!/fashion|clothing|apparel|label|brand|designer/i.test(hit.description || "")) continue;
      const e = await (await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`)).json();
      const cl = e.entities?.[hit.id]?.claims || {};
      const ids = ["P1037", "P112", "P170"].flatMap(p => (cl[p] || []).map(c => c.mainsnak?.datavalue?.value?.id)).filter(Boolean);
      if (!ids.length) continue;
      const pe = await (await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${ids[0]}.json`)).json();
      const lab = pe.entities?.[ids[0]]?.labels || {};
      const name = lab.ko?.value || lab.en?.value; if (name) return { name, how: "wikidata", src: `https://www.wikidata.org/wiki/${hit.id}` };
    }
  } catch {}
  return null;
}
const ABOUT = ["about", "about-us", "pages/about", "pages/about-us", "brand", "story", "info", "company", "page/about"];
async function findDirector(url, home, brand) {
  let d = home ? directorFrom(home) : null; if (d) return { ...d, src: url };
  const base = (/^https?:/i.test(url) ? url : "https://" + url).replace(/[?#].*$/, "").replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const links = home ? [...home.matchAll(/href=["']([^"'#]+)["']/gi)].map(m => m[1]).filter(x => /about|brand|story|company|info|소개|브랜드/i.test(x)).slice(0, 4) : [];
  const tried = new Set();
  for (const pth of [...links, ...ABOUT]) {
    let u; try { u = new URL(pth, origin + "/").href; } catch { continue; }
    if (tried.has(u) || !u.startsWith(origin) || tried.size >= 5) continue; tried.add(u);
    const r = await open(u); if (r.status !== 200 || !r.text) continue;
    d = directorFrom(r.text); if (d) return { ...d, src: u };
  }
  if (brand) { d = await wikidataDirector(brand); if (d) return d; }
  return null;
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
  L.designers.forEach(d => d.url && want.set(key(d.url), { url: d.url, designer: true, name: d.name }));
  L.sites.forEach(u => { if (!want.has(key(u))) want.set(key(u), { url: u, designer: false }); });
  const prefs = (await rest("docs?collection=eq.prefs&id=eq.vd&select=data&limit=5000")) || [];
  for (const p of prefs) { const d = p.data || {}; (d.addedDes || []).forEach(x => x && x.url && want.set(key(x.url), { url: x.url, designer: true, name: x.name })); Object.values(d.desEdits || {}).forEach(x => x && x.url && want.set(key(x.url), { url: x.url, designer: true, name: x.name })); (d.sites || []).forEach(x => x && x.url && !want.has(key(x.url)) && want.set(key(x.url), { url: x.url, designer: false })); }
  const have = new Map(((await rest("shared_docs?collection=eq.sitecheck&select=id,data&limit=5000")) || []).map(r => [r.id, r.data]));
  const now = Date.now(); const todo = [...want.entries()].filter(([k, v]) => { const h = have.get(k); return !h || now - (h.at || 0) > 20 * 3600e3 || (v.designer && !h.desc && now - (h.at || 0) > 6 * 3600e3) || (v.designer && h.ok && h.dirTried == null); });
  const rows = []; let ok = 0, bad = 0;
  let i = 0; await Promise.all(Array.from({ length: 4 }, async () => { while (i < todo.length) { const [k, v] = todo[i++]; const r = await open(v.url);
    const alive = r.status > 0 && r.status < 400 || [401, 403, 429].includes(r.status); alive ? ok++ : bad++;
    const data = { ok: alive, status: r.status, at: Date.now() };
    if (v.designer) { const prev = have.get(k) || {}; const a = r.text ? about(r.text) : { desc: "", title: "" };
      if (a.desc) { data.desc = a.desc; data.title = a.title; if (a.desc !== prev.desc) { const ko = HANGUL.test(a.desc); data.desc_ko = ko ? a.desc : await tr(a.desc, "ko"); data.desc_en = ko ? await tr(a.desc, "en") : a.desc; } else { data.desc_ko = prev.desc_ko; data.desc_en = prev.desc_en; } }
      else if (prev.desc) Object.assign(data, { desc: prev.desc, title: prev.title, desc_ko: prev.desc_ko, desc_en: prev.desc_en });
      // director: searched when missing (at most once a week), kept once found
      if (prev.director) Object.assign(data, { director: prev.director, director_how: prev.director_how, director_src: prev.director_src, dirTried: prev.dirTried || Date.now() });
      else if (alive && (!prev.dirTried || Date.now() - prev.dirTried > 7 * 864e5)) { const f = await findDirector(v.url, r.text, v.name); data.dirTried = Date.now(); if (f) Object.assign(data, { director: f.name, director_how: f.how, director_src: f.src }); }
      else data.dirTried = prev.dirTried || null; }
    rows.push({ collection: "sitecheck", id: k, data }); } }));
  for (let j = 0; j < rows.length; j += 100) await upsert(rows.slice(j, j + 100));
  fs.mkdirSync("status", { recursive: true });
  fs.writeFileSync("status/sites.json", JSON.stringify({ at: new Date().toISOString(), links: want.size, checkedNow: rows.length, ok, unreachable: bad, withDescription: rows.filter(r => r.data.desc).length, withDirector: rows.filter(r => r.data.director).map(r => r.data.director + ' (' + r.data.director_how + ')'), defaultUnreachable: [...L.designers.map(d => d.url), ...L.sites].filter(u => { const d = rows.find(r => r.id === key(u))?.data || have.get(key(u)); return d && !d.ok; }).map(u => `${norm(u)} (${(rows.find(r => r.id === key(u))?.data || have.get(key(u))).status})`) }, null, 1));
  console.log(`homepages: ${rows.length} checked (${ok} ok, ${bad} unreachable) of ${want.size}`);
}
main().catch(e => { console.error(e); process.exit(1); });
