/**
 * lib/extract-asar.js 的 hostFs 门面 + lib/core.js 的 shim 文本判定。
 *
 * 这一组锁的是一个真实事故：hostFs 只转发了路径类方法，没转发 readSync /
 * closeSync。lib/core.js:36 是 `const fs = hostFs`，于是 isTextShim() 走到
 * fs.readSync 抛 TypeError 被 catch 吞掉 → 返回 false → 所有纯文本 shim 被判成
 * binary。后果是 patchShim 进 skipped_binary，只留下和原件一模一样的
 * dsh.cmd.dsh-purge.bak，命令行一行都没被注入。
 *
 * 所以这里既断言门面完整性，也断言「用 hostFs 自己的 fd 接口能读出内容」——
 * 后者才是当初崩掉的那条路径。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { hostFs } = await import(new URL("../lib/extract-asar.js", import.meta.url).href);
const core = await import(new URL("../lib/core.js", import.meta.url).href);
const { shimFileStatus, shimIsPatched } = core;

const SYNC_METHODS = [
  "existsSync", "statSync", "lstatSync", "readFileSync", "writeFileSync",
  "readdirSync", "mkdirSync", "realpathSync", "chmodSync", "unlinkSync",
  "rmSync", "renameSync", "appendFileSync", "openSync", "symlinkSync",
  "readSync", "closeSync",
];

export default async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hostfs-"));
  const tmp = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  try {
    await t.group("hostFs 同步门面完整", async () => {
      for (const m of SYNC_METHODS) {
        t.eq(`hostFs.${m} 是函数`, typeof hostFs[m], "function");
      }
      t.eq("copyFileSync 是函数", typeof hostFs.copyFileSync, "function");
      t.eq("promises.readFile 是函数", typeof hostFs.promises.readFile, "function");
    });

    await t.group("hostFs 自己的 fd 能读回内容", async () => {
      const p = tmp("fd-probe.txt", "abcdefghij");
      const fd = hostFs.openSync(p, "r");
      try {
        const buf = Buffer.allocUnsafe(4);
        const n = hostFs.readSync(fd, buf, 0, 4, 0);
        t.eq("读到 4 字节", n, 4);
        t.eq("内容正确", buf.subarray(0, n).toString("utf8"), "abcd");
      } finally {
        // 缺 closeSync 时这里也会抛 —— 正是事故里泄漏 fd 的那一步。
        hostFs.closeSync(fd);
      }
      t.eq("closeSync 之后 fd 已失效", (() => {
        try { hostFs.readSync(fd, Buffer.alloc(1), 0, 1, 0); return false; } catch { return true; }
      })(), true);
    });

    await t.group("shim 文本判定", async () => {
      t.eq("不存在 → missing", shimFileStatus(path.join(dir, "nope.cmd")), "missing");

      const plainCmd = tmp("dsh.cmd", "@echo off\r\nsetlocal\r\nexit /b 0\r\n");
      t.eq("@echo 文本 → original", shimFileStatus(plainCmd), "original");

      const patched = tmp("dsh.ps1", "# dsh-purge shim begin\nWrite-Host hi\n");
      t.eq("含注入标记 → patched", shimFileStatus(patched), "patched");
      t.eq("shimIsPatched 同判", shimIsPatched(patched), true);

      const shebang = tmp("dsh", "#!/bin/sh\nexec dsh\n");
      t.eq("shebang → original", shimFileStatus(shebang), "original");

      const rem = tmp("dsh-rem.cmd", "REM shim\r\n");
      t.eq("REM 开头 → original", shimFileStatus(rem), "original");

      const bin = tmp("dsh.exe", Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02]));
      t.eq("含 NUL → binary", shimFileStatus(bin), "binary");
      t.eq("binary 不算已注入", shimIsPatched(bin), false);

      const empty = tmp("empty.cmd", "");
      t.eq("空文件 → binary（无文本特征）", shimFileStatus(empty), "binary");
    });

    await t.group("只读前 512 字节", async () => {
      // 开头是文本特征 → 判文本，哪怕后面几 MB 都是内容。
      const big = tmp("big.cmd", "@echo off\r\n" + "x".repeat(8000));
      t.eq("大文件仍判文本", shimFileStatus(big), "original");

      // 反过来：特征跑到 512 字节之后就不认了。这是已知取舍（为了不把 PATH 上
      // 几 MB 的 exe 整个读进内存），锁住它免得以后有人改成全量读。
      const late = tmp("late.cmd", " ".repeat(600) + "@echo off\r\n");
      t.eq("特征在 512 字节后 → binary", shimFileStatus(late), "binary");
    });

    await t.group("gatherState 的 shim_dir 与状态行同源", async () => {
      // 桌面端 shim 在 resources/runtime/cli/bin，findShimDir() 靠 PATH/npm prefix
      // 可能恒为 null；两处不一致时 UI 会显示「未定位」但 shim 找得到。
      const src = fs.readFileSync(new URL("../lib/core.js", import.meta.url), "utf8");
      t.eq(
        "gatherState 桌面端优先 findDesktopShimDir()",
        /const shimDir = desktopSurface \? \(findDesktopShimDir\(\) \|\| findShimDir\(\)\) : findShimDir\(\);/u.test(src),
        true,
      );
      t.eq("shim 状态行走同一个 shimDir", /if \(shimDir\) \{\s*\n\s*shim_cmd = shimFileStatus/u.test(src), true);
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
