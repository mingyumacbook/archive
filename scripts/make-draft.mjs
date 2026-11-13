// Build the preview page at /draft/ from an app file (default: dev/next.html, else index.html).
// The preview runs on sample data (dev/mock.html), never on the real database, and opens as the master.
//   node scripts/make-draft.mjs [dev/next.html]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const src = process.argv[2] || (existsSync("dev/next.html") ? "dev/next.html" : "index.html");
let html = readFileSync(src, "utf8");
const mock = readFileSync("dev/mock.html", "utf8");
const lib = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"]+"><\/script>/;
if (!lib.test(html)) { console.error("Could not find the Supabase script tag to swap for sample data."); process.exit(1); }
html = html.replace(lib, () => mock)
  .replace('<script src="config.js"></script>', '<script src="../config.js"></script>')
  .replace('navigator.serviceWorker.register("sw.js").catch(()=>{})', "Promise.resolve().catch(()=>{})");
mkdirSync("draft", { recursive: true });
writeFileSync("draft/index.html", html);
console.log(`draft/index.html built from ${src} (sample data)`);
