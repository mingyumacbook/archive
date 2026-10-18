// VISUAL DEPT. season report collector — runs on GitHub Actions every day (free).
// Facts only, copied from official public pages, never estimated:
//   • T-Fashion Runway Index (tfashion.ai/runway, the .md versions of its public pages): share of looks measured on the runways,
//     the change against the same season one year earlier (percentage points), number of looks and designers,
//     top designers by look count, share by fashion week, items worn with it, and the press articles T-Fashion lists.
//   • WGSN × Coloro Key Colours (coloro.com/key-colors): the colour names and Coloro codes as WGSN announced them.
// Every value keeps its source link. If a page can't be read, the previous saved data stays as it was.
import fs from "node:fs";

const URL_ = process.env.SUPABASE_URL?.trim().replace(/\/(rest|auth|storage)\/v1\/?.*$/, "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY secrets."); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" };
const upsert = rows => rows.length ? fetch(`${URL_}/rest/v1/shared_docs?on_conflict=collection,id`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) }).then(async r => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); }) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = []; const say = (...a) => { const s = a.join(" "); log.push(s); console.log(s); };

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { headers: UA, redirect: "follow", signal: ctl.signal }); clearTimeout(t);
      if (r.status === 404) return null;
      if (r.ok) { await sleep(350); return await r.text(); }
    } catch {}
    await sleep(1500 * (i + 1));
  }
  return null;
}
const num = s => { const m = String(s || "").replace(/,/g, "").replace(/−/g, "-").match(/-?\d+(?:\.\d+)?/); return m ? +m[0] : null; };
const link = s => { const m = String(s).match(/\[([^\]]+)\]\(([^)]+)\)/); return m ? { name: m[1].trim(), url: m[2].trim() } : { name: String(s).replace(/[*_]/g, "").trim(), url: "" }; };
function sections(md) { // "## Heading" / "### Heading" -> lines
  const out = {}; let cur = "_top"; out[cur] = [];
  for (const line of md.split("\n")) { const h = line.match(/^#{2,3}\s+(.+?)\s*$/); if (h) { cur = h[1]; out[cur] = []; } else out[cur].push(line); }
  return out;
}
function table(lines) { // markdown table -> {head, rows}
  const t = lines.filter(l => /^\s*\|/.test(l)); if (t.length < 3) return null;
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(x => x.trim());
  return { head: cells(t[0]), rows: t.slice(2).map(cells) };
}
const items = lines => lines.filter(l => /^\s*(?:[-*]|\d+\.)\s+/.test(l)).map(l => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim());
const findSec = (S, re) => Object.keys(S).find(k => re.test(k));

function trendRows(md) { // all tables with "Share of looks" columns
  const S = sections(md); const rows = []; let prevLabel = "";
  for (const k of Object.keys(S)) {
    const tb = table(S[k]); if (!tb) continue;
    const hi = n => tb.head.findIndex(h => n.test(h));
    const iShare = hi(/share of looks/i), iChange = hi(/change/i), iLooks = hi(/^looks$/i), iDes = hi(/designers/i), iType = hi(/type/i);
    if (iShare < 0) continue;
    const iPrev = iShare + 1 < tb.head.length && iShare + 1 !== iChange ? iShare + 1 : -1;
    if (iPrev >= 0) prevLabel = tb.head[iPrev];
    for (const r of tb.rows) {
      const l = link(r[0]);
      rows.push({ name: l.name, url: l.url, type: iType >= 0 ? r[iType] : "", share: num(r[iShare]), prev: iPrev >= 0 ? num(r[iPrev]) : null, change: iChange >= 0 ? (/new/i.test(r[iChange]) ? "new" : num(r[iChange])) : null, looks: iLooks >= 0 ? num(r[iLooks]) : null, designers: iDes >= 0 ? num(r[iDes]) : null });
    }
  }
  return { rows, prevLabel };
}
const TYPES = [["colors", /colou?rs?/i], ["patterns", /patterns?/i], ["fabrics", /fabrics?/i], ["themes", /themes?/i], ["items", /key items?/i]];

async function detail(url) {
  const md = await get(url.replace(/\/?$/, "") + ".md"); if (!md) return null;
  const S = sections(md); const d = {};
  const press = findSec(S, /press/i);
  if (press) {
    const intro = S[press].find(l => l.trim() && !/^\s*[-*]/.test(l)); d.pressNote = intro ? intro.trim().slice(0, 300) : "";
    d.press = items(S[press]).map(t => { const m = t.match(/^(.+?),\s*(\d{4}-\d{2}-\d{2}):\s*\[([^\]]+)\]\(([^)]+)\)/) || t.match(/^(.+?):\s*\[([^\]]+)\]\(([^)]+)\)/); if (!m) return null; return m.length === 5 ? { outlet: m[1].trim(), date: m[2], title: m[3].trim(), url: m[4] } : { outlet: m[1].trim(), date: "", title: m[2].trim(), url: m[3] }; }).filter(Boolean).slice(0, 12);
  }
  const des = findSec(S, /designer/i);
  if (des) { d.designers = items(S[des]).map(t => { const m = t.match(/^(.+?):\s*([\d,]+)/); return m ? { name: link(m[1]).name, looks: num(m[2]) } : null; }).filter(Boolean); const more = S[des].join(" ").match(/([\d,]+)\s+more designers/i); if (more) d.moreDesigners = num(more[1]); }
  const wk = findSec(S, /fashion week|by city/i);
  if (wk) d.cities = items(S[wk]).map(t => { const m = t.match(/^(.+?):\s*([\d.]+)%(?:\s*\(([\d,]+)\s*looks?\))?/); return m ? { city: link(m[1]).name, share: +m[2], looks: m[3] ? num(m[3]) : null } : null; }).filter(Boolean);
  const ww = findSec(S, /worn with/i);
  if (ww) d.wornWith = items(S[ww]).map(t => { const m = t.match(/^(.+?)\s*(?:\(([^)]+)\))?:\s*([\d.]+)%/); return m ? { name: link(m[1]).name, kind: m[2] || "", share: +m[3] } : null; }).filter(Boolean);
  const os = findSec(S, /other seasons/i);
  if (os) d.otherSeasons = items(S[os]).map(t => { const m = t.match(/^(.+?):\s*([\d.]+)%/); return m ? { season: link(m[1]).name, share: +m[2] } : null; }).filter(Boolean);
  const top = (S._top || []).join("\n"); const rf = top.match(/Data refreshed:\s*(.+)/i); if (rf) d.refreshed = rf[1].trim();
  return d;
}

async function season(code, gender) {
  const base = `https://tfashion.ai/runway/${code.toLowerCase()}${gender === "men" ? "/menswear" : ""}`;
  const md = await get(base + ".md"); if (!md) { say("skip", code, gender, "(page not readable)"); return null; }
  const S = sections(md); const top = (S._top || []).join("\n");
  const out = { season: code, gender, src: base, refreshed: (top.match(/Data refreshed:\s*(.+)/i) || [])[1]?.trim() || "", looks: num((top.match(/across ([\d,]+) looks/i) || [])[1]), designersTotal: num((top.match(/from ([\d,]+) designers/i) || [])[1]), prevLabel: "", colors: [], patterns: [], fabrics: [], themes: [], items: [], garments: [], rising: [], fading: [], fetchedAt: Date.now() };
  const g = findSec(S, /garment/i); if (g) out.garments = items(S[g]).map(t => { const m = t.match(/^(.+?):\s*([\d.]+)%/); return m ? { name: m[1].trim(), share: +m[2] } : null; }).filter(Boolean);
  for (const [k, re] of [["rising", /^rising/i], ["fading", /^fading/i]]) { const s = findSec(S, re); if (s) out[k] = items(S[s]).map(t => { const l = link(t); const m = t.match(/([\d.]+)%\s*→\s*([\d.]+)%/); return m ? { name: l.name, url: l.url, prev: +m[1], share: +m[2], change: Math.round((+m[2] - +m[1]) * 10) / 10 } : null; }).filter(Boolean); }
  // category pages ("61 more colors: https://...")
  const moreLinks = [...md.matchAll(/(\d+)\s+more\s+([a-z ]+?):\s*(https:\/\/tfashion\.ai\/\S+)/gi)].map(m => ({ n: +m[1], what: m[2], url: m[3] }));
  const all = trendRows(md); if (all.prevLabel) out.prevLabel = all.prevLabel;
  const catOf = t => (TYPES.find(([k, re]) => k === t || re.test(t)) || [""])[0];
  const byName = new Map(); const add = r => { r.cat = catOf(r.type); if (!r.cat) return; const k = r.name.toLowerCase() + "|" + r.cat; const o = byName.get(k); if (!o || (o.change == null && r.change != null)) byName.set(k, r); };
  all.rows.forEach(add);
  for (const ml of moreLinks) { const p = await get(ml.url.replace(/\/?$/, "") + ".md"); if (!p) continue; const tr = trendRows(p); if (tr.prevLabel) out.prevLabel = tr.prevLabel; tr.rows.forEach(add); }
  // lists on the main page that only show "x% of looks" (top 3 per type) — keep them if no table row exists
  for (const [k, re] of TYPES) { const s = findSec(S, new RegExp(`^${re.source}$`, "i")); if (!s) continue; items(S[s]).forEach(t => { const l = link(t); const m = t.match(/([\d.]+)%/); if (m) add({ name: l.name, url: l.url, type: k, share: +m[1], prev: null, change: null, looks: null, designers: null }); }); }
  for (const r of byName.values()) { out[r.cat].push(r); delete r.type; }
  for (const [k] of TYPES) out[k].sort((a, b) => (b.share || 0) - (a.share || 0));
  // evidence for every trend that has numbers
  const all2 = TYPES.flatMap(([k]) => out[k]).concat(out.rising, out.fading).filter(r => r.url);
  const done = new Map();
  for (const r of all2) { if (!done.has(r.url)) done.set(r.url, await detail(r.url)); const d = done.get(r.url); if (d) r.ev = d; }
  say(code, gender, `colors ${out.colors.length} patterns ${out.patterns.length} fabrics ${out.fabrics.length} themes ${out.themes.length} items ${out.items.length} details ${[...done.values()].filter(Boolean).length} prev ${out.prevLabel}`);
  return out;
}

const COLORO_SEASON = s => { const m = s.match(/(S\/S|A\/W)\s*(\d{2})/); return m ? (m[1] === "S/S" ? "SS" : "FW") + m[2] : ""; };
async function coloro() {
  const html = await get("https://www.coloro.com/key-colors"); if (!html) { say("coloro: not readable"); return null; }
  const txt = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "\n").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").split("\n").map(s => s.trim()).filter(Boolean);
  const seasons = {}; let cur = null, coty = "";
  for (let i = 0; i < txt.length; i++) {
    const l = txt[i];
    if (/^Key Colors$/i.test(l) && /^(S\/S|A\/W)\s*\d{2}/.test(txt[i + 1] || "")) { cur = COLORO_SEASON(txt[i + 1]); coty = ""; continue; }
    if (/^Key Colors\s+(S\/S|A\/W)\s*\d{2}/i.test(l) && /—|Swatch|forecast|20\d\d/i.test(txt.slice(i + 1, i + 4).join(" ")) && !/^Key Colors/i.test(txt[i + 1] || "")) { cur = COLORO_SEASON(l); coty = ""; continue; }
    const y = l.match(/^Colou?r of the Year (\d{4})/i); if (y) { coty = y[1]; continue; }
    const c = l.match(/^(\d{3})\s*[—–-]\s*(\d{2})\s*[—–-]\s*(\d{2})$/);
    if (c && cur) { const name = txt[i + 1]; const arr = (seasons[cur] ||= []); if (!arr.some(x => x.name === name)) arr.push({ name, code: `${c[1]}-${c[2]}-${c[3]}`, coty: coty || "" }); coty = ""; }
  }
  for (const k of Object.keys(seasons)) if (!seasons[k].length) delete seasons[k];
  say("coloro seasons:", Object.entries(seasons).map(([k, v]) => `${k}(${v.map(x => x.name).join(", ")})`).join(" "));
  return { src: "https://www.coloro.com/key-colors", seasons, fetchedAt: Date.now() };
}

async function main() {
  const idx = await get("https://tfashion.ai/runway.md");
  const codes = idx ? [...new Set([...idx.matchAll(/tfashion\.ai\/runway\/((?:ss|fw)\d{2})\)/gi)].map(m => m[1].toUpperCase()))].slice(0, 3) : ["SS27", "FW26"];
  say("seasons:", codes.join(", "));
  const rows = [];
  for (const c of codes) for (const g of ["women", "men"]) { const r = await season(c, g); if (r && (r.colors.length || r.patterns.length)) rows.push({ collection: "seasonreport", id: `${c}-${g}`, data: r }); }
  const w = await coloro(); if (w && Object.keys(w.seasons).length) rows.push({ collection: "seasonreport", id: "wgsn", data: w });
  rows.push({ collection: "seasonreport", id: "_meta", data: { seasons: codes, updatedAt: Date.now(), log: log.slice(-20) } });
  for (const r of rows) await upsert([r]);
  fs.mkdirSync("status", { recursive: true });
  fs.writeFileSync("status/report.json", JSON.stringify({ at: new Date().toISOString(), log, sample: rows.find(r => r.id.endsWith("-women"))?.data?.patterns?.slice(0, 2) }, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
