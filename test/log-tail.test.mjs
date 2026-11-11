/**
 * lib/log-tail.js 的边界行为。
 *
 * 这段逻辑的风险不在「读文件」，在三个边界：文件不存在、从字节中间切开、以及
 * 切开后留下的半行。半行显示成乱码比少一行更误导，所以这几条必须锁死。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tail = await import(new URL("../lib/log-tail.js", import.meta.url).href);
const { readLogTail, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } = tail;

export default async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-logtail-"));
  const tmp = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  try {
    await t.group("缺省值", async () => {
      t.eq("默认 8 KB", DEFAULT_MAX_BYTES, 8192);
      t.eq("默认 12 行", DEFAULT_MAX_LINES, 12);
    });

    await t.group("文件不存在", async () => {
      const r = readLogTail(fs, path.join(dir, "nope.log"));
      t.eq("exists=false", r.exists, false);
      t.eq("lines 空", r.lines.length, 0);
      t.eq("size=0", r.size, 0);
      t.eq("truncated=false", r.truncated, false);
      t.eq("不抛错也不带 error", r.error, undefined);
    });

    await t.group("空路径", async () => {
      t.eq("空串带 empty-path", readLogTail(fs, "").error, "empty-path");
      t.eq("null 带 empty-path", readLogTail(fs, null).error, "empty-path");
      t.eq("非字符串带 empty-path", readLogTail(fs, 42).error, "empty-path");
    });

    await t.group("目录不是文件", async () => {
      t.eq("目录报 not-a-file", readLogTail(fs, dir).error, "not-a-file");
    });

    await t.group("空文件", async () => {
      const p = tmp("empty.log", "");
      const r = readLogTail(fs, p);
      t.eq("exists=true", r.exists, true);
      t.eq("lines 空", r.lines.length, 0);
      t.eq("size=0", r.size, 0);
      t.ok("有 updated_at", typeof r.updated_at === "string" && r.updated_at.length > 0);
    });

    await t.group("小文件整份读", async () => {
      const p = tmp("small.log", "line1\nline2\nline3\n");
      const r = readLogTail(fs, p);
      t.eq("三行都在", r.lines.join("|"), "line1|line2|line3");
      t.eq("没有截断", r.truncated, false);
      t.eq("size 是字节数", r.size, fs.statSync(p).size);
    });

    await t.group("只回最后 maxLines 行", async () => {
      const body = Array.from({ length: 40 }, (_, i) => `row-${i + 1}`).join("\n");
      const p = tmp("many.log", body);
      const r = readLogTail(fs, p);
      t.eq("默认回 12 行", r.lines.length, 12);
      t.eq("最后一行是最新的", r.lines[11], "row-40");
      t.eq("第一行是倒数第 12 行", r.lines[0], "row-29");
      const r3 = readLogTail(fs, p, { maxLines: 3 });
      t.eq("maxLines 可指定", r3.lines.join("|"), "row-38|row-39|row-40");
    });

    await t.group("超过 maxBytes 时截断", async () => {
      /* 每行 20 字节，300 行 = 6000 字节，仍小于 8 KB，先造更大的。 */
      const rows = Array.from({ length: 800 }, (_, i) => `row-${String(i + 1).padStart(4, "0")}-padding`);
      const p = tmp("big.log", rows.join("\n"));
      const size = fs.statSync(p).size;
      t.ok("文件确实大于 8 KB", size > DEFAULT_MAX_BYTES, `size=${size}`);
      const r = readLogTail(fs, p);
      t.eq("truncated=true", r.truncated, true);
      t.eq("size 报的是整份文件大小", r.size, size);
      t.eq("回 12 行", r.lines.length, 12);
      t.eq("最后一行仍是末尾", r.lines[11], "row-0800-padding");
      const tailLines = rows.slice(-12);
      t.eq("12 行与原文末 12 行一致", r.lines.join("|"), tailLines.join("|"));
    });

    await t.group("半行被丢掉", async () => {
      /* 造一个必然切在行中间的场景：每行固定长度，maxBytes 不是行长整数倍。 */
      const rows = Array.from({ length: 50 }, (_, i) => `abcdefghij-${i}`);
      const p = tmp("half.log", rows.join("\n"));
      const r = readLogTail(fs, p, { maxBytes: 61, maxLines: 100 });
      t.eq("truncated=true", r.truncated, true);
      t.ok("第一行是完整的一行（不是残句）", /^abcdefghij-\d+$/.test(r.lines[0]), `实际 ${JSON.stringify(r.lines[0])}`);
      t.ok("没有替换字符", !r.lines.join("").includes("\uFFFD"), "出现了 U+FFFD");
      t.eq("最后一行是真正的末行", r.lines[r.lines.length - 1], "abcdefghij-49");
    });

    await t.group("多字节字符不被切坏", async () => {
      /* 中文每字 3 字节，maxBytes 故意取非 3 的倍数，让切口落在字符中间。 */
      const rows = Array.from({ length: 40 }, (_, i) => `第${i}行日志内容`);
      const p = tmp("cjk.log", rows.join("\n"));
      const r = readLogTail(fs, p, { maxBytes: 41, maxLines: 100 });
      t.ok("没有替换字符", !r.lines.join("").includes("\uFFFD"), "切口把汉字切成了 U+FFFD");
      for (const line of r.lines) {
        t.ok(`整行完整：${line}`, /^第\d+行日志内容$/.test(line), `实际 ${JSON.stringify(line)}`);
      }
    });

    await t.group("CRLF 与空行", async () => {
      const p = tmp("crlf.log", "a\r\n\r\n  \r\nb\r\nc\r\n");
      const r = readLogTail(fs, p);
      t.eq("空行与纯空白行被过滤", r.lines.join("|"), "a|b|c");
    });

    await t.group("maxBytes/maxLines 非法值回落默认", async () => {
      const p = tmp("fallback.log", "x\ny\n");
      t.eq("0 回落默认", readLogTail(fs, p, { maxLines: 0 }).lines.length, 2);
      t.eq("负数回落默认", readLogTail(fs, p, { maxBytes: -5 }).lines.join("|"), "x|y");
      t.eq("NaN 回落默认", readLogTail(fs, p, { maxLines: Number.NaN }).lines.length, 2);
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
