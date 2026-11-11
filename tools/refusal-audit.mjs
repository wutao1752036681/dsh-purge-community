#!/usr/bin/env node
// 拒绝回归审计。离线回放已录制的回答，判定四态分布并与基准线比对。
//
//   node tools/refusal-audit.mjs                 跑 test/fixtures/refusal 下全部样本
//   node tools/refusal-audit.mjs --self-check    同上，但任何一条不一致即退出码 1（CI 用）
//   node tools/refusal-audit.mjs --dir=<dir>     指定样本目录
//   node tools/refusal-audit.mjs --json          只输出 JSON
//   node tools/refusal-audit.mjs --live          真调模型（需要宿主在跑 + key），不进 CI
//
// 为什么离线优先：真调模型要宿主暴露 llm 服务 + API key，CI 里跑不了，而且
// 限流/鉴权失败会被误记成拒答。回放样本锁定的是「判定器」这个纯函数的行为 ——
// 判定器漂移会立刻暴露，这才是回归的本意。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const { summarizeTurns, compareToBaseline, judgeReplay, validateCase, isRefusal } = await import(
  new URL("../lib/refusal-judge.js", import.meta.url).href
);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = "") => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const selfCheck = flag("self-check");
const asJson = flag("json");
const live = flag("live");
const dir = path.resolve(root, opt("dir", path.join("test", "fixtures", "refusal")));

function say(line) {
  if (!asJson) console.log(line);
}

/* ---------- --live：留给真人带 key 手动跑，没配置就安静跳过 ---------- */

async function runLive() {
  const url = process.env.DSH_REFUSAL_LIVE_URL || "";
  const token = process.env.DSH_REFUSAL_LIVE_TOKEN || "";
  if (!url) {
    say("[live] 跳过：没有设置 DSH_REFUSAL_LIVE_URL。");
    say("       真调模型要宿主在跑且暴露 llm 服务，这里不替你启动，也不写默认地址。");
    say("       用法：DSH_REFUSAL_LIVE_URL=http://127.0.0.1:PORT/dsh-purge/refusal node tools/refusal-audit.mjs --live");
    return 0;
  }
  /* 真调模型的分支需要宿主侧的 refusal 路由，本仓库的 P0/P1 范围里没有它。
     这里只把「该往哪打、要什么头」写清楚，不假装跑过。 */
  say(`[live] 目标 ${url}`);
  say("[live] 该路由不在 P0/P1 范围内，本版没有可调用的实现。");
  say("       判定语义已经抽到 lib/refusal-judge.js，宿主侧只要按 {answer,error} 回吐即可复用。");
  if (token) say("[live] 已读到 DSH_REFUSAL_LIVE_TOKEN（不打印内容）。");
  return 0;
}

/* ---------- 提示词自审：我们自己的提示词里不许有可抄的拒绝原句 ----------
 *
 * 这是 B 在 t7 事故里用三次真机采样换来的教训：提示词里写了一句拒绝原话，
 * 模型就会逐字照抄它（「它以为在遵守提示词」）。所以提示词自身也要过一遍
 * 拒答判定 —— 不是判模型，是判我们交给模型的那段文本。
 *
 * 用 meta 模式（段落级元讨论豁免）：禁用清单整段都在「谈论」这些句式，
 * 段首的 `Do not use these strings…` / `banned-refusal list…` 就是标记。
 */

function extractPresetPrefix(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*prefix:\s*[|>]/.test(line));
  if (start < 0) return "";
  const indentOf = (line) => (line.match(/^\s*/) || [""])[0].length;
  const baseIndent = indentOf(lines[start]);
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) { out.push(""); continue; }
    if (indentOf(line) <= baseIndent) break;
    out.push(line);
  }
  return out.join("\n");
}

function auditPromptSelf() {
  const targets = [];

  const promptSrc = path.join(root, "lib", "default-prompt-inject.md");
  if (fs.existsSync(promptSrc)) {
    const text = fs.readFileSync(promptSrc, "utf8");
    const result = isRefusal(text, { meta: true });
    targets.push({
      name: "lib/default-prompt-inject.md",
      chars: text.length,
      status: result.matches.length ? "fail" : "ok",
      matches: result.matches,
    });
  } else {
    // 源 md 被 .gitignore 排除（嵌入前原文不入库），干净 checkout 里本来就没有。
    targets.push({
      name: "lib/default-prompt-inject.md",
      status: "skipped",
      reason: "source-not-present",
      matches: [],
    });
  }

  const presetPath = path.join(root, "presets", "redteam", "agent.cordis.yml");
  if (fs.existsSync(presetPath)) {
    const prefix = extractPresetPrefix(fs.readFileSync(presetPath, "utf8"));
    if (!prefix.trim()) {
      targets.push({ name: "presets/redteam/agent.cordis.yml#prefix", status: "skipped", reason: "no-prefix-block", matches: [] });
    } else {
      const result = isRefusal(prefix, { meta: true });
      targets.push({
        name: "presets/redteam/agent.cordis.yml#prefix",
        chars: prefix.length,
        status: result.matches.length ? "fail" : "ok",
        matches: result.matches,
      });
    }
  } else {
    targets.push({ name: "presets/redteam/agent.cordis.yml#prefix", status: "skipped", reason: "file-not-present", matches: [] });
  }

  return { targets, failed: targets.filter((t) => t.status === "fail").length };
}

/* ---------- 离线回放 ---------- */

function loadFixtures(baseDir) {
  if (!fs.existsSync(baseDir)) return { files: [], cases: [], baseline: {}, liveBaseline: {} };
  const files = fs.readdirSync(baseDir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => path.join(baseDir, n));
  const cases = [];
  const flats = [];
  let liveBaseline = {};
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`${path.relative(root, file)} 不是合法 JSON：${error.message}`);
    }
    for (const item of doc.cases || []) {
      cases.push({ ...item, __file: path.relative(root, file) });
    }
    const b = doc.baseline || {};
    const { live: livePart, ...flat } = b;
    flats.push(flat);
    if (livePart && typeof livePart === "object") liveBaseline = { ...liveBaseline, ...livePart };
  }
  /* 多份样本文件时取最严的那条：下限取最大，上限取最小。 */
  const foldMax = (key) => {
    const vals = flats.map((x) => x[key]).filter((v) => Number.isFinite(v));
    return vals.length ? Math.max(...vals) : undefined;
  };
  const foldMin = (key) => {
    const vals = flats.map((x) => x[key]).filter((v) => Number.isFinite(v));
    return vals.length ? Math.min(...vals) : undefined;
  };
  const baseline = {
    minAccuracy: foldMax("minAccuracy"),
    minCases: foldMax("minCases"),
    minPassRate: foldMax("minPassRate"),
    minAnswered: foldMax("minAnswered"),
    maxEmpty: foldMin("maxEmpty"),
    maxErrored: foldMin("maxErrored"),
  };
  for (const key of Object.keys(baseline)) {
    if (baseline[key] === undefined) delete baseline[key];
  }
  return { files, cases, baseline, liveBaseline };
}

async function runReplay() {
  let loaded;
  try {
    loaded = loadFixtures(dir);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const { files, cases, baseline, liveBaseline } = loaded;
  if (!cases.length) {
    say(`没有样本：${path.relative(root, dir)}`);
    return selfCheck ? 1 : 0;
  }

  const malformed = [];
  for (const item of cases) {
    const problems = validateCase(item);
    if (problems.length) malformed.push({ id: item.id || "(无 id)", problems });
  }

  const summary = summarizeTurns(cases);
  const replay = judgeReplay(cases, summary);
  const mismatch = replay.mismatched;
  const verdict = compareToBaseline(summary, baseline, replay);
  const selfAudit = auditPromptSelf();

  const report = {
    dir: path.relative(root, dir),
    files: files.map((f) => path.relative(root, f)),
    total: summary.total,
    ok: summary.ok,
    refused: summary.refused,
    empty: summary.empty,
    errored: summary.errored,
    answered: summary.answered,
    passRate: summary.passRate,
    judged: replay.judged,
    matched: replay.matched,
    accuracy: replay.accuracy,
    baseline,
    liveBaseline,
    baselineOk: verdict.ok,
    baselineReasons: verdict.reasons,
    mismatches: mismatch,
    malformed,
    promptSelfAudit: selfAudit.targets,
    promptSelfFailed: selfAudit.failed,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    say(`回放：${report.files.join(", ") || "(空)"}`);
    say(`样本 ${report.total} 条 → ok ${report.ok} / refused ${report.refused} / empty ${report.empty} / errored ${report.errored}`);
    say(`判定一致 ${report.matched}/${report.judged}，准确率 ${(report.accuracy * 100).toFixed(1)}%  ` +
        `（基准 ≥ ${(baseline.minAccuracy ?? 0) * 100}%，样本 ≥ ${baseline.minCases ?? 0} 条）`);
    say(`分布仅供参考：已测到 ${report.answered} 轮；真调模型时才看通过率 ${(report.passRate * 100).toFixed(1)}%`);
    for (const row of mismatch) {
      say(`  FAIL ${row.id}  期望 ${row.want} 实际 ${row.got}` +
          `${row.hit ? `  命中 ${row.hit}` : ""}`);
      const idx = cases.findIndex((c) => c.id === row.id);
      if (idx >= 0) say(`       回答片段：${JSON.stringify(String(cases[idx].answer || "").slice(0, 90))}`);
    }
    for (const row of malformed) {
      say(`  FAIL ${row.id}  样本形状不合法：${row.problems.join(", ")}`);
    }
    if (verdict.reasons.length) {
      for (const reason of verdict.reasons) say(`  FAIL 基准线：${reason}`);
    }
    say("提示词自审（meta 段落级豁免）：");
    for (const row of selfAudit.targets) {
      if (row.status === "ok") say(`  OK   ${row.name}  ${row.chars} 字符，0 命中`);
      else if (row.status === "skipped") say(`  SKIP ${row.name}  ${row.reason}`);
      else say(`  FAIL ${row.name}  ${row.chars} 字符，命中 ${row.matches.join(", ")}`);
    }
    const clean = verdict.ok && !mismatch.length && !malformed.length && !selfAudit.failed;
    say(clean ? "REFUSAL REPLAY OK" : "REFUSAL REPLAY FAILED");
  }

  const bad = mismatch.length + malformed.length + (verdict.ok ? 0 : 1) + selfAudit.failed;
  if (selfCheck) return bad === 0 ? 0 : 1;
  return 0;
}

const code = live ? await runLive() : await runReplay();
process.exit(code);
