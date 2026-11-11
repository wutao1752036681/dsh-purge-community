/**
 * 读日志尾部的一小段。
 *
 * 前端每 2 秒轮询一次 /status，而重启日志会一直长 —— 每次都整个读回来，一个
 * 开了半年的日志能把状态接口拖成几百毫秒。所以这里只读末尾固定字节数，再切
 * 出最后几行。
 *
 * 两个边界最容易错，都在这里处理掉：
 *   - 从字节中间切开时，开头可能落着某个 UTF-8 字符的后半截 → 变成替换字符；
 *   - 那次切开还会留下一行残句 → 显示出来像日志坏了，比少一行更误导。
 * 所以「不是从 0 开始读」时，先剥掉开头的替换字符，再丢掉第一行（残句）。
 */

/** 默认只看尾部 8 KB、只回 12 行。 */
export const DEFAULT_MAX_BYTES = 8 * 1024;
export const DEFAULT_MAX_LINES = 12;

/**
 * @param {typeof import("node:fs")} fsMod 注入 fs，便于测试
 * @param {string} filePath
 * @param {{maxBytes?: number, maxLines?: number}} options
 * @returns {{path: string, exists: boolean, size: number, updated_at: string,
 *            lines: string[], truncated: boolean, error?: string}}
 */
export function readLogTail(fsMod, filePath, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : DEFAULT_MAX_BYTES;
  const maxLines = Number.isFinite(options.maxLines) && options.maxLines > 0 ? options.maxLines : DEFAULT_MAX_LINES;
  const empty = {
    path: filePath,
    exists: false,
    size: 0,
    updated_at: "",
    lines: [],
    truncated: false,
  };
  if (!filePath || typeof filePath !== "string") return { ...empty, error: "empty-path" };

  let stat;
  try {
    stat = fsMod.statSync(filePath);
  } catch {
    // 还没重启过（或已被清理）就没有日志，不是错误。
    return empty;
  }
  if (!stat.isFile()) return { ...empty, size: stat.size, error: "not-a-file" };

  const startAt = Math.max(0, stat.size - maxBytes);
  const len = stat.size - startAt;
  if (len <= 0) {
    return { ...empty, exists: true, size: stat.size, updated_at: new Date(stat.mtimeMs).toISOString() };
  }

  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fsMod.openSync(filePath, "r");
    fsMod.readSync(fd, buf, 0, len, startAt);
  } catch (error) {
    return { ...empty, size: stat.size, error: String((error && error.code) || error) };
  } finally {
    if (fd !== undefined) {
      try { fsMod.closeSync(fd); } catch { /* 关不掉不影响已经读到的内容 */ }
    }
  }

  const text = buf.toString("utf8").replace(/^\uFFFD+/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  // 不是从头读的，第一行几乎一定是半句。
  if (startAt > 0 && lines.length) lines.shift();

  return {
    path: filePath,
    exists: true,
    size: stat.size,
    updated_at: new Date(stat.mtimeMs).toISOString(),
    lines: lines.slice(-maxLines),
    truncated: startAt > 0,
  };
}
