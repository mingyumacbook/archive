import fs from "node:fs";
fs.mkdirSync("probe-out", { recursive: true });
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" };
const urls = {
  "tf-ss27.md": "https://tfashion.ai/runway/ss27.md", "tf-ss27-men.md": "https://tfashion.ai/runway/ss27/menswear.md",
  "tf-fw26.md": "https://tfashion.ai/runway/fw26.md", "tf-fw26-men.md": "https://tfashion.ai/runway/fw26/menswear.md",
  "tf-index.md": "https://tfashion.ai/runway.md", "tf-method.md": "https://tfashion.ai/runway/methodology.md",
  "wgsn-ss27.html": "https://www.wgsn.com/en/node/2563", "coloro-key.html": "https://www.coloro.com/key-colors",
  "vogue-designer.html": "https://www.vogue.com/fashion-shows/designer/prada", "nowfashion-prada.html": "https://nowfashion.com/prada/",
};
const out = {};
for (const [f, u] of Object.entries(urls)) {
  try { const r = await fetch(u, { headers: UA, redirect: "follow" }); const t = await r.text(); fs.writeFileSync("probe-out/" + f, t); out[f] = [r.status, t.length, r.url]; }
  catch (e) { out[f] = ["ERR", String(e)]; }
}
const URL_ = process.env.SUPABASE_URL.trim().replace(/\/(rest|auth|storage)\/v1\/?.*$/, "").replace(/\/+$/, ""); const KEY = process.env.SUPABASE_SERVICE_KEY;
const r = await fetch(`${URL_}/rest/v1/shared_docs?collection=eq.feed&select=id,data&limit=3000`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
const rows = await r.json(); const now = Date.now();
const HAN = /[가-힣]/;
const st = { total: rows.length, issue: 0, tr: 0, notr: 0, notrRecent: 0, notrOld: 0, hasImgOg: 0, ages: {} , untranslatedSamples: [], translatedSamples: [] };
for (const { data: d } of rows) {
  if (d.kind === "issue") { st.issue++; continue; }
  const age = Math.floor((now - (d.fetchedAt || 0)) / 864e5); st.ages[age > 30 ? "30+" : age] = (st.ages[age > 30 ? "30+" : age] || 0) + 1;
  if (d.imgSrc === "og") st.hasImgOg++;
  if (d.tr) { st.tr++; if (st.translatedSamples.length < 6) st.translatedSamples.push({ t: d.title, ko: d.title_ko, en: d.title_en, s: (d.summary_ko || "").slice(0, 80) }); }
  else { st.notr++; if (age < 14) st.notrRecent++; else st.notrOld++; if (st.untranslatedSamples.length < 15) st.untranslatedSamples.push({ t: d.title, age, src: d.source, han: HAN.test(d.title || "") }); }
}
fs.writeFileSync("probe-out/feed-stats.json", JSON.stringify(st, null, 1));
fs.writeFileSync("probe-out/fetch.json", JSON.stringify(out, null, 1));
console.log(out, st.total);
