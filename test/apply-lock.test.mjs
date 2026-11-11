// apply 锁 / 阶段机 / restart-required / withTimeout / single-flight 的语义。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as L from "../lib/apply-lock.js";

export default async function (t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-lock-"));
  try {
    // 1. 初始无锁
    let info = L.inspectApplyLock(home);
    t.ok("初始无锁", info.held === false && info.reason === "no-lock", JSON.stringify(info));

    // 2. 本进程拿锁
    L.writeApplyLock(home, "web");
    info = L.inspectApplyLock(home);
    t.ok("自己持锁 held 且不 stale", info.held === true && info.stale === false && info.pid === process.pid, JSON.stringify(info));
    t.eq("锁文件落在 data dir 下", info.path, path.join(home, "dsh-purge", L.APPLY_LOCK_NAME));

    // 3. 放锁
    L.clearApplyLock(home);
    info = L.inspectApplyLock(home);
    t.ok("放锁后回到 no-lock", info.held === false && info.reason === "no-lock");

    // 4. 死 pid → stale
    fs.mkdirSync(L.dataDir(home), { recursive: true });
    fs.writeFileSync(
      L.applyLockPath(home),
      JSON.stringify({ pid: 999999, host: "web", startedAt: new Date().toISOString(), phase: "apply" }),
      "utf8",
    );
    info = L.inspectApplyLock(home);
    t.ok("死 pid 判 stale/pid-gone", info.stale === true && info.held === false && info.reason === "pid-gone", JSON.stringify(info));

    // 5. 超龄锁 → stale
    L.setApplyPhase(home, "apply");
    fs.writeFileSync(
      L.applyLockPath(home),
      JSON.stringify({ pid: process.pid, host: "web", startedAt: new Date(Date.now() - 7200000).toISOString(), phase: "apply" }),
      "utf8",
    );
    info = L.inspectApplyLock(home);
    t.ok("超过 STALE 上限判 too-old", info.stale === true && info.reason === "too-old", JSON.stringify(info));

    // 6. boot sweep：挪走 stale 锁留证据 + 阶段 interrupted + restart-required
    const swept = L.sweepApplyLockAtBoot(home);
    t.ok("sweep 报告已清扫", swept.swept === true, JSON.stringify(swept));
    t.ok("sweep 留了证据文件", Boolean(swept.kept) && fs.existsSync(swept.kept), swept.kept);
    t.ok("sweep 移走了锁", !fs.existsSync(L.applyLockPath(home)));
    t.eq("阶段变 interrupted", L.getApplyPhase(home).phase, "interrupted");
    const rr = L.readRestartRequiredSafe(home);
    t.ok("restart-required 置位", Boolean(rr) && rr.restartRequired === true, JSON.stringify(rr));

    // 7. reconcile：锁不在但阶段仍在飞行中 → interrupted
    L.setApplyPhase(home, "extract");
    const rec = L.reconcileApplyPhaseOnStartup(home);
    t.ok("reconcile 纠正飞行中阶段", rec.reconciled === true && rec.from === "extract", JSON.stringify(rec));

    // 8. 阶段推进保留 startedMs，终态归零
    L.clearRestartRequired(home);
    L.setApplyPhase(home, "resolve");
    const t0 = L.getApplyPhase(home).startedMs;
    await new Promise((r) => setTimeout(r, 15));
    L.setApplyPhase(home, "apply");
    const t1 = L.getApplyPhase(home).startedMs;
    t.ok("startedMs 跨阶段保留", t0 > 0 && t0 === t1, `${t0} vs ${t1}`);
    L.setApplyPhase(home, "done");
    t.eq("终态清空 startedMs", L.getApplyPhase(home).startedMs, 0);
    t.ok("restart-required 已清", L.readRestartRequiredSafe(home) === null);

    // 9. acquire / release 三态
    const gate = L.acquireApplyLock(home, "web");
    t.ok("能拿到锁", gate.ok === true, JSON.stringify(gate));
    t.eq("拿锁后阶段进入 resolve", L.getApplyPhase(home).phase, "resolve");
    const second = L.acquireApplyLock(home, "cli");
    t.ok("第二次拿锁被拒", second.ok === false, JSON.stringify(second));
    L.releaseApplyLock(home, "aborted");
    t.eq("aborted 回 idle", L.getApplyPhase(home).phase, "idle");
    t.ok("aborted 不置 restart-required", L.readRestartRequiredSafe(home) === null);

    L.acquireApplyLock(home, "web");
    L.releaseApplyLock(home, false);
    t.eq("异常退出标 interrupted", L.getApplyPhase(home).phase, "interrupted");
    const rr2 = L.readRestartRequiredSafe(home);
    t.ok("异常退出置 restart-required", Boolean(rr2) && rr2.restartRequired === true, JSON.stringify(rr2));

    // 成功路径由调用方自己推阶段，release(true) 只放锁、不覆盖阶段。
    L.clearRestartRequired(home);
    L.acquireApplyLock(home, "web");
    L.setApplyPhase(home, "done");
    L.releaseApplyLock(home, true);
    t.eq("正常完成后阶段保持 done", L.getApplyPhase(home).phase, "done");
    t.ok("正常完成不置 restart-required", L.readRestartRequiredSafe(home) === null);
    t.ok("正常完成后锁已释放", L.inspectApplyLock(home).held === false);

    // 10. timeout-abandoned 不被 interrupted 覆盖
    L.acquireApplyLock(home, "web");
    L.setApplyPhase(home, "timeout-abandoned", "定位官方目录超时");
    L.releaseApplyLock(home, false);
    t.eq("timeout-abandoned 保持原样", L.getApplyPhase(home).phase, "timeout-abandoned");

    // 11. withTimeout
    const slow = new Promise((r) => setTimeout(() => r("late"), 200));
    await t.rejects("超时抛 ETIMEDOUT/abandoned", async () => {
      await L.withTimeout(slow, 20, "demo");
    }, "ETIMEDOUT");
    t.eq("快 promise 直通", await L.withTimeout(Promise.resolve(42), 200, "fast"), 42);
    t.eq("ms<=0 直通", await L.withTimeout(Promise.resolve(7), 0), 7);

    // 12. createSingleFlight：飞行中复用同一个 Promise，落地后复位
    let calls = 0;
    const single = L.createSingleFlight(async (n) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return n * 2;
    });
    const [a, b] = await Promise.all([single(2), single(3)]);
    t.ok("飞行中请求被合并", calls === 1 && a === 4 && b === 4, `calls=${calls} a=${a} b=${b}`);
    t.ok("合并时不报自己在飞", single.inFlight() === true || calls === 1);
    t.ok("落地后 inFlight 复位", single.inFlight() === false);
    const c = await single(5);
    t.ok("再次调用会重新执行", calls === 2 && c === 10, `calls=${calls} c=${c}`);
    const boom = L.createSingleFlight(async () => { throw new Error("nope"); });
    await t.rejects("抛错也会把 Promise 传出去", async () => { await boom(); }, "nope");
    t.ok("抛错后仍能复位", boom.inFlight() === false);

    // 13. settleWithin：等不到就用旧快照顶上，并标 stale
    const swFast = await L.settleWithin(Promise.resolve("fresh"), { ms: 500, fallback: "old" });
    t.ok("正常返回不算 stale", swFast.stale === false && swFast.value === "fresh");
    const swSlow = new Promise((r) => setTimeout(() => r("late"), 200));
    const swFell = await L.settleWithin(swSlow, { ms: 20, fallback: "old" });
    t.ok("超时用 fallback 顶上", swFell.stale === true && swFell.value === "old", JSON.stringify(swFell.value));
    t.eq("超时会带上 ETIMEDOUT", swFell.error && swFell.error.code, "ETIMEDOUT");
    await t.rejects("没有 fallback 时不假装成功", async () => {
      await L.settleWithin(new Promise((r) => setTimeout(() => r(1), 200)), { ms: 20 });
    }, "ETIMEDOUT");
    const swBoom = await L.settleWithin(Promise.reject(new Error("disk-gone")), { ms: 500, fallback: "old" });
    t.ok("promise 自己 reject 也算 stale", swBoom.stale === true && swBoom.value === "old");
    t.eq("reject 的原因保留", swBoom.error && swBoom.error.message, "disk-gone");
    t.eq("ms 非法时直通", (await L.settleWithin(Promise.resolve(9), { ms: 0, fallback: "old" })).value, 9);

    // 14. 空 home 不炸
    t.ok("空 home 安全", L.inspectApplyLock("").held === false && L.getApplyPhase("").phase === "idle");
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
