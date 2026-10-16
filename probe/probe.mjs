import fs from "node:fs";
const urls = JSON.parse(fs.readFileSync("probe/input.json", "utf8"));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const pick = (h, re) => { const m = h.match(re); return m ? m[1].replace(/&amp;/g, "&").trim() : null; };
const meta = (h, p) => pick(h, new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']+)`, "i")) || pick(h, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${p}["']`, "i"));
async function one(u) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(u, { headers: { "user-agent": UA, "accept-language": "en,ko;q=0.8" }, redirect: "follow", signal: ctl.signal });
    const h = r.ok ? (await r.text()).slice(0, 600000) : "";
    const out = { url: u, status: r.status, final: r.url, image: meta(h, "og:image") || meta(h, "twitter:image"), title: meta(h, "og:title") };
    if (/nowfashion\.com/.test(u)) { const n = (h.match(/Look-\d{3}/g) || []); out.looks = new Set(n).size; }
    if (out.image) { try { const ir = await fetch(out.image, { method: "GET", headers: { "user-agent": UA, referer: "" }, signal: ctl.signal }); out.imageStatus = ir.status; out.imageType = ir.headers.get("content-type"); try { await ir.body?.cancel(); } catch {} } catch (e) { out.imageStatus = 0; } }
    return out;
  } catch (e) { return { url: u, status: 0, error: String(e.name || e) }; } finally { clearTimeout(t); }
}
const res = []; let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => { while (i < urls.length) { const u = urls[i++]; res.push(await one(u)); } }));
fs.writeFileSync("probe/output.json", JSON.stringify(res, null, 1));
console.log("done", res.length, "ok", res.filter(r => r.status === 200).length, "img", res.filter(r => r.imageStatus === 200).length);
