import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

// ── 为什么这里是内联副本 ─────────────────────────────────────────────────
// lib/desktop.js 的 scheduleCleanupRestart() 会 fs.copyFileSync 把本文件复制到
// os.tmpdir() 下再 spawn，那个目录里没有 extract-asar.js / delete-guard.js，
// 相对 import 会直接 ERR_MODULE_NOT_FOUND。所以这两段必须自包含。
// 权威实现分别是 lib/extract-asar.js:preserveExistingAsarBak 与
// lib/delete-guard.js:safeRmSync，改规则时三处一起改。

/** 宿主升级后 asar 是新版、.bak 还是上一版，无条件删 .bak 会永久销毁上一版官方原文。 */
function preserveBakLocal(asarPath) {
  if (!asarPath) return { action: "none" };
  const bak = `${asarPath}.bak`;
  let bakStat;
  try {
    bakStat = fs.statSync(bak);
  } catch {
    return { action: "none", bak };
  }
  if (!bakStat.isFile()) return { action: "none", bak };
  let asarSize = -1;
  try {
    asarSize = fs.statSync(asarPath).size;
  } catch {
    asarSize = -1;
  }
  // asar 已经不在了：这份 bak 是唯一副本，任何情况下都不动。
  if (asarSize < 0) return { action: "kept-only-copy", bak };
  if (bakStat.size === asarSize) {
    try {
      fs.rmSync(bak, { force: true });
    } catch {
      /* 删不掉就让 rename 自己覆盖 */
    }
    return { action: "dropped-duplicate", bak };
  }
  const keep = `${bak}.prev-${Date.now()}`;
  try {
    fs.renameSync(bak, keep);
  } catch {
    // 挪不动就别删 —— 宁可留着被后续脚本覆盖风险，也不销毁唯一旧版。
    return { action: "kept-unmovable", bak };
  }
  try {
    const dir = path.dirname(bak);
    const prefix = `${path.basename(bak)}.prev-`;
    const hits = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      // 按文件名时间戳排，不按 mtime —— rename 不更新 mtime。
      hits.push({ fp: path.join(dir, name), ts: Number(name.slice(prefix.length)) || 0 });
    }
    hits.sort((a, b) => b.ts - a.ts);
    for (const old of hits.slice(1)) {
      try {
        fs.rmSync(old.fp, { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
  return { action: "kept-previous", bak, kept: keep };
}

const OUR_DIR_RE = /^dsh-purge([@._-].*)?$/i;

function normPath(fp) {
  try {
    return path.resolve(fp).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function covers(parent, child) {
  const a = normPath(parent);
  const b = normPath(child);
  if (!a || !b) return false;
  return b === a || b.startsWith(`${a}/`);
}

// denyInside：内部也不许碰；denySelf：内部可删，但目录本身及其祖先不许删。
// 把 USERPROFILE 放进 denyInside 会误拒 `<dshHome>/dsh-purge`（dshHome 默认在用户目录下）。
function protectedRootsLocal() {
  const denyInside = [];
  const denySelf = [];
  const push = (list, p) => {
    if (!p) return;
    const n = normPath(p);
    if (n && !list.includes(n)) list.push(n);
  };
  if (process.platform === "win32") {
    push(denyInside, process.env.SystemRoot || "C:\\Windows");
    push(denyInside, process.env.windir);
    push(denyInside, process.env.ProgramFiles);
    push(denyInside, process.env["ProgramFiles(x86)"]);
    push(denyInside, process.env.ProgramW6432);
    push(denyInside, process.env.ProgramData);
    push(denySelf, process.env.USERPROFILE);
    push(denySelf, process.env.APPDATA);
    push(denySelf, process.env.LOCALAPPDATA);
  } else {
    for (const p of ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/var", "/opt", "/System", "/Applications", "/Library", "/private"]) {
      push(denyInside, p);
    }
    for (const p of ["/home", "/root", "/Users", "/tmp"]) push(denySelf, p);
  }
  return { denyInside, denySelf };
}

/** 否定式护栏：清单是父进程算的，但这里是真正动手的位置，不能无条件 rm -r。 */
function unsafeReasonLocal(fp) {
  if (!fp) return "empty-path";
  let st;
  try {
    st = fs.lstatSync(fp);
  } catch (e) {
    return e && e.code === "ENOENT" ? "already-gone" : "unreadable";
  }
  const abs = path.resolve(fp);
  const n = normPath(abs);
  if (!n || n.split("/").filter(Boolean).length < 3) return "path-too-shallow";
  if (!OUR_DIR_RE.test(path.basename(abs))) return "not-our-directory";
  // 带 .git 的是源码仓库，不是安装产物。开发机上 profile 常把插件目录 link 到仓库，
  // 这一步把「删插件」和「删仓库」彻底分开。
  if (st.isDirectory() && fs.existsSync(path.join(abs, ".git"))) return "looks-like-source-repo";
  if (dshHome && covers(n, dshHome)) return "would-remove-dsh-home-or-ancestor";
  const home = os.homedir();
  if (home && covers(n, home)) return "would-remove-user-home-or-ancestor";
  const { denyInside, denySelf } = protectedRootsLocal();
  for (const root of denyInside) {
    if (covers(root, n)) return "inside-protected-root";
  }
  for (const root of denySelf) {
    if (covers(n, root)) return "would-remove-protected-root";
  }
  if (st.isSymbolicLink()) {
    let real;
    try {
      real = fs.realpathSync(fp);
    } catch {
      return "dangling-or-unreadable-link";
    }
    if (dshHome && covers(normPath(real), dshHome)) return "link-points-at-dsh-home";
    if (home && covers(normPath(real), home)) return "link-points-at-user-home";
  }
  return "";
}

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

const cleanup = Array.isArray(info.cleanup) ? info.cleanup : [];
// 删除护栏要知道 DSH_HOME 在哪，才能挡住「把 home 本身或它的祖先删掉」这种清单。
// 父进程没传时退回环境变量，再退回空串（空串只会少一层保护，白名单与浅路径仍在）。
const dshHome =
  (typeof info.dshHome === "string" && info.dshHome) || process.env.DSH_HOME || "";
const logPath = path.join(
  process.env.TEMP || process.env.TMPDIR || "/tmp",
  "dsh-purge-restart-desktop.log",
);

function log(msg) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ignore
  }
}

function spawnEnv() {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  delete env.DSH_PURGE_RESTART;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
  }
  // [dsh-purge-fix 2026-10-09] 从 explorer 继承的 env 常缺 DSH_PROFILE
  // (WM_SETTINGCHANGE broadcast 不刷新存活很久的 explorer)。helper relaunch
  // 时如果不兜底，新 Electron → host 子进程继续缺,报 "cannot determine the
  // boot profile" host crash → dsh-purge 插件没 activate → inject 全断。
  if (!env.DSH_PROFILE) env.DSH_PROFILE = "desktop";
  return env;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidGone(pid) {
  if (!pid) {
    await sleep(400);
    return true;
  }
  for (let i = 0; i < 80; i++) {
    if (!pidAlive(pid)) return true;
    await sleep(120);
  }
  return !pidAlive(pid);
}

function rmTree(dir) {
  if (!dir) return;
  // 清单由父进程算，但这里是真正动手的位置：万一是旧版本写的清单、或持久化文件被改过，
  // 也不能无条件 rm -r。
  if (unsafeReasonLocal(dir)) return;
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return;
  }
  try {
    if (st.isSymbolicLink()) {
      fs.unlinkSync(dir); // 只摘链接，绝不跟进去删
    } else {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  } catch {
    // 锁着就留下
  }
}

function pidsForImage(image) {
  const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
  });
  const pids = [];
  for (const line of String(out || "").split(/\r?\n/)) {
    const cols = line.split(",");
    const pid = Number(String(cols[1] || "").replace(/"/g, "").trim());
    if (pid) pids.push(pid);
  }
  return pids;
}

function darwinBundleOf(exe) {
  const n = String(exe || "").replace(/\\/g, "/");
  const m = n.match(/^(.*\.app)\/Contents\/MacOS\//i);
  return m ? m[1] : "";
}

function darwinBundleName(bundle) {
  if (!bundle) return "";
  const infoPlist = path.join(bundle, "Contents", "Info.plist");
  try {
    return execFileSync("defaults", ["read", path.join(bundle, "Contents", "Info"), "CFBundleName"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    // fall through
  }
  try {
    return execFileSync("plutil", ["-extract", "CFBundleName", "raw", infoPlist], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return path.basename(bundle, ".app");
  }
}

function listDarwinPids(exe) {
  const bundle = darwinBundleOf(exe);
  if (!exe || !bundle) return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
      timeout: 8000,
    });
  } catch {
    return [];
  }
  const frameworks = `${bundle}/Contents/Frameworks/`;
  const pids = [];
  for (const line of String(out || "").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.search(/\s/);
    if (sp < 0) continue;
    const pid = Number(trimmed.slice(0, sp).trim());
    const cmd = trimmed.slice(sp + 1).trim();
    if (!pid) continue;
    // CLI 独立宿主（dsh web / plugin 等），不占桌面单实例锁，不能一起杀。
    if (cmd.includes("/dsh-desktop-host/lib/cli.js")) continue;
    if (cmd === exe || cmd.startsWith(`${exe} `) || cmd.startsWith(frameworks)) {
      pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

function commandMatchesExe(cmd, exe) {
  if (!cmd || !exe) return false;
  if (cmd.includes("/dsh-desktop-host/lib/cli.js")) return false;
  return cmd === exe || cmd.startsWith(`${exe} `) || cmd.startsWith(`${exe}\t`);
}

function listPosixPids(exe) {
  if (!exe) return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
      timeout: 8000,
    });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of String(out || "").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.search(/\s/);
    if (sp < 0) continue;
    const pid = Number(trimmed.slice(0, sp).trim());
    const cmd = trimmed.slice(sp + 1).trim();
    if (!pid || !commandMatchesExe(cmd, exe)) continue;
    pids.push(pid);
  }
  return [...new Set(pids)];
}

function listDesktopPids(exe = info.execPath) {
  if (process.platform === "darwin") return listDarwinPids(exe);
  if (process.platform !== "win32") return listPosixPids(exe);
  const images = ["DeepSeek Harness.exe", "DSH Desktop.exe"];
  const pids = [];
  for (const image of images) {
    try {
      pids.push(...pidsForImage(image));
    } catch {
      // 该进程名不存在
    }
  }
  return pids;
}

function signalPids(pids, signal) {
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // 已经退了
    }
  }
}

async function waitDesktopGone(exe, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const left = listDesktopPids(exe).filter((pid) => pid !== process.pid);
    if (left.length === 0) return true;
    await sleep(200);
  }
  return listDesktopPids(exe).filter((pid) => pid !== process.pid).length === 0;
}

async function quitPosixDesktop(exe) {
  signalPids(listDesktopPids(exe), "SIGTERM");
  if (await waitDesktopGone(exe, 8000)) {
    log("quit by SIGTERM");
    return "SIGTERM";
  }
  signalPids(listDesktopPids(exe), "SIGKILL");
  await waitDesktopGone(exe, 2000);
  log("quit by SIGKILL");
  return "SIGKILL";
}

async function quitDarwinDesktop(exe) {
  const bundle = darwinBundleOf(exe);
  const name = darwinBundleName(bundle);
  if (name) {
    try {
      execFileSync(
        "osascript",
        ["-e", `if application "${name}" is running then tell application "${name}" to quit`],
        { timeout: 15000 },
      );
      log("osascript quit sent");
    } catch (e) {
      log(`osascript quit failed: ${e && e.message ? e.message : e}`);
    }
    if (await waitDesktopGone(exe, 8000)) {
      log("quit by apple event");
      return "apple-event";
    }
  }
  signalPids(listDesktopPids(exe), "SIGTERM");
  if (await waitDesktopGone(exe, 5000)) {
    log("quit by SIGTERM");
    return "SIGTERM";
  }
  signalPids(listDesktopPids(exe), "SIGKILL");
  await waitDesktopGone(exe, 2000);
  log("quit by SIGKILL");
  return "SIGKILL";
}

function killOtherDesktopProcesses(keepPid, exe = info.execPath) {
  for (const pid of listDesktopPids(exe)) {
    if (pid === keepPid || pid === process.pid) continue;
    try {
      process.kill(pid, process.platform === "darwin" ? "SIGTERM" : undefined);
    } catch {
      // 已经退了
    }
  }
}

async function moveAsarAsideAsync(asar) {
  if (!asar) return false;
  try {
    if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) return true;
  } catch {
    return true;
  }
  const bak = `${asar}.bak`;
  try {
    // 以前这里是无条件 rmSync(bak)：宿主升级后 asar 已是新版、bak 还停在上一个版本，
    // 那一删就把上一版官方原文永久销毁了。同 size 才删，不同 size 留一份 .prev-<ts>。
    preserveBakLocal(asar);
  } catch {
    // keep going
  }
  for (let i = 0; i < 80; i++) {
    try {
      if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) {
        log("asar already absent");
        return true;
      }
      fs.renameSync(asar, bak);
      log(`asar moved to ${bak}`);
      return true;
    } catch {
      await sleep(300);
    }
  }
  log("asar move failed after retries");
  return false;
}

function asarStillSealed(asar) {
  try {
    return Boolean(asar) && fs.existsSync(asar) && fs.statSync(asar).isFile();
  } catch {
    return false;
  }
}

async function releaseSealedAsar(asar, exe) {
  if (!asar) return true;
  if (await moveAsarAsideAsync(asar)) return true;
  log("retry quit then move asar");
  if (process.platform === "darwin") await quitDarwinDesktop(exe);
  else if (process.platform === "win32") {
    killOtherDesktopProcesses(process.pid, exe);
    await sleep(800);
  } else await quitPosixDesktop(exe);
  if (await moveAsarAsideAsync(asar)) return true;
  return !asarStillSealed(asar);
}

function relaunchDesktop() {
  if (!info.execPath) {
    process.exit(1);
  }
  const env = spawnEnv();
  if (process.platform === "darwin") {
    const bundle = darwinBundleOf(info.execPath);
    if (bundle) {
      const child = spawn("open", [bundle], {
        detached: true,
        stdio: "ignore",
        env,
        shell: false,
      });
      child.on("error", () => process.exit(1));
      child.unref();
      log("relaunched via open");
      return;
    }
  }
  // [dsh-purge-fix 2026-10-09] 复用 Electron 自带的 --updated argv 分支:
  // main.js:11256 process.argv.includes("--updated") → raiseAfterUpdate=true
  // → enterWorkspace 时 window.moveTop() + window.focus() 内部强制前台。
  // 比外部 PS SetForegroundWindow 可靠得多 (Win11 前台保护只挡外部进程)。
  const baseArgv = Array.isArray(info.argv) ? info.argv.slice() : [];
  if (process.platform === "win32" && !baseArgv.includes("--updated")) {
    baseArgv.push("--updated");
  }
  const child = spawn(info.execPath, baseArgv, {
    detached: true,
    stdio: "ignore",
    cwd: info.cwd || process.cwd(),
    env,
    windowsHide: true,
    shell: false,
  });
  child.on("error", () => process.exit(1));
  child.unref();
  log("relaunched via execPath (argv=" + JSON.stringify(baseArgv) + ")");

  // [dsh-purge-fix 2026-10-09] Windows: 新 Electron 从 detached helper spawn,
  // Windows 焦点规则让它跑在后台。helper 已经不是前台(老 Electron 被 kill 了),
  // 直接 SetForegroundWindow 会被 Windows 静默 reject。
  // 三重 trick 强推前台:
  //   1) keybd_event 发送虚拟 Alt key — 模拟用户输入,解除 foreground lock
  //   2) AttachThreadInput attach 当前前台线程的 input queue — 继承前台权限
  //   3) ShowWindow(SW_RESTORE) + BringWindowToTop + SetForegroundWindow
  if (process.platform === "win32") {
    const exeLiteral = info.execPath.replace(/'/g, "''");
    const psScript =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$sig=@'\n" +
      "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);\n" +
      "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int c);\n" +
      "[DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h);\n" +
      "[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n" +
      "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);\n" +
      "[DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();\n" +
      "[DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a,uint b,bool f);\n" +
      "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k,byte s,uint f,int e);\n" +
      "'@;" +
      "$t=Add-Type -MemberDefinition $sig -Name W -Namespace U -PassThru;" +
      "[void]$t::keybd_event(0x12,0,0,0);" +
      "[void]$t::keybd_event(0x12,0,2,0);" +
      "for($i=0;$i -lt 25;$i++){" +
      "  Start-Sleep -Milliseconds 300;" +
      "  $p=Get-Process | Where-Object {$_.Path -eq '" + exeLiteral + "' -and $_.MainWindowHandle -ne 0} | Select-Object -First 1;" +
      "  if($p){" +
      "    $h=$p.MainWindowHandle;" +
      "    $fg=$t::GetForegroundWindow();" +
      "    $pid2=0;" +
      "    $fgTid=$t::GetWindowThreadProcessId($fg,[ref]$pid2);" +
      "    $curTid=$t::GetCurrentThreadId();" +
      "    [void]$t::AttachThreadInput($curTid,$fgTid,$true);" +
      "    [void]$t::ShowWindow($h,9);" +
      "    [void]$t::BringWindowToTop($h);" +
      "    [void]$t::SetForegroundWindow($h);" +
      "    [void]$t::AttachThreadInput($curTid,$fgTid,$false);" +
      "    break;" +
      "  }" +
      "}";
    try {
      const ps = spawn("powershell.exe", [
        "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
        "-Command", psScript,
      ], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
      // detached + unref 后 ENOENT 等异步错走 'error' 事件,外层 try/catch 捕不到 → uncaught 崩进程。
      ps.on("error", (err) => log("ps bring-to-front spawn error: " + String(err?.message || err)));
      ps.unref();
      log("spawned ps bring-to-front helper (keybd+attach+setfg)");
    } catch (err) {
      log("ps bring-to-front spawn failed: " + String(err));
    }
  }
}

let asarReleased = true;
if (info.killApp) {
  // #85: 先杀 Electron,再 sleep + cleanup。原顺序 sleep 400ms 开头 →
  // host 已经 exit → Electron 还活着跑旧 close 回调弹 crash dialog。
  // 新顺序:立刻 kill (host 这边 killInstallElectronSync 已经杀过,这里兜底),
  // Electron 死得越快,旧回调越没机会跑。
  if (process.platform === "darwin") {
    await quitDarwinDesktop(info.execPath);
  } else if (process.platform === "win32") {
    killOtherDesktopProcesses(process.pid);
    await sleep(500);
    // 二次保险:再杀一次,防第一次漏掉的 pid
    killOtherDesktopProcesses(process.pid);
  } else {
    await quitPosixDesktop(info.execPath);
  }
  for (const dir of cleanup) rmTree(dir);
  if (info.helper) {
    try {
      fs.unlinkSync(info.helper);
    } catch {
      /* ignore */
    }
  }
  if (info.asar) asarReleased = await releaseSealedAsar(info.asar, info.execPath);
} else {
  const gone = await waitPidGone(info.pid);
  if (!gone) process.exit(1);
  for (const dir of cleanup) rmTree(dir);
  if (info.helper) {
    try {
      fs.unlinkSync(info.helper);
    } catch {
      /* ignore */
    }
  }
  if (info.asar) asarReleased = await releaseSealedAsar(info.asar, info.execPath);
}

if (info.respawn === false) {
  process.exit(asarReleased ? 0 : 1);
}

if (info.asar && !asarReleased) {
  log("asar still sealed; not relaunching");
  process.exit(1);
}

if (!info.execPath) process.exit(1);

relaunchDesktop();
await sleep(400);
process.exit(0);
