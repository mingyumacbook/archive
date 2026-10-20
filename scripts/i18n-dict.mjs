// VISUAL DEPT. translation dictionary shared by the collectors.
// Every word or sentence a collector saves for the app (trend names, press notes, article titles, colour names,
// city names, news tags, outlet names, directors…) is translated once with the free Google Translate web endpoint
// and kept in shared_docs (collection "i18n"), so the app can show everything in English or everything in Korean.
// Already-translated text is never sent again.
const HANGUL = /[가-힣]/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// three free endpoints, tried in turn (the first one sometimes refuses bursts from shared runners)
const ENDPOINTS = [
  (q, tl) => [`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(q)}`, j => (j?.[0] || []).map(x => x?.[0] || "").join("")],
  (q, tl) => [`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${tl}&q=${encodeURIComponent(q)}`, j => Array.isArray(j) ? (Array.isArray(j[0]) ? j[0][0] : j[0]) : (j?.sentences || []).map(x => x.trans || "").join("")],
  (q, tl) => [`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q.slice(0, 480))}&langpair=${/[\uac00-\ud7a3]/.test(q) ? "ko" : "en"}|${tl}`, j => j?.responseStatus == 200 ? j?.responseData?.translatedText || "" : ""]
];
let dead = new Set();
export async function tr(text, tl) {
  text = String(text || "").trim().slice(0, 1800); if (!text) return "";
  for (let e = 0; e < ENDPOINTS.length; e++) {
    if (dead.has(e)) continue;
    for (let i = 0; i < 2; i++) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
      try {
        const [url, pick] = ENDPOINTS[e](text, tl);
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36" }, signal: ctl.signal });
        if (r.status === 429 || r.status === 403) { await sleep(800); continue; }
        if (r.ok) { const out = String(pick(await r.json()) || "").trim(); if (out && !/MYMEMORY WARNING|QUERY LENGTH/i.test(out)) { await sleep(120); return out; } }
      } catch {} finally { clearTimeout(t); }
      await sleep(700 * (i + 1));
    }
    tr.fails = (tr.fails || {}); tr.fails[e] = (tr.fails[e] || 0) + 1; if (tr.fails[e] >= 6) dead.add(e); // stop using an endpoint that keeps refusing
  }
  return "";
}
// strings: iterable of texts. Latin text gets a Korean entry (dict.ko), Hangul text gets an English entry (dict.en).
export async function buildDict({ URL_, H, id, strings, keep = 2500, say = console.log, minutes = 8 }) {
  const until = Date.now() + minutes * 60e3; // stop in time; the rest is translated on the next run
  let prev = { ko: {}, en: {} };
  try { const r = await fetch(`${URL_}/rest/v1/shared_docs?collection=eq.i18n&id=eq.${id}&select=data`, { headers: H }); const j = await r.json(); if (j?.[0]?.data) prev = { ko: j[0].data.ko || {}, en: j[0].data.en || {} }; } catch {}
  const ko = {}, en = {}; let added = 0, failed = 0;
  const list = [...new Set([...strings].map(s => String(s || "").trim()).filter(s => s && s.length <= 1500 && /[A-Za-z가-힣]/.test(s)))];
  let i = 0;
  const save = async () => { const k2 = { ...prev.ko, ...ko }, e2 = { ...prev.en, ...en }; await fetch(`${URL_}/rest/v1/shared_docs?on_conflict=collection,id`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ collection: "i18n", id, data: { ko: k2, en: e2, updatedAt: Date.now() } }]) }); };
  let sinceSave = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < list.length && Date.now() < until) {
      const s = list[i++];
      if (HANGUL.test(s)) { if (prev.en[s]) { en[s] = prev.en[s]; continue; } const o = await tr(s, "en"); if (o) { en[s] = o; added++; } else failed++; }
      else { if (prev.ko[s]) { ko[s] = prev.ko[s]; continue; } if (!/[a-z]{2,}/i.test(s)) continue; const o = await tr(s, "ko"); if (o) { ko[s] = o; added++; } else failed++; }
      if (++sinceSave >= 60) { sinceSave = 0; try { await save(); } catch {} }
    }
  }));
  // keep older entries too (up to `keep`) so saved items and earlier seasons stay translated
  for (const [k, v] of Object.entries(prev.ko)) { if (Object.keys(ko).length >= keep) break; if (!(k in ko)) ko[k] = v; }
  for (const [k, v] of Object.entries(prev.en)) { if (Object.keys(en).length >= keep) break; if (!(k in en)) en[k] = v; }
  await fetch(`${URL_}/rest/v1/shared_docs?on_conflict=collection,id`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ collection: "i18n", id, data: { ko, en, updatedAt: Date.now() } }]) });
  say(`i18n/${id}: ${list.length} texts${i < list.length ? ` (stopped at ${i}, rest next run)` : ""} · ${added} newly translated · ${failed} failed · ${Object.keys(ko).length} ko / ${Object.keys(en).length} en kept`);
  return { ko, en, added, failed };
}
