// app.asar.bak 保留判据 + 目录改名重试。
// 防的是：宿主升级后 asar 已是新版、bak 还停在上一个版本，无条件 rmSync(bak) 会把
// 上一版官方原文永久销毁，header 级回滚从此不可能。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preserveExistingAsarBak, renameAsarAside, commitExtractedDir } from "../lib/extract-asar.js";

export default async function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-bak-"));
  const mk = (name, size) => {
    const fp = path.join(root, name);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, Buffer.alloc(size, 0x41));
    return fp;
  };
  try {
    const asar = path.join(root, "resources", "app.asar");
    fs.mkdirSync(path.join(root, "resources"), { recursive: true });

    // 1. 没有 bak
    t.eq("没有 bak 时不动手", preserveExistingAsarBak(asar).action, "none");

    // 2. asar 已不在，bak 是唯一副本 → 绝不碰
    const only = path.join(root, "only", "app.asar");
    mk("only/app.asar.bak", 120);
    const r2 = preserveExistingAsarBak(only);
    t.eq("asar 缺失时保留唯一副本", r2.action, "kept-only-copy");
    t.ok("唯一副本仍在", fs.existsSync(`${only}.bak`));
    t.eq("唯一副本字节未变", fs.statSync(`${only}.bak`).size, 120);

    // 3. 同 size → 重复副本，删
    const dup = path.join(root, "dup", "app.asar");
    mk("dup/app.asar", 256);
    mk("dup/app.asar.bak", 256);
    t.eq("同 size 判重复副本", preserveExistingAsarBak(dup).action, "dropped-duplicate");
    t.ok("重复副本已删", !fs.existsSync(`${dup}.bak`));
    t.ok("asar 本体未动", fs.existsSync(dup));

    // 4. 不同 size → 改名保留
    const ver = path.join(root, "ver", "app.asar");
    mk("ver/app.asar", 300);
    mk("ver/app.asar.bak", 200);
    const r4 = preserveExistingAsarBak(ver);
    t.eq("不同 size 判旧版本", r4.action, "kept-previous");
    t.ok("旧版本移出 .bak 名", !fs.existsSync(`${ver}.bak`));
    t.ok("旧版本落到 .prev-<ts>", Boolean(r4.kept) && fs.existsSync(r4.kept), r4.kept);
    t.eq("旧版本字节保留", fs.statSync(r4.kept).size, 200);
    t.ok("prev 命名前缀正确", path.basename(r4.kept).startsWith("app.asar.bak.prev-"));

    // 5. 多轮升级只留最新一份 prev
    const many = path.join(root, "many", "app.asar");
    mk("many/app.asar", 400);
    for (let i = 0; i < 4; i += 1) {
      mk("many/app.asar.bak", 100 + i);
      const r = preserveExistingAsarBak(many);
      t.eq(`第 ${i + 1} 轮保留旧版`, r.action, "kept-previous");
      await new Promise((res) => setTimeout(res, 4));
    }
    const prevs = fs.readdirSync(path.join(root, "many")).filter((n) => n.includes(".bak.prev-"));
    t.eq("prev 只留一份", prevs.length, 1);
    t.eq("留的是最新那份", fs.statSync(path.join(root, "many", prevs[0])).size, 103);

    // 6. renameAsarAside 带上 preserved
    const rn = path.join(root, "rn", "app.asar");
    mk("rn/app.asar", 500);
    mk("rn/app.asar.bak", 111);
    const r6 = renameAsarAside(rn);
    t.eq("asar 已改名", r6.renamed, true);
    t.eq("返回值带 preserved 判定", r6.preserved.action, "kept-previous");
    t.ok("新 bak 是当前 asar", fs.existsSync(`${rn}.bak`));
    t.eq("新 bak 大小等于当前 asar", fs.statSync(`${rn}.bak`).size, 500);
    const prevs6 = fs.readdirSync(path.join(root, "rn")).filter((n) => n.includes(".bak.prev-"));
    t.eq("旧版本被保留", prevs6.length, 1);
    t.eq("旧版本字节正确", fs.statSync(path.join(root, "rn", prevs6[0])).size, 111);

    // 7. asar 不存在时早退，不碰孤儿 bak
    const gone = path.join(root, "gone", "app.asar");
    mk("gone/app.asar.bak", 90);
    t.eq("asar 不在时不改名", renameAsarAside(gone).renamed, false);
    t.ok("孤儿 bak 仍在", fs.existsSync(`${gone}.bak`));

    // 8. commit 正常轮换
    const dest = path.join(root, "commit", "app");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "old.txt"), "old");
    const next = `${dest}.dshpurge-next`;
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, "new.txt"), "new");
    const r8 = commitExtractedDir(dest, next);
    t.ok("新目录已换上", fs.existsSync(path.join(dest, "new.txt")));
    t.ok("旧目录挪到 prev", Boolean(r8.prev) && fs.existsSync(r8.prev));

    // 9. 缺 nextDir 抛错且不动 dest
    const keep = path.join(root, "keep", "app");
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(path.join(keep, "keep.txt"), "keep");
    t.throws("缺 nextDir 时抛错", () => commitExtractedDir(keep, ""), "解包目录不存在");
    t.ok("dest 未被破坏", fs.existsSync(path.join(keep, "keep.txt")));

    // 10. 空参数安全
    t.eq("空路径 preserve 安全", preserveExistingAsarBak("").action, "none");
    t.eq("空路径 rename 安全", renameAsarAside("").renamed, false);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
