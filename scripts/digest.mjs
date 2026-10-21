// VISUAL DEPT. article summary ("요약 보기") — no AI, nothing invented.
// Reads the article page, takes its body text, and picks the sentences that carry the most information
// (names, numbers, words the article keeps repeating, the lead). Those sentences are kept in the article's order,
// so the summary is the article's own words, shortened — then translated so it reads in English and in Korean.
import { tr } from "./i18n-dict.mjs";

const HANGUL = /[가-힣]/;
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "Accept-Language": "en,ko;q=0.8", Accept: "text/html,*/*;q=0.8" };
const decode = s => String(s || "").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const strip = h => decode(h.replace(/<(script|style|noscript|svg|figure|figcaption|aside|nav|footer|form|button)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const JUNK = /^(advertisement|sign up|subscribe|read more|related|photo|image|credit|getty|courtesy|follow us|share|click|newsletter|©|all rights|by [A-Z][a-z]+ [A-Z]|updated|published|기자|저작권|무단|구독|사진=|사진 ?제공|ⓒ)/i;
// boilerplate that can sit anywhere in a sentence: affiliate notes, share bars, author bios, sign-up prompts
const NOISE = /(affiliate commission|we may earn|earn a commission|commission if you buy|share this (article|story)|join the conversation|follow us|sign up for|newsletter|all rights reserved|facebook|whatsapp|pinterest|instagram\.com|getty images|photo(graph)? (by|courtesy)|preferred source|(is|was) (a|the) (senior |deputy |associate |contributing )?(fashion |beauty |news )?(editor|writer|director) (at|of)|began (her|his) career|started (her|his|their) career|lives in (new york|london|los angeles)|무단 ?전재|재배포 ?금지|기자 ?=|구독하기|^text [A-Z][a-z]+|\b(life|culture|fashion|beauty|art)\s*\/\s*(lists?|news|features?)\b)/i;

export async function fetchArticle(url, ms = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { headers: UA, redirect: "follow", signal: ctl.signal }); if (!r.ok) return ""; return (await r.text()).slice(0, 1500000); }
  catch { return ""; } finally { clearTimeout(t); }
}
export function articleText(html) {
  if (!html) return "";
  // 1) the body the publisher declares in its structured data
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const walk = o => { if (!o) return ""; if (Array.isArray(o)) { for (const x of o) { const r = walk(x); if (r) return r; } return ""; } if (typeof o === "object") { if (typeof o.articleBody === "string" && o.articleBody.length > 400) return o.articleBody; for (const v of Object.values(o)) { const r = walk(v); if (r) return r; } } return ""; };
      const b = walk(JSON.parse(m[1].trim())); if (b) return decode(b).replace(/\s+/g, " ").trim(); } catch {}
  }
  // 2) paragraphs inside <article> (or the main content block), skipping short captions and boilerplate
  const scope = (html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<div[^>]+(?:id|class)=["'][^"']*(?:article[-_]?body|articleBody|article_txt|article-content|news_body|post-content|entry-content|story-body|view_con|news_view|article_view)[^"']*["'][\s\S]{0,200000}/i) || [html])[0];
  const paras = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => strip(m[1])).filter(p => p.length > 40 && !JUNK.test(p) && !NOISE.test(p));
  if (paras.join(" ").length > 300) return paras.join("\n");
  // 3) Korean news pages often put the text in a div with <br> line breaks
  const k = scope.match(/<div[^>]+(?:id|class)=["'][^"']*(?:article|news|view|content)[^"']*["'][^>]*>([\s\S]{400,60000}?)<\/div>/i);
  return k ? strip(k[1]) : "";
}
export function sentences(text) {
  const ko = HANGUL.test(text);
  const parts = text.split(/\n+/).flatMap(p => ko ? p.split(/(?<=[.!?]|다\.|요\.)\s+/) : p.split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[A-Z0-9])/));
  return parts.map(s => s.trim()).filter(s => s.length >= (ko ? 18 : 40) && s.length <= 320 && !JUNK.test(s) && !NOISE.test(s) && /[.!?다요"”]$/.test(s));
}
const STOP = new Set("the a an and or but of to in on at for with from by as is are was were be been it its this that these those his her their our your they he she we you i not no so if than then also has have had will would can could just more most into over about after before which who whom what when where while new said says say one two".split(" "));
const words = s => (s.toLowerCase().match(/[a-z][a-z'’-]{2,}|[가-힣]{2,}|\d[\d.,%]*/g) || []).filter(w => !STOP.has(w));
// pick the informative sentences: a summary roughly a fifth of the article, at least 4 and usually up to 10 lines
export function pick(text, title = "", hint = "") {
  const ss = sentences(text); if (ss.length < 3) return { lines: ss, total: ss.length };
  const tf = {}; ss.forEach(s => new Set(words(s)).forEach(w => tf[w] = (tf[w] || 0) + 1));
  const tw = new Set(words(title)), hw = new Set(words(hint));
  const scored = ss.map((s, i) => { const ws = words(s); if (!ws.length) return { s, i, v: 0 };
    let v = ws.reduce((a, w) => a + Math.log(1 + (tf[w] || 0)), 0) / Math.sqrt(ws.length);
    v += ws.filter(w => tw.has(w)).length * 0.6 + ws.filter(w => hw.has(w)).length * 0.3; // about what the headline and the outlet's own blurb say
    v += (s.match(/\d/g) || []).length ? 0.8 : 0;                  // numbers, dates, prices
    v += (s.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g) || []).length * 0.15; // names
    v += i === 0 ? 1.4 : i < 3 ? 0.6 : 0;                           // the lead
    if (i > ss.length * 0.9 && ss.length > 12) v -= 1;              // endings are often bios and sign-offs
    if (/^["“]/.test(s) && s.length < 80) v -= 0.6;                 // short quotes alone say little
    return { s, i, v }; });
  const n = Math.max(4, Math.min(ss.length > 40 ? 12 : 10, Math.round(ss.length * 0.22)));
  const lines = scored.slice().sort((a, b) => b.v - a.v).slice(0, n).sort((a, b) => a.i - b.i).map(x => x.s);
  return { lines, total: ss.length };
}
// full summary for one story: lines in the article's language and both translations
export async function digest(url, title = "", html, hint = "") {
  const page = html ?? await fetchArticle(url);
  const text = articleText(page); if (!text || (text.match(/\S+/g) || []).length < 220) return null;
  const { lines, total } = pick(text, title, hint); if (lines.length < 3) return null;
  // the text must really be this story: most picked lines share words with the headline or the outlet's blurb
  const key = new Set([...words(title), ...words(hint)]); if (key.size >= 3) { const hit = lines.filter(l => words(l).some(w => key.has(w))).length; if (hit / lines.length < 0.4) return null; }
  const ko = HANGUL.test(lines.join(" "));
  const out = { lines: lines.length, of: total, words: (text.match(/\S+/g) || []).length, at: Date.now() };
  const other = [];
  for (const l of lines) { const x = await tr(l, ko ? "en" : "ko"); if (!x) return null; other.push(x); }
  if (ko) { out.ko = lines; out.en = other; } else { out.en = lines; out.ko = other; }
  return out;
}
