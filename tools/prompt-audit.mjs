#!/usr/bin/env node
// 宿主系统提示词的形态审计 + 连跑稳定性。
//
//   node tools/prompt-audit.mjs                 跑内置 fixtures 并与 expected.json 比对
//   node tools/prompt-audit.mjs --self-check    同上，供 scripts/run-tests.mjs 调用
//   node tools/prompt-audit.mjs --dir="...\resources"   审计真宿主（自动找两份候选文件）
//   node tools/prompt-audit.mjs --dir=... --runs=5      连跑 5 轮，检查判决是否会抖
//   node tools/prompt-audit.mjs --json          机器可读
//
// 判决只读文件文本，不启动宿主、不调模型 —— 所以它能进 CI。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judgePromptFile, summarizeVerdicts } from "../lib/prompt-verdict.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixtureDir = path.join(root, "test", "fixtures", "prompt");

const argv = process.argv.slice(2);
const opt = (name, fallback = "") => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const json = flag("json");
const dir = opt("dir");
const runs = Math.max(1, Number(opt("runs", "1")) || 1);

/** 与 desktop.js:systemPromptFiles 保持一致。 */
function candidateFiles(base) {
  const out = [
    path.join(base, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
    path.join(base, "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"),
  ];
  // 允许直接传 resources/app
  const abs = path.resolve(base);
  if (path.basename(abs) === "app") return out;
  return out;
}

function fixtureCases() {
  const expectedPath = path.join(fixtureDir, "expected.json");
  let expected = {};
  try {
    expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  } catch (error) {
    return { cases: [], error: `读不到 ${expectedPath}: ${error.message}` };
  }
  const cases = Object.keys(expected).map((name) => ({
    name,
    file: path.join(fixtureDir, name),
    expect: expected[name],
  }));
  return { cases };
}

function hostCases(base) {
  const files = candidateFiles(base);
  const existing = files.filter((fp) => {
    try { return fs.statSync(fp).isFile(); } catch { return false; }
  });
  if (existing.length === 0) {
    return { cases: [], error: `在 ${path.resolve(base)} 下没找到 dsh-system-prompt 模块；找过：\n  ${files.join("\n  ")}` };
  }
  return { cases: existing.map((fp) => ({ name: path.relative(base, fp), file: fp, expect: "clean" })) };
}

function auditOnce(cases) {
  return cases.map((c) => {
    const result = judgePromptFile(fs, c.file);
    return { ...c, result };
  });
}

const source = dir ? hostCases(dir) : fixtureCases();
if (source.error) {
  console.error(source.error);
  process.exit(1);
}
const { cases } = source;

// 连跑：每一轮都重新读、重新判，看判决是否会抖。
const rounds = [];
for (let i = 0; i < runs; i += 1) rounds.push(auditOnce(cases));

const first = rounds[0];
const unstable = [];
for (const c of cases) {
  const verdicts = rounds.map((r) => {
    const hit = r.find((x) => x.name === c.name);
    return hit ? hit.result.verdict : "missing";
  });
  if (new Set(verdicts).size > 1) unstable.push({ name: c.name, verdicts });
}

const mismatched = first.filter((row) => row.result.verdict !== row.expect);
const summary = summarizeVerdicts(first.map((row) => row.result));

if (json) {
  console.log(JSON.stringify({
    source: dir ? path.resolve(dir) : "fixtures",
    runs,
    rows: first.map((row) => ({
      name: row.name,
      expect: row.expect,
      verdict: row.result.verdict,
      reasonCode: row.result.reasonCode,
      reason: row.result.reason,
      hits: row.result.hits,
    })),
    summary,
    unstable,
    ok: mismatched.length === 0 && unstable.length === 0,
  }, null, 2));
} else {
  console.log(`prompt audit · ${dir ? path.resolve(dir) : "fixtures"} · ${cases.length} 个文件 · ${runs} 轮`);
  const width = Math.max(...first.map((row) => row.name.length), 4);
  for (const row of first) {
    const got = row.result.verdict;
    const tag = got === row.expect ? "ok  " : "FAIL";
    console.log(`  ${tag} ${got.padEnd(10)} ${row.name.padEnd(width)}  ${row.result.reason}`);
    if (got !== row.expect) console.log(`        期望 ${row.expect}`);
    if (row.result.hits.length) console.log(`        命中：${row.result.hits.join(" | ")}`);
  }
  console.log(`\n合计：clean ${summary.counts.clean} · dirty ${summary.counts.dirty} · foreign ${summary.counts.foreign} · unreadable ${summary.counts.unreadable}`);
  if (runs > 1) {
    console.log(unstable.length === 0
      ? `稳定性：${runs} 轮判决完全一致`
      : `稳定性：${unstable.length} 个文件判决抖动`);
    for (const u of unstable) console.log(`  ${u.name}: ${u.verdicts.join(" → ")}`);
  }
}

const failed = mismatched.length > 0 || unstable.length > 0;
if (failed) {
  console.log("\nFAILED");
  process.exit(1);
}
console.log("\nALL PASS");
