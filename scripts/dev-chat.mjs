// Developer chat worker: reads the master's requests from the 개발자 room (Supabase dev_msgs),
// lets Claude Code make the change in this repository, checks it, publishes it and replies in the room.
//   node scripts/dev-chat.mjs check   → sets has=true/false for the workflow
//   node scripts/dev-chat.mjs run     → does the work
import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

const URL_ = process.env.SUPABASE_URL?.trim().replace(/\/(rest|auth|storage)\/v1\/?.*$/, "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY."); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const api = async (path, opt = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
};
const say = (body, st = "info") => api("dev_msgs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ sender: "c", body: String(body).slice(0, 6000), st }) });
const mark = (ids, st) => ids.length && api(`dev_msgs?id=in.(${ids.join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ st }) });
const sh = c => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const PROTECTED = [/^config\.js$/, /^\.github\//, /^scripts\/dev-chat\.mjs$/, /^CLAUDE\.md$/];

async function check() {
  // a run that died part-way leaves requests "working": give them back after 50 minutes
  const stale = await api(`dev_msgs?select=id&sender=eq.m&st=eq.working&created_at=lt.${new Date(Date.now() - 50 * 60e3).toISOString()}`).catch(() => []);
  if (stale?.length) { await mark(stale.map(x => x.id), "queued"); }
  const q = await api("dev_msgs?select=id&sender=eq.m&st=eq.queued&limit=1");
  const has = !!q?.length; console.log(has ? "request waiting" : "nothing to do");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `has=${has}\n`);
}

async function run() {
  const queued = await api("dev_msgs?select=id,body,img,created_at&sender=eq.m&st=eq.queued&order=created_at.asc");
  if (!queued?.length) return console.log("nothing to do");
  const ids = queued.map(x => x.id);
  await mark(ids, "working");
  await say("확인했어요. 작업을 시작할게요 · 보통 5~15분 걸려요.");
  try {
    const hist = (await api("dev_msgs?select=id,sender,body,img,created_at&order=created_at.desc&limit=40")).reverse();
    mkdirSync(".dev-tmp", { recursive: true });
    const line = m => {
      let img = "";
      if (m.img && /^data:image\/\w+;base64,/.test(m.img)) { const f = `.dev-tmp/img-${m.id}.jpg`; writeFileSync(f, Buffer.from(m.img.split(",")[1], "base64")); img = ` [screenshot attached: ${f} — open it with Read]`; }
      return `${m.sender === "m" ? "MASTER" : "YOU (Claude)"} · ${m.created_at.slice(0, 16).replace("T", " ")} UTC: ${m.body}${img}`;
    };
    const before = hist.filter(m => !ids.includes(m.id)).slice(-30).map(line).join("\n");
    const now = hist.filter(m => ids.includes(m.id)).map(line).join("\n");
    const prompt = `Read CLAUDE.md first and follow it.\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n` +
      (existsSync("dev/next.html") ? "A draft is waiting for the master's OK (dev/next.html → /draft/).\n" : "No draft is waiting.\n") +
      `\nEarlier conversation in the developer room:\n${before || "(none)"}\n\nNEW REQUEST(S) from the master:\n${now}\n\n` +
      "Do the work now. Your final message is posted to the master as your reply (plain Korean, short).";
    const res = spawnSync("claude", ["-p", "--output-format", "json", "--max-turns", "80", "--permission-mode", "acceptEdits",
      "--allowedTools", "Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Bash(node:*),Bash(cp:*),Bash(rm:*),Bash(mkdir:*),Bash(ls:*),Bash(python3:*),Bash(git diff:*),Bash(git status:*)"],
      { input: prompt, encoding: "utf8", timeout: 35 * 60e3, maxBuffer: 64 * 1024 * 1024 });
    let out = null; try { out = JSON.parse(res.stdout); } catch { }
    rmSync(".dev-tmp", { recursive: true, force: true });
    if (!out || out.is_error) throw new Error(out?.result || res.stderr?.slice(-800) || "Claude did not finish");
    let reply = String(out.result || "").trim() || "작업을 마쳤어요.";

    // keep protected files exactly as they were
    const changed = sh("git status --porcelain").split("\n").filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, ""));
    const blocked = changed.filter(f => PROTECTED.some(r => r.test(f)));
    for (const f of blocked) { try { sh(`git checkout -- "${f}"`); } catch { rmSync(f, { force: true, recursive: true }); } }
    if (blocked.length) reply += "\n\n(보호된 파일은 바꾸지 않고 그대로 뒀어요.)";

    // never publish a broken app
    const files = ["index.html", ...(existsSync("draft/index.html") ? ["draft/index.html"] : [])];
    const ok = spawnSync("node", ["scripts/check-app.mjs", ...files], { encoding: "utf8" });
    if (ok.status !== 0) { sh("git checkout -- . && git clean -fdq -e node_modules"); throw new Error("앱 코드 검사에서 오류가 나서 바꾼 내용을 되돌렸어요.\n" + ok.stderr.slice(0, 600)); }

    if (sh("git status --porcelain")) {
      sh(`git add -A && git -c user.name="Claude (developer chat)" -c user.email="noreply@anthropic.com" commit -qm "개발자 채팅: ${queued[0].body.split("\n")[0].slice(0, 60).replace(/"/g, "'")}"`);
      sh("git push -q origin HEAD:main");
      try { sh(`gh api -X POST repos/${process.env.GITHUB_REPOSITORY}/pages/builds`); } catch { }
      reply += "\n\n(반영까지 1~2분 걸려요. 안 보이면 새로고침해 주세요.)";
    }
    await say(reply);
    await mark(ids, "done");
  } catch (e) {
    console.error(e);
    rmSync(".dev-tmp", { recursive: true, force: true });
    await say(`작업을 마치지 못했어요.\n${String(e.message || e).slice(0, 900)}\n\n다시 시도하려면 같은 내용을 한 번 더 보내 주세요.`, "info").catch(() => { });
    await mark(ids, "failed").catch(() => { });
    process.exitCode = 1;
  }
}

await (process.argv[2] === "check" ? check() : run());
