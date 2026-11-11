import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";
const cleanup = Array.isArray(info.cleanup) ? info.cleanup : [];

function spawnEnv() {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  delete env.DSH_PURGE_RESTART;
  return env;
}

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

async function waitFree() {
  for (let i = 0; i < 80; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// ── 删除护栏（内联精简版）────────────────────────────────────────────────
// 权威实现是 lib/delete-guard.js。这里不能 import 它：lib/web.js 的
// scheduleCleanupRestart() 会把本文件 fs.copyFileSync 到 os.tmpdir() 下再执行，
// 同目录里没有 delete-guard.js。改判定规则时两边一起改。
const dshHome = (typeof info.dshHome === "string" && info.dshHome) || process.env.DSH_HOME || "";
const OUR_DIR_RE = /^dsh-purge([@._-].*)?$/i;

function norm(fp) {
  try {
    return path.resolve(fp).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
}

// parent 是 child 本身或它的祖先目录
function covers(parent, child) {
  const a = norm(parent);
  const b = norm(child);
  if (!a || !b) return false;
  return b === a || b.startsWith(`${a}/`);
}

// denyInside：内部也不许碰；denySelf：内部可删，但目录本身及其祖先不许删。
// 把 USERPROFILE 放进 denyInside 会误拒 `<dshHome>/dsh-purge`（dshHome 默认在用户目录下）。
function protectedRoots() {
  const denyInside = [];
  const denySelf = [];
  const push = (list, p) => {
    if (!p) return;
    const n = norm(p);
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

function unsafeReason(fp) {
  if (!fp) return "empty-path";
  let st;
  try {
    st = fs.lstatSync(fp);
  } catch (e) {
    return e && e.code === "ENOENT" ? "already-gone" : "unreadable";
  }
  const abs = path.resolve(fp);
  const n = norm(abs);
  if (!n || n.split("/").filter(Boolean).length < 3) return "path-too-shallow";
  if (!OUR_DIR_RE.test(path.basename(abs))) return "not-our-directory";
  // 带 .git 的是源码仓库，不是安装产物。开发机上 profile 常把插件目录 link 到仓库，
  // 这一步把「删插件」和「删仓库」彻底分开。
  if (st.isDirectory() && fs.existsSync(path.join(abs, ".git"))) return "looks-like-source-repo";
  if (dshHome && covers(n, dshHome)) return "would-remove-dsh-home-or-ancestor";
  const home = os.homedir();
  if (home && covers(n, home)) return "would-remove-user-home-or-ancestor";
  const { denyInside, denySelf } = protectedRoots();
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
    if (dshHome && covers(norm(real), dshHome)) return "link-points-at-dsh-home";
    if (home && covers(norm(real), home)) return "link-points-at-user-home";
    return "";
  }
  return "";
}

function rmTree(dir) {
  if (!dir) return;
  const unsafe = unsafeReason(dir);
  if (unsafe) return; // 不在白名单/太浅/落在系统目录 → 一个字节都不动
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

const ok = await waitFree();
if (!ok) process.exit(1);

for (const dir of cleanup) rmTree(dir);
if (info.helper) {
  try {
    fs.unlinkSync(info.helper);
  } catch {
    // ignore
  }
}

const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: "ignore",
  cwd: info.cwd || process.cwd(),
  env: spawnEnv(),
  windowsHide: true,
  shell: false,
});
child.on("error", () => process.exit(1));
child.unref();
await new Promise((r) => setTimeout(r, 400));
process.exit(0);
