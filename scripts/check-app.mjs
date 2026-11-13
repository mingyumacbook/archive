// Quick safety check for the single-file app: every inline <script> must parse.
//   node scripts/check-app.mjs index.html [draft/index.html …]
import { readFileSync } from "node:fs";
import vm from "node:vm";

let bad = 0;
for (const f of process.argv.slice(2).length ? process.argv.slice(2) : ["index.html"]) {
  const html = readFileSync(f, "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  scripts.forEach((code, i) => {
    try { new vm.Script(code, { filename: `${f}#script${i + 1}` }); }
    catch (e) { bad++; console.error(`${f} script ${i + 1}: ${e.message}`); }
  });
  console.log(`${f}: ${scripts.length} scripts checked`);
}
process.exit(bad ? 1 : 0);
