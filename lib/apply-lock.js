/**
 * apply 进程锁 / 阶段状态机 / restart-required 持久化。
 *
 * 为什么需要这一层：
 *   POST /dsh-purge/apply 之前没有任何重入保护。双击按钮、开两个标签、桌面端与
 *   Web 端同时点，就是两路并发跑完整条链：
 *     resolveOfficialAiBase（可能整包解包 175 MB）→ applyPatchesAllHosts → patchAllShims
 *   第二路的 commitExtractedDir 会把第一路的 ${destDir}.dshpurge-prev 改名成
 *   .dshpurge-prev-<ts>，回滚链当场断掉；两路同时打补丁时 bak 与 patch 交错写，
 *   产物可能是半旧半新的混合文件（reapply.js 的 refreshStaleBaksForUpgrade 注释里
 *   描述过这种混合文件会直接崩，但那里只处理症状，没堵住并发这个根因）。
 *
 * 锁的判定不能只看"文件存在"：宿主被 taskkill / 崩溃后锁文件会残留，
 * 所以同时看 pid 是否还活着 + startedAt 是否超过硬上限。硬上限给 60 分钟，
 * 因为 A 走整包解包路线，解包本身是分钟级的（B 的 fastpath 定 30 分钟，
 * 那个值在这里会误杀正在解包的进程）。
 *
 * 这个模块不 import core.js / index.js，避免与 extract-asar / reapply 形成环。
 */

import fs from "node:fs";
import path from "node:path";

export const APPLY_LOCK_NAME = "apply-in-flight.lock";
export const APPLY_PHASE_NAME = "apply-phase.json";
export const RESTART_REQUIRED_NAME = "restart-required.json";

/** 进行中的阶段，顺序即 apply 的推进顺序。 */
export const APPLY_PHASES_IN_FLIGHT = [
  "resolve",
  "extract",
  "commit",
  "revert",
  "apply",
  "shim",
  "cli-repair",
  "flash",
];

/** 全部合法阶段（含终态）。 */
export const APPLY_PHASES = ["idle", ...APPLY_PHASES_IN_FLIGHT, "done", "interrupted", "timeout-abandoned"];

/** 锁硬上限：超过这个时间还没结束，就当上一个进程已经死了。 */
export const APPLY_LOCK_STALE_MS = 60 * 60 * 1000;

/**
 * resolveOfficialAiBase 的整体上限。
 * 不能抄 B 的 120000 —— 那个值是 fastpath 路线定的（只翻 header，常数级）；
 * A 的 resolve 里裹着 renameAsarAside + extractAsarToSide + commitExtractedDir，
 * 整包解包实测 32 s ~ 十分钟级，120 秒会在正常解包时误杀。
 */
export const APPLY_RESOLVE_TIMEOUT_MS = 15 * 60 * 1000;

export function dataDir(home) {
  const h = String(home || "").trim();
  if (!h) return "";
  return path.join(h, "dsh-purge");
}

export function applyLockPath(home) {
  const dir = dataDir(home);
  return dir ? path.join(dir, APPLY_LOCK_NAME) : "";
}

export function applyPhasePath(home) {
  const dir = dataDir(home);
  return dir ? path.join(dir, APPLY_PHASE_NAME) : "";
}

export function restartRequiredPath(home) {
  const dir = dataDir(home);
  return dir ? path.join(dir, RESTART_REQUIRED_NAME) : "";
}

function readJsonSafe(fp) {
  if (!fp) return null;
  try {
    const raw = fs.readFileSync(fp, "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

function ensureDir(fp) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function writeJsonAtomic(fp, value) {
  if (!fp || !ensureDir(fp)) return false;
  const tmp = `${fp}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    try {
      fs.renameSync(tmp, fp);
    } catch {
      // Windows 上目标被占用时 rename 会 EBUSY，退一步直接覆盖写。
      fs.writeFileSync(fp, JSON.stringify(value, null, 2), "utf8");
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return false;
  }
}

/**
 * pid 是否还活着。
 * - 正整数才查；ESRCH = 不存在；EPERM = 存在但没权限（算活着）。
 * - pid 复用无法完全避免，所以调用方还要叠 startedAt 上限。
 */
export function applyLockPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    return false;
  }
}

/** 读阶段状态。没有文件就是 idle。 */
export function getApplyPhase(home) {
  const raw = readJsonSafe(applyPhasePath(home)) || {};
  return {
    phase: String(raw.phase || "idle"),
    note: String(raw.note || ""),
    updatedAt: String(raw.updatedAt || ""),
    startedMs: Number(raw.startedMs) || 0,
    previous: String(raw.previous || ""),
    pid: Number(raw.pid) || 0,
  };
}

/**
 * 写阶段。进入第一个 in-flight 阶段时记 startedMs，之后一路沿用，
 * 这样前端能算出"这次 apply 已经跑了多久"，而不是只看到一个瞬时阶段名。
 */
export function setApplyPhase(home, phase, note = "") {
  const fp = applyPhasePath(home);
  if (!fp) return { phase: String(phase || ""), note: String(note || "") };
  const prev = getApplyPhase(home);
  const name = String(phase || "");
  const carried = APPLY_PHASES_IN_FLIGHT.includes(prev.phase) ? prev.startedMs : 0;
  // 只有进行中的阶段带 startedMs；终态（done/interrupted/timeout-abandoned）归零，
  // 否则前端会把"已完成任务的开始时间"当成"还在跑多久"来算。
  const startedMs = APPLY_PHASES_IN_FLIGHT.includes(name) ? (carried || Date.now()) : 0;
  const payload = {
    phase: name,
    note: String(note || ""),
    updatedAt: new Date().toISOString(),
    startedMs,
    previous: prev.phase,
    pid: process.pid,
  };
  writeJsonAtomic(fp, payload);
  return payload;
}

/**
 * 检查锁。
 * held=true 表示"真的有人在跑"，调用方应当拒绝新的 apply。
 * stale=true 表示锁文件还在但主人已经没了，调用方可以接管。
 */
export function inspectApplyLock(home) {
  const fp = applyLockPath(home);
  const phase = getApplyPhase(home).phase;
  const base = {
    held: false,
    stale: false,
    reason: "",
    pid: 0,
    host: "",
    startedAt: "",
    ageMs: 0,
    phase,
    path: fp,
  };
  if (!fp || !fs.existsSync(fp)) return { ...base, reason: "no-lock" };
  const raw = readJsonSafe(fp);
  if (!raw) return { ...base, reason: "unreadable", stale: true };
  const pid = Number(raw.pid) || 0;
  const startedAt = String(raw.startedAt || "");
  const startedMs = Date.parse(startedAt) || 0;
  const ageMs = startedMs ? Date.now() - startedMs : 0;
  const alive = pid > 0 ? applyLockPidAlive(pid) : false;
  const expired = startedMs > 0 && ageMs > APPLY_LOCK_STALE_MS;
  let reason = "";
  if (!alive) reason = pid > 0 ? "pid-gone" : "no-pid";
  else if (expired) reason = "too-old";
  return {
    held: reason === "",
    stale: reason !== "",
    reason,
    pid,
    host: String(raw.host || ""),
    startedAt,
    ageMs,
    phase: String(raw.phase || phase),
    path: fp,
  };
}

/** 拿锁。调用方必须先 inspectApplyLock 确认没人持有。 */
export function writeApplyLock(home, host = "") {
  const fp = applyLockPath(home);
  if (!fp) return null;
  const payload = {
    pid: process.pid,
    host: typeof host === "string" ? host : String(host?.surface || ""),
    exe: process.execPath,
    startedAt: new Date().toISOString(),
    phase: getApplyPhase(home).phase,
  };
  writeJsonAtomic(fp, payload);
  return payload;
}

export function clearApplyLock(home) {
  const fp = applyLockPath(home);
  if (!fp) return false;
  try {
    fs.rmSync(fp, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 拿锁并进入 resolve 阶段。返回 { ok:false, lock } 表示别人正在跑。
 * 所有会写宿主文件的入口（HTTP apply、命令行 apply、boot 自动应用）都走这一个函数，
 * 才能保证锁的语义只有一份。
 */
export function acquireApplyLock(home, host = "") {
  const info = inspectApplyLock(home);
  if (info.held) return { ok: false, lock: info };
  if (info.stale) clearApplyLock(home);
  writeApplyLock(home, host);
  setApplyPhase(home, "resolve");
  return { ok: true, lock: inspectApplyLock(home) };
}

/**
 * 放锁。三种结局：
 *   true       正常跑完 → 清锁即可。
 *   "aborted"  干净中止（缺 aiBase、提示词没准备、用户取消）→ 一个字节都没写，
 *              阶段回 idle，不留 restart-required，别把"没开始"报成"半途崩了"。
 *   false      抛异常 → 阶段留在原地并置 restart-required，让 boot 兜。
 */
export function releaseApplyLock(home, outcome) {
  clearApplyLock(home);
  if (outcome === true) return { released: true, interrupted: false, aborted: false };
  const cur = getApplyPhase(home);
  if (outcome === "aborted") {
    setApplyPhase(home, "idle", "apply 中止（未写宿主文件）");
    return { released: true, interrupted: false, aborted: true, phase: cur.phase };
  }
  // timeout-abandoned 保留原阶段名：那是比 interrupted 更具体的诊断信息。
  if (cur.phase === "timeout-abandoned") return { released: true, interrupted: false, aborted: false, phase: cur.phase };
  setApplyPhase(home, "interrupted", "apply 异常退出");
  setRestartRequired(home, true, `清洗在 ${cur.phase} 阶段中断`);
  return { released: true, interrupted: true, aborted: false, phase: cur.phase };
}

/**
 * 启动时收拾上一轮留下的锁。
 * - pid 还活着：另一个宿主可能正在跑，一律不动。
 * - 已经死了：锁文件改名留证据（.stale-<ts>.json，别直接删，出问题时能查是谁什么时候跑的），
 *   并且如果当时停在 in-flight 阶段，把阶段标成 interrupted、置 restart-required。
 */
export function sweepApplyLockAtBoot(home) {
  const fp = applyLockPath(home);
  if (!fp || !fs.existsSync(fp)) return { swept: false, reason: "no-lock" };
  const info = inspectApplyLock(home);
  if (info.held) return { swept: false, reason: "live-lock-held", lock: info };
  const aside = `${fp}.stale-${Date.now()}.json`;
  let kept = "";
  try {
    fs.renameSync(fp, aside);
    kept = aside;
  } catch {
    try { fs.rmSync(fp, { force: true }); } catch { /* best effort */ }
  }
  const phase = getApplyPhase(home).phase;
  let marked = null;
  if (APPLY_PHASES_IN_FLIGHT.includes(phase)) {
    marked = setApplyPhase(home, "interrupted", `boot: ${info.reason}`);
    setRestartRequired(home, true, `上一次清洗停在 ${phase} 阶段，宿主可能处于半旧半新状态`);
  }
  return { swept: true, kept, interruptedPhase: marked ? phase : "", lock: info };
}

/**
 * 锁不在、但阶段还停在 in-flight —— 说明上一轮 apply 是异常退出的（比如宿主崩了），
 * 标成 interrupted 并把 restart-required 打开，让界面能提示"可能需要重跑一次清洗"。
 */
export function reconcileApplyPhaseOnStartup(home) {
  const info = inspectApplyLock(home);
  if (info.held) return { reconciled: false, reason: "apply-in-flight" };
  const cur = getApplyPhase(home);
  if (!APPLY_PHASES_IN_FLIGHT.includes(cur.phase)) return { reconciled: false, reason: "no-in-flight-phase" };
  setApplyPhase(home, "interrupted", `boot: phase ${cur.phase} left without lock`);
  setRestartRequired(home, true, `上一次清洗停在 ${cur.phase} 阶段，宿主可能处于半旧半新状态`);
  return { reconciled: true, from: cur.phase };
}

export function setRestartRequired(home, flag, reason = "") {
  const fp = restartRequiredPath(home);
  if (!flag) {
    if (!fp) return { restartRequired: false };
    try { fs.rmSync(fp, { force: true }); } catch { /* best effort */ }
    return { restartRequired: false };
  }
  const payload = {
    restartRequired: true,
    reason: String(reason || ""),
    at: new Date().toISOString(),
    pid: process.pid,
  };
  writeJsonAtomic(fp, payload);
  return payload;
}

export function readRestartRequiredSafe(home) {
  const raw = readJsonSafe(restartRequiredPath(home));
  if (!raw || raw.restartRequired !== true) return null;
  return {
    restartRequired: true,
    reason: String(raw.reason || ""),
    at: String(raw.at || ""),
  };
}

export function clearRestartRequired(home) {
  return setRestartRequired(home, false);
}

/**
 * 只给 Promise 加一个观察用的超时守卫。
 *
 * 重要：这**不会中止**原来的事情。JS 里 Promise 无法取消，超时之后
 * resolveOfficialAiBase 的解包很可能仍在磁盘上继续跑。所以超时只代表
 * "前端不再等了"，调用方必须把阶段标成 timeout-abandoned 并要求人工确认，
 * 不能当成"已中止"然后自动重试 —— 那样就是两路并发解包。
 */
export function withTimeout(promise, ms, label = "apply") {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  // 旁路 catch：race 输掉之后原 promise 再 reject 不会变成 unhandledRejection。
  if (promise && typeof promise.catch === "function") void promise.catch(() => {});
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} 超时（${ms} ms），后台可能仍在继续`);
      error.code = "ETIMEDOUT";
      error.label = label;
      error.timeoutMs = ms;
      error.abandoned = true;
      reject(error);
    }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 同一个 fn 在飞行中时复用同一个 Promise。
 *
 * 给「只读且幂等」的调用用（比如前端 2 秒一次的 gatherState）：两次请求叠在
 * 一起时没必要把盘上同一份事实解两遍。**不要**包写操作 —— 复用的结果会被后
 * 一个调用方当成自己那次执行的结果。
 */
export function createSingleFlight(fn) {
  let current = null;
  const wrapped = (...args) => {
    if (current) return current;
    const run = Promise.resolve()
      .then(() => fn(...args))
      .finally(() => {
        if (current === run) current = null;
      });
    current = run;
    return run;
  };
  wrapped.inFlight = () => Boolean(current);
  return wrapped;
}

/**
 * 等 promise 最多 ms；超时就把手里那份旧的顶上去，并标 stale。
 *
 * 场景是状态轮询：点「应用」时后端在同步落盘，`gatherState` 能被磁盘 IO 拖到
 * 分钟级，前端等到自己的超时就是一句「读取失败: timeout」——可那时候补丁正在
 * 正常写，界面等于在报假警。所以这里宁可用一份旧快照顶上，也要明确告诉调用方
 * 「这份是旧的」。
 *
 * 没有 fallback（首次加载）时不假装成功，错误照原样抛出去。
 *
 * @returns {Promise<{value: any, stale: boolean, error?: Error}>}
 */
export async function settleWithin(promise, { ms, fallback = null, label = "status" } = {}) {
  const hasFallback = fallback !== null && fallback !== undefined;
  // 旁路 catch：race 输掉之后原 promise 再 reject 不会变成 unhandledRejection。
  if (promise && typeof promise.catch === "function") void promise.catch(() => {});
  if (!Number.isFinite(ms) || ms <= 0) return { value: await promise, stale: false };
  try {
    const value = await withTimeout(promise, ms, label);
    return { value, stale: false };
  } catch (error) {
    if (!hasFallback) throw error;
    return { value: fallback, stale: true, error };
  }
}

