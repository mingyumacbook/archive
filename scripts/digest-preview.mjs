// One-off preview for the "요약 보기" draft: summarises a few of the newest stories and writes them to status/,
// without changing anything in the database.
import fs from "node:fs";
import { digest } from "./digest.mjs";
const URL_ = process.env.SUPABASE_URL?.trim().replace(/\/(rest|auth|storage)\/v1\/?.*$/, "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const rows = await (await fetch(`${URL_}/rest/v1/shared_docs?collection=eq.feed&select=id,data&limit=600`, { headers: H })).json();
const news = rows.map(r => r.data).filter(d => d && d.kind !== "issue" && d.url && d.img).sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
const bySrc = new Map(); for (const d of news) { if (!bySrc.has(d.source)) bySrc.set(d.source, d); if (bySrc.size >= 14) break; }
const out = []; const log = [];
for (const d of bySrc.values()) {
  const t0 = Date.now(); const g = await digest(d.url, d.title_en || d.title, undefined, d.summary_en || d.summary || "");
  log.push(`${d.source}: ${g ? `${g.lines}/${g.of} lines, ${g.words} words` : "no text"} (${Date.now() - t0}ms)`);
  if (g) out.push({ ...d, digest: g });
  if (out.length >= 10) break;
}
fs.mkdirSync("status", { recursive: true });
fs.writeFileSync("status/digest-preview.json", JSON.stringify({ at: new Date().toISOString(), log, items: out }, null, 1));
console.log(log.join("\n"));
