/**
 * 删除前的否定式护栏。
 *
 * 卸载流程最后会把几处目录整棵删掉。原来那份清单是「算出来就删」，只靠
 * shouldDeletePluginTree 的肯定式判断（路径里含 /node_modules/dsh-purge）。
 * 肯定式判断漏一种情况就够呛：Junction。宿主 profile 下的
 * `node_modules/dsh-purge` 在很多开发机上是指向真实仓库的 Junction，realpath
 * 之后指向 `D:\projects\...`，一旦被当成"插件目录树"递归删掉，删的是源码仓库。
 *
 * 所以这里反过来做：先假定不能删，逐条要求它证明自己可以删。
 *   · 结构层：不允许盘符根、系统目录、用户目录及其祖先、DSH_HOME 及其祖先。
 *   · 语义层：末段必须是 dsh-purge 家族的名字，否则不是我们的东西。
 * 两层都过了才放行；链接则只摘链接本身，绝不跟着链接进去删。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 归一化成小写、正斜杠、无尾斜杠的形式，便于前缀比较。 */
export function normalizeForCompare(fp) {
  let resolved;
  try {
    resolved = path.resolve(fp);
  } catch {
    resolved = String(fp || "");
  }
  return resolved.replace(/[/\\]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

function segments(normalized) {
  return normalized.split("/").filter(Boolean);
}

function isAncestorOrSelf(candidate, target) {
  if (!candidate || !target) return false;
  return candidate === target || target.startsWith(`${candidate}/`);
}

/**
 * 系统级目录，分两组 —— 这个区分是必须的：
 *
 *   denyInside：连内部都不许碰（Windows/系统安装目录）。
 *   denySelf  ：内部可以删，但目录本身及其祖先不许删（用户目录、/home、/tmp）。
 *
 * 一开始把 USERPROFILE 放进「内部也不许碰」那组，结果 DSH_HOME 默认就在
 * `C:\Users\<u>\.dsh` 下面，正常卸载目标 `<dshHome>/dsh-purge` 全部被误拒。
 */
function protectedRoots() {
  const denyInside = [];
  const denySelf = [];
  const push = (list, p) => {
    if (!p) return;
    const n = normalizeForCompare(p);
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

/** 末段是不是我们自己的目录名。`dsh-purge`、`dsh-purge@1.2.3`、`dsh-purge-backup` 都算。 */
export function looksLikeOurDirectory(fp) {
  // 空串会被 path.resolve 变成 cwd，而 cwd 可能恰好叫 dsh-purge-xxx，于是空路径
  // 被误判成"我们的目录"。先挡掉。
  if (!fp || typeof fp !== "string") return false;
  const segs = segments(normalizeForCompare(fp));
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1];
  return /^dsh-purge([@._-].*)?$/.test(last);
}

function lstatKind(fp) {
  try {
    const st = fs.lstatSync(fp);
    if (st.isSymbolicLink()) return "link";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error && error.code === "ENOENT") return "missing";
    return "unknown";
  }
}

function realOf(fp) {
  try {
    return fs.realpathSync(fp);
  } catch {
    return "";
  }
}

/**
 * @param {string} fp 待删路径
 * @param {{dshHome?:string, extraProtected?:string[]}} [opts]
 * @returns {{safe:boolean, reason:string, path:string, real:string, kind:string, isLink:boolean}}
 */
export function inspectDeleteTarget(fp, opts = {}) {
  const kind = lstatKind(fp);
  const real = realOf(fp);
  const base = { safe: false, reason: "", path: String(fp || ""), real, kind, isLink: kind === "link" };

  if (!fp || typeof fp !== "string") return { ...base, reason: "empty-path" };
  if (kind === "missing") return { ...base, reason: "already-gone" };
  if (kind === "unknown") return { ...base, reason: "unreadable" };

  const target = normalizeForCompare(fp);
  const segs = segments(target);
  if (!target) return { ...base, reason: "empty-path" };

  // 盘符根 / POSIX 根 / 只剩一两段的路径
  if (segs.length < 3) return { ...base, reason: "path-too-shallow" };

  // 语义层：末段必须是我们自己的目录名
  if (!looksLikeOurDirectory(fp)) return { ...base, reason: "not-our-directory" };

  // 语义层：带 .git 的目录是源码仓库，不是安装产物。
  // `dsh-purge-master` 这种名字既可能是一次备份，也可能是一份 git clone，
  // 白名单分不出来，所以用 .git 兜底。开发机上的 profile 常把插件目录
  // link 到仓库，这一步能把「删插件」和「删仓库」彻底分开。
  if (kind === "dir" && fs.existsSync(path.join(fp, ".git"))) {
    return { ...base, reason: "looks-like-source-repo" };
  }

  // 结构层：DSH_HOME 及其祖先
  const dshHome = opts.dshHome || "";
  if (dshHome) {
    const home = normalizeForCompare(dshHome);
    if (isAncestorOrSelf(target, home)) return { ...base, reason: "would-remove-dsh-home-or-ancestor" };
  }

  // 结构层：用户目录及其祖先
  const userHome = os.homedir ? os.homedir() : "";
  if (userHome) {
    const uh = normalizeForCompare(userHome);
    if (isAncestorOrSelf(target, uh)) return { ...base, reason: "would-remove-user-home-or-ancestor" };
  }

  // 结构层：系统目录
  const { denyInside, denySelf } = protectedRoots();
  const extra = (opts.extraProtected || []).map((p) => normalizeForCompare(p)).filter(Boolean);
  for (const root of denyInside.concat(extra)) {
    if (target === root || target.startsWith(`${root}/`)) {
      return { ...base, reason: "inside-protected-root" };
    }
  }
  for (const root of denySelf) {
    if (isAncestorOrSelf(target, root)) {
      return { ...base, reason: "would-remove-protected-root" };
    }
  }

  // 链接：只摘链接本身，所以目标再危险也不跟进去删。
  // 但目标如果是我们自己的数据目录/用户目录，摘链接也会让人一脸问号，干脆拒。
  if (kind === "link") {
    if (!real) return { ...base, safe: false, reason: "dangling-or-unreadable-link" };
    const r = normalizeForCompare(real);
    if (dshHome && r === normalizeForCompare(dshHome)) return { ...base, reason: "link-points-at-dsh-home" };
    if (userHome && r === normalizeForCompare(userHome)) return { ...base, reason: "link-points-at-user-home" };
    return { ...base, safe: true, reason: "link-only" };
  }

  return { ...base, safe: true, reason: "ok" };
}

/** 只要理由字符串，安全时返回空串（调用点写起来更顺）。 */
export function unsafeDeleteReason(fp, opts = {}) {
  const info = inspectDeleteTarget(fp, opts);
  return info.safe ? "" : info.reason;
}

/**
 * 判完再删。
 * 链接走 unlink（不递归），目录走 rm -r。删除失败不抛，把原因带回去。
 * @returns {{removed:boolean, reason:string, path:string, real:string, skipped:boolean}}
 */
export function safeRmSync(fp, opts = {}) {
  const info = inspectDeleteTarget(fp, opts);
  if (!info.safe) {
    return { removed: false, skipped: true, reason: info.reason, path: info.path, real: info.real };
  }
  try {
    if (info.kind === "link") {
      fs.unlinkSync(fp);
    } else if (info.kind === "dir") {
      fs.rmSync(fp, { recursive: true, force: true });
    } else {
      fs.rmSync(fp, { force: true });
    }
    return { removed: true, skipped: false, reason: info.reason, path: info.path, real: info.real };
  } catch (error) {
    return {
      removed: false,
      skipped: false,
      reason: `remove-failed: ${error && error.code || error && error.message || error}`,
      path: info.path,
      real: info.real,
    };
  }
}

/** 异步版本，给 await 链用。 */
export async function safeRm(fp, opts = {}) {
  const { promises: fsp } = fs;
  const info = inspectDeleteTarget(fp, opts);
  if (!info.safe) {
    return { removed: false, skipped: true, reason: info.reason, path: info.path, real: info.real };
  }
  try {
    if (info.kind === "link") {
      await fsp.unlink(fp);
    } else if (info.kind === "dir") {
      await fsp.rm(fp, { recursive: true, force: true });
    } else {
      await fsp.rm(fp, { force: true });
    }
    return { removed: true, skipped: false, reason: info.reason, path: info.path, real: info.real };
  } catch (error) {
    return {
      removed: false,
      skipped: false,
      reason: `remove-failed: ${error && error.code || error && error.message || error}`,
      path: info.path,
      real: info.real,
    };
  }
}
