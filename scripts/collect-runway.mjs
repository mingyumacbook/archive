// VISUAL DEPT. runway history collector — runs on GitHub Actions once a week (free).
// For every brand in scripts/runway-brands.json it reads the brand's public Vogue Runway designer page
// and saves the full list of collections (season, link, cover picture). Facts only: nothing is guessed —
// a brand whose page can't be found is saved as "not found" and the app shows a search link instead.
import fs from "node:fs";

const URL_ = process.env.SUPABASE_URL?.trim().replace(/\/(rest|auth|storage)\/v1\/?.*$/, "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY secrets."); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "Accept-Language": "en" };
const upsert = rows => rows.length ? fetch(`${URL_}/rest/v1/shared_docs?on_conflict=collection,id`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) }).then(async r => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); }) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(url, { headers: UA, redirect: "follow", signal: ctl.signal }); clearTimeout(t);
      if (r.status === 404) return { status: 404 };
      if (r.ok) return { status: 200, url: r.url, text: await r.text() };
      await sleep(2000 * (i + 1));
    } catch { await sleep(2000 * (i + 1)); }
  }
  return { status: 0 };
}
const plain = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function candidates(name, nf) {
  const p = plain(name).replace(/[°º]/g, "");
  const a = p.replace(/&/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const b = p.replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const c = a.replace(/-(?=\d)/g, "").replace(/(?<=\d)-/g, "");
  const d = p.replace(/[^a-z0-9]+/g, "");
  return [...new Set([a, b, c, d, nf].filter(Boolean))];
}
function parseSeasons(text, slug) {
  const out = []; const seen = new Set();
  const re = new RegExp(`"hed":"([^"]{3,80})","url":"\\\\u002Ffashion-shows\\\\u002F([a-z0-9-]+)\\\\u002F${slug.replace(/[-]/g, "\\-")}"`, "g");
  let m;
  while ((m = re.exec(text))) {
    const s = m[2]; if (seen.has(s) || s === "designer") continue; seen.add(s);
    const near = text.slice(m.index, m.index + 2500);
    const im = near.match(/assets\.vogue\.com\\u002Fphotos\\u002F([a-f0-9]{16,})\\u002Fmaster\\u002F[^\\"]*?\\u002F([^"\\\s]+?\.(?:jpe?g|png|webp))/i);
    out.push({ t: m[1], s, img: im ? `https://assets.vogue.com/photos/${im[1]}/master/w_320,c_limit/${im[2]}` : "" });
  }
  return out;
}
const yearOf = s => +((s.match(/(19|20)\d\d/) || [0])[0]);
const order = s => (/^resort/.test(s) ? 1 : /^spring/.test(s) ? 2 : /^pre-fall/.test(s) ? 3 : /^fall/.test(s) ? 4 : 5);

async function main() {
  const brands = JSON.parse(fs.readFileSync(new URL("./runway-brands.json", import.meta.url)));
  const keys = Object.keys(brands); const index = {}; const rows = []; let found = 0;
  let i = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < keys.length) {
      const k = keys[i++]; const b = brands[k]; let hit = null;
      for (const slug of candidates(b.name, b.nf)) {
        const r = await get(`https://www.vogue.com/fashion-shows/designer/${slug}`); await sleep(400);
        if (r.status !== 200) continue;
        const seasons = parseSeasons(r.text, slug);
        if (seasons.length) { hit = { slug, seasons }; break; }
      }
      if (hit) {
        hit.seasons.sort((x, y) => yearOf(y.s) - yearOf(x.s) || order(y.s) - order(x.s));
        found++; index[k] = hit.seasons.length;
        rows.push({ collection: "runwayhist", id: k, data: { name: b.name, vogue: hit.slug, seasons: hit.seasons, checkedAt: Date.now() } });
      } else { index[k] = 0; rows.push({ collection: "runwayhist", id: k, data: { name: b.name, vogue: "", seasons: [], checkedAt: Date.now() } }); }
      if (rows.length >= 25) await upsert(rows.splice(0));
    }
  }));
  await upsert(rows);
  await upsert([{ collection: "runwayhist", id: "_index", data: { counts: index, found, total: keys.length, checkedAt: Date.now() } }]);
  fs.mkdirSync("status", { recursive: true });
  fs.writeFileSync("status/runway.json", JSON.stringify({ found, total: keys.length, missing: keys.filter(k => !index[k]).map(k => brands[k].name), at: new Date().toISOString() }, null, 1));
  console.log(`runway history: ${found}/${keys.length} brands found`);
}
main().catch(e => { console.error(e); process.exit(1); });
