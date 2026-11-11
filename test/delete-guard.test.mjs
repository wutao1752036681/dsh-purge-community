// 卸载前的否定式删除护栏。
// 防的是：清单是「路径里含 /node_modules/dsh-purge 就算出来」的肯定式判断，
// 而 profile 下的 node_modules/dsh-purge 常常是指向真实仓库的 Junction ——
// realpath 之后是个源码目录，递归删掉就是删仓库。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeForCompare,
  looksLikeOurDirectory,
  inspectDeleteTarget,
  unsafeDeleteReason,
  safeRmSync,
  safeRm,
} from "../lib/delete-guard.js";

export default async function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-guard-"));
  const dir = (rel) => {
    const fp = path.join(root, rel);
    fs.mkdirSync(fp, { recursive: true });
    return fp;
  };
  const file = (rel, body = "x") => {
    const fp = path.join(root, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, body);
    return fp;
  };

  try {
    // ── 归一化 ──────────────────────────────────────────────────────────
    t.eq("反斜杠归一成正斜杠", normalizeForCompare("C:\\a\\b"), "c:/a/b");
    t.ok(
      "去掉尾部斜杠",
      !normalizeForCompare(path.join(root, "a", "b") + path.sep + path.sep).endsWith("/"),
    );
    t.eq("统一小写", normalizeForCompare("C:/A/B"), "c:/a/b");

    // ── 目录名白名单 ────────────────────────────────────────────────────
    t.ok("dsh-purge 认得出", looksLikeOurDirectory("/x/dsh-purge"));
    t.ok("dsh-purge@1.2.3 认得出", looksLikeOurDirectory("/x/dsh-purge@1.2.3"));
    t.ok("dsh-purge-backup 认得出", looksLikeOurDirectory("/x/dsh-purge-backup"));
    t.ok("dsh-purge.bak 认得出", looksLikeOurDirectory("/x/dsh-purge.bak"));
    t.ok("大小写不敏感", looksLikeOurDirectory("/x/DSH-Purge"));
    t.ok("dshpurge 不认", !looksLikeOurDirectory("/x/dshpurge"));
    t.ok("node_modules 不认", !looksLikeOurDirectory("/x/node_modules"));
    t.ok("空路径不认", !looksLikeOurDirectory(""));

    // ── 拒绝：基础形态 ──────────────────────────────────────────────────
    t.eq("空路径", unsafeDeleteReason(""), "empty-path");
    t.eq("null 路径", unsafeDeleteReason(null), "empty-path");
    t.eq(
      "不存在的路径",
      unsafeDeleteReason(path.join(root, "ghost", "dsh-purge")),
      "already-gone",
    );

    const shallow = process.platform === "win32" ? "C:\\dsh-purge" : "/dsh-purge";
    const shallowVerdict = inspectDeleteTarget(shallow);
    // 段数不够时若路径本来就不存在，already-gone 会先命中 —— 两种都不放行即可。
    t.ok(
      "太浅的路径不放行",
      !shallowVerdict.safe &&
        ["path-too-shallow", "already-gone"].includes(shallowVerdict.reason),
      shallowVerdict.reason,
    );

    const notOurs = dir("plain");
    t.eq("名字不是我们的", unsafeDeleteReason(notOurs), "not-our-directory");

    // ── 拒绝：会删到 DSH_HOME 及其祖先 ──────────────────────────────────
    const fakeHome = dir("home/dsh-purge");
    const deeper = path.join(fakeHome, "nested");
    t.eq(
      "目标包含 dshHome",
      unsafeDeleteReason(fakeHome, { dshHome: deeper }),
      "would-remove-dsh-home-or-ancestor",
    );
    t.eq(
      "目标就是 dshHome",
      unsafeDeleteReason(fakeHome, { dshHome: fakeHome }),
      "would-remove-dsh-home-or-ancestor",
    );

    // ── 拒绝：系统目录与受保护根 ────────────────────────────────────────
    if (process.platform === "win32") {
      const winSys = path.join(process.env.SystemRoot || "C:\\Windows", "dsh-purge");
      const r = inspectDeleteTarget(winSys);
      // 目录不存在时 already-gone 会先命中，那条也算安全 —— 只要不是放行去删系统目录。
      t.ok(
        "系统目录下的目标被拒",
        !r.safe && (r.reason === "inside-protected-root" || r.reason === "already-gone"),
        r.reason,
      );
    } else {
      const usr = path.join("/usr", "dsh-purge");
      const r = inspectDeleteTarget(usr);
      t.ok("系统目录下的目标被拒", !r.safe, r.reason);
    }

    const extraRoot = dir("extraroot");
    const insideExtra = dir("extraroot/dsh-purge");
    t.eq(
      "extraProtected 内部被拒",
      unsafeDeleteReason(insideExtra, { extraProtected: [extraRoot] }),
      "inside-protected-root",
    );

    // ── 拒绝：不能删用户目录本身 ────────────────────────────────────────
    // 造一个名字恰好是 dsh-purge 的「用户目录」不现实，改用 denySelf 的另一个成员：
    // 平台临时根的祖先关系由 covers(n, root) 判，这里直接验 /tmp 或 %TEMP% 的父级形态。
    const tmpRoot = process.platform === "win32"
      ? (process.env.LOCALAPPDATA || os.tmpdir())
      : "/tmp";
    const tmpTarget = path.join(tmpRoot, "dsh-purge");
    const tmpVerdict = inspectDeleteTarget(tmpTarget);
    // 目标本身存在与否都能过；关键是它不能被判成「会删掉受保护根」。
    t.ok(
      "受保护根内部的 dsh-purge 不被误拒",
      tmpVerdict.safe || tmpVerdict.reason === "already-gone",
      tmpVerdict.reason,
    );

    // ── 放行：正常目标 ──────────────────────────────────────────────────
    const good = dir("clean/dsh-purge");
    file("clean/dsh-purge/a.txt", "hello");
    const goodInfo = inspectDeleteTarget(good);
    t.ok("普通 dsh-purge 目录放行", goodInfo.safe, goodInfo.reason);
    t.eq("放行理由 ok", goodInfo.reason, "ok");
    t.eq("kind 是 dir", goodInfo.kind, "dir");

    // 关键回归：DSH_HOME 默认在用户目录下，正常卸载目标不能被 protected-root 误伤。
    const fakeDshHome = dir("users/alice/.dsh");
    const realTarget = dir("users/alice/.dsh/dsh-purge");
    file("users/alice/.dsh/dsh-purge/keep.txt", "data");
    t.eq(
      "用户目录下的 <dshHome>/dsh-purge 可删",
      unsafeDeleteReason(realTarget, { dshHome: fakeDshHome }),
      "",
    );

    // ── safeRmSync 行为 ────────────────────────────────────────────────
    const victim = dir("rm/dsh-purge");
    file("rm/dsh-purge/deep/x.txt", "y");
    const removed = safeRmSync(victim);
    t.ok("删除成功", removed.removed);
    t.ok("不做无谓跳过", !removed.skipped);
    t.ok("目录真的没了", !fs.existsSync(victim), victim);

    const again = safeRmSync(victim);
    t.ok("再删一次不抛", !again.removed);
    t.eq("再删一次记为已消失", again.reason, "already-gone");

    const refuse = safeRmSync(notOurs);
    t.ok("不该删的没删", !refuse.removed && fs.existsSync(notOurs));
    t.eq("跳过理由带回来", refuse.reason, "not-our-directory");

    const singleFile = file("rm-files/dsh-purge");
    t.ok("单文件也能删", safeRmSync(singleFile).removed);
    t.ok("单文件确实没了", !fs.existsSync(singleFile));

    // ── 链接：只摘链接，绝不跟进去删 ────────────────────────────────────
    const realBody = dir("link-src/repo");
    file("link-src/repo/main.js", "console.log(1)");
    const linkPath = path.join(dir("link-host"), "dsh-purge");
    let linked = false;
    try {
      fs.symlinkSync(realBody, linkPath, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (error) {
      t.skip("链接用例", `本机建不了链接：${error.code || error.message}`);
    }
    if (linked) {
      const linkInfo = inspectDeleteTarget(linkPath);
      t.ok("链接放行", linkInfo.safe, linkInfo.reason);
      t.eq("链接理由 link-only", linkInfo.reason, "link-only");
      t.ok("识别成链接", linkInfo.isLink);

      const unlinked = safeRmSync(linkPath);
      t.ok("摘链接成功", unlinked.removed);
      t.ok("链接本身没了", !fs.existsSync(linkPath));
      t.ok("链接指向的真实目录还在", fs.existsSync(realBody));
      t.ok("真实目录里的文件没被删", fs.existsSync(path.join(realBody, "main.js")));

      // 悬空链接
      const dangling = path.join(dir("link-dangling"), "dsh-purge");
      try {
        fs.symlinkSync(path.join(root, "nowhere"), dangling, process.platform === "win32" ? "junction" : "dir");
      } catch {
        /* 建不了就跳过下一条 */
      }
      if (fs.existsSync(dangling) || fs.lstatSync(dangling, { throwIfNoEntry: false })) {
        const d = inspectDeleteTarget(dangling);
        t.eq("悬空链接被拒", d.reason, "dangling-or-unreadable-link");
      }
    }

    // ── 源码仓库不被当成安装目录 ────────────────────────────────────────
    // `dsh-purge-master` 这类名字既可能是备份也可能是一份 git clone，白名单分不出来。
    const repo = dir("repo/dsh-purge-master");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, "index.js"), "export default 1;\n");
    t.eq("带 .git 的目录被拒", unsafeDeleteReason(repo), "looks-like-source-repo");
    const repoRes = safeRmSync(repo);
    t.ok("源码仓库没被删", !repoRes.removed && fs.existsSync(repo));
    t.ok("仓库里的 .git 还在", fs.existsSync(path.join(repo, ".git")));
    t.ok("仓库里的源文件还在", fs.existsSync(path.join(repo, "index.js")));

    if (linked) {
      // 关键场景：profile 下的插件目录是 junction 指向仓库。
      const repoLink = path.join(dir("repo-link"), "dsh-purge");
      try {
        fs.symlinkSync(repo, repoLink, process.platform === "win32" ? "junction" : "dir");
        const linkVerdict = inspectDeleteTarget(repoLink);
        t.eq("指向仓库的链接只摘链接", linkVerdict.reason, "link-only");
        t.ok("链接判定为安全", linkVerdict.safe);
        const r = safeRmSync(repoLink);
        t.ok("链接被摘掉", r.removed && !fs.existsSync(repoLink));
        t.ok("仓库本体完好", fs.existsSync(path.join(repo, ".git")));
        t.ok("仓库源文件完好", fs.existsSync(path.join(repo, "index.js")));
      } catch (error) {
        t.skip("指向仓库的 junction", `本机建不了：${error.code || error.message}`);
      }
    }

    // ── 异步版 ─────────────────────────────────────────────────────────
    const asyncVictim = dir("async/dsh-purge");
    file("async/dsh-purge/z.txt", "z");
    const a = await safeRm(asyncVictim);
    t.ok("异步删除成功", a.removed);
    t.ok("异步删完就没了", !fs.existsSync(asyncVictim));

    const a2 = await safeRm(notOurs);
    t.ok("异步也守规矩", !a2.removed && fs.existsSync(notOurs));
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
