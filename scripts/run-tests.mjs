#!/usr/bin/env node
// 零依赖测试 runner。
//
//   node scripts/run-tests.mjs                 跑 test/ 下全部 *.test.mjs
//   node scripts/run-tests.mjs --filter=lock   只跑文件名匹配的
//   node scripts/run-tests.mjs --mode=all      额外跑 tools/prompt-audit.mjs 的自检
//   node scripts/run-tests.mjs --verbose       打印每条断言
//
// 约定：测试文件 `export default async (t) => {...}`，t 由这里注入，不 import 任何东西。
// 任何一条断言失败或文件 import 失败 → 退出码 1。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const testDir = path.join(root, "test");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = "") => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const filter = opt("filter");
const mode = opt("mode", "build");
const verbose = flag("verbose");

function createHarness(file) {
  const rows = [];
  const rel = path.relative(root, file);
  const record = (name, status, detail = "") => {
    rows.push({ name, status, detail });
    if (verbose || status === "fail") {
      const tag = status === "ok" ? "ok  " : status === "skip" ? "skip" : "FAIL";
      console.log(`  ${tag} ${name}${detail ? `  — ${detail}` : ""}`);
    }
  };
  return {
    rows,
    /** 一条断言。 */
    ok(name, cond, detail = "") {
      record(name, cond ? "ok" : "fail", cond ? "" : detail);
      return Boolean(cond);
    },
    /** 值相等（严格 ===）。 */
    eq(name, got, want) {
      const same = got === want;
      record(name, same ? "ok" : "fail", same ? "" : `got=${short(got)} want=${short(want)}`);
      return same;
    },
    /** 抛错，可指定 error.code 或消息片段。 */
    throws(name, fn, match = "") {
      let caught = null;
      try { fn(); } catch (error) { caught = error; }
      if (!caught) return record(name, "fail", "没有抛错"), false;
      if (match && !`${caught.code || ""} ${caught.message || caught}`.includes(match)) {
        record(name, "fail", `抛的是 ${short(caught.code || caught.message)},匹配 ${JSON.stringify(match)} 失败`);
        return false;
      }
      record(name, "ok");
      return true;
    },
    /** 异步抛错。 */
    async rejects(name, fn, match = "") {
      let caught = null;
      try { await fn(); } catch (error) { caught = error; }
      if (!caught) return record(name, "fail", "没有抛错"), false;
      if (match && !`${caught.code || ""} ${caught.message || caught}`.includes(match)) {
        record(name, "fail", `抛的是 ${short(caught.code || caught.message)},匹配 ${JSON.stringify(match)} 失败`);
        return false;
      }
      record(name, "ok");
      return true;
    },
    /** 分组：整组内抛错记成一条 fail，不中断后续用例。 */
    async group(name, fn) {
      try {
        await fn();
        record(name, "ok");
        return true;
      } catch (error) {
        record(name, "fail", error && error.message || String(error));
        return false;
      }
    },
    skip(name, why = "") {
      record(name, "skip", why);
    },
  };
}

function short(value) {
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}...` : value;
  try {
    const s = JSON.stringify(value);
    return s && s.length > 80 ? `${s.slice(0, 77)}...` : s;
  } catch {
    return String(value);
  }
}

async function runFiles() {
  if (!fs.existsSync(testDir)) {
    console.error(`没有测试目录：${testDir}`);
    return { ok: 0, fail: 1, skip: 0, files: 0 };
  }
  const files = fs.readdirSync(testDir)
    .filter((n) => n.endsWith(".test.mjs"))
    .filter((n) => !filter || n.includes(filter))
    .sort()
    .map((n) => path.join(testDir, n));

  let ok = 0;
  let fail = 0;
  let skip = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    console.log(`\n${rel}`);
    const started = Date.now();
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (error) {
      console.log(`  FAIL 加载失败 — ${error && error.message || error}`);
      fail += 1;
      continue;
    }
    const run = mod && mod.default;
    if (typeof run !== "function") {
      console.log("  FAIL 没有 default export 函数");
      fail += 1;
      continue;
    }
    const t = createHarness(file);
    try {
      await run(t);
    } catch (error) {
      t.ok("整体执行未抛错", false, error && error.message || String(error));
    }
    const counts = t.rows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});
    ok += counts.ok || 0;
    fail += counts.fail || 0;
    skip += counts.skip || 0;
    const ms = Date.now() - started;
    console.log(`  → ${counts.ok || 0} ok, ${counts.fail || 0} fail, ${counts.skip || 0} skip (${ms}ms)`);
  }
  return { ok, fail, skip, files: files.length };
}

/** 跑一个 --self-check 型的审计脚本，返回 ok/fail 计数。 */
function runAudit(name, script, args) {
  if (!fs.existsSync(script)) {
    console.log(`\n[audit] ${path.relative(root, script)} 不存在，跳过`);
    return { ok: 0, fail: 0 };
  }
  console.log(`\n[audit] ${path.relative(root, script)} ${args.join(" ")}`);
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (proc.status === 0) return { ok: 1, fail: 0 };
  console.log(`  FAIL ${name} 自检未通过`);
  return { ok: 0, fail: 1 };
}

function runAuditSelfChecks() {
  const a = runAudit("prompt-audit", path.join(root, "tools", "prompt-audit.mjs"), ["--self-check", "--runs=3"]);
  const b = runAudit("refusal-audit", path.join(root, "tools", "refusal-audit.mjs"), ["--self-check"]);
  return { ok: a.ok + b.ok, fail: a.fail + b.fail };
}

const summary = await runFiles();
let extra = { ok: 0, fail: 0 };
if (mode === "all") extra = runAuditSelfChecks();

const totalOk = summary.ok + extra.ok;
const totalFail = summary.fail + extra.fail;
console.log(`\n${"-".repeat(48)}`);
console.log(`${summary.files} 个文件 · ${totalOk} 通过 · ${totalFail} 失败 · ${summary.skip} 跳过`);
if (totalFail > 0) {
  console.log("FAILED");
  process.exit(1);
}
if (summary.files === 0) {
  console.log("没有可跑的用例");
  process.exit(1);
}
console.log("ALL PASS");
