// fixture：命中错了文件（完全不涉及提示词组装逻辑）
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}
