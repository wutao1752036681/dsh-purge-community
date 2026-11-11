/**
 * 宿主系统提示词的形态判决。
 *
 * 为什么单独一个模块：同一套判据原来有三份拷贝 —— lib/host-clean.js 的布尔版、
 * lib/desktop.js:1294 里内联进 VBS 生成器的 JScript 版、以及 core.js 里补丁注释的
 * 反向依赖。三份谁先漂移都没人发现，因为没人能单独跑它。
 *
 * 这里只回答一个问题：这份文件现在是不是"洗过且注入了"的形态。
 * 判据顺序与 desktop.js 的 hostClean 保持一致 —— 标记齐全就直接算 clean，
 * 不再要求 system-prompt/assemble 在场（补丁里存在整段替换 assembly 的变体，
 * 那些变体本来就不会留下原字符串）。
 */

/** 补丁写进去的标记，缺一个都说明这轮没落到这个文件。 */
export const IDENTITY_MARKER = "[dsh-purge] identity stripped";
export const INJECT_MARKERS = [
  "[dsh-purge] complete prompt keeps waterfall inject",
  "[dsh-purge] complete prompt keeps inject",
];

/** 原始形态的痕迹，出现就说明对应那一处没洗掉。 */
export const RAW_IDENTITY = "You are an AI agent powered by DeepSeek Harness.";
export const RAW_DROPS_INJECT = "transformed.sections : [completeSection]";

/** 只有这份模块才有这个调用，没有它说明候选文件选错了。 */
export const MODULE_FINGERPRINT = "system-prompt/assemble";

/** 四态。clean 之外都不是"可以拿去重启"的形态。 */
export const PROMPT_VERDICTS = ["clean", "dirty", "foreign", "unreadable"];

const REASONS = {
  marked: "标记齐全：身份已剥 + 注入保留",
  inferred: "无标记，但原文里两处旧拦截都还在位",
  "identity-left": "原始身份行仍在",
  "drops-inject": "注入被压成 completeSection，waterfall 结果丢了",
  "identity-and-drops": "原始身份行仍在，且注入被压成 completeSection",
  "not-our-module": "没有 system-prompt/assemble 调用，不是要洗的那份模块",
  "empty-text": "文件是空的",
  unreadable: "读不出来",
};

function hasInjectMarker(body) {
  return INJECT_MARKERS.some((m) => body.includes(m));
}

/**
 * @param {string|null|undefined} text 文件内容
 * @returns {{verdict:"clean"|"dirty"|"foreign"|"unreadable", ok:boolean, reasonCode:string, reason:string, hits:string[]}}
 */
export function judgePromptText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return verdict("unreadable", "empty-text");
  }
  const body = text;
  const marked = body.includes(IDENTITY_MARKER) && hasInjectMarker(body);
  if (marked) return verdict("clean", "marked");

  if (!body.includes(MODULE_FINGERPRINT)) {
    return verdict("foreign", "not-our-module");
  }
  const identityLeft = body.includes(RAW_IDENTITY);
  const dropsInject = body.includes(RAW_DROPS_INJECT);
  if (identityLeft && dropsInject) return verdict("dirty", "identity-and-drops");
  if (identityLeft) return verdict("dirty", "identity-left");
  if (dropsInject) return verdict("dirty", "drops-inject");
  return verdict("clean", "inferred");
}

/** 读文件再判。读失败不抛，归到 unreadable。 */
export function judgePromptFile(fs, fp) {
  let text;
  try {
    text = fs.readFileSync(fp, "utf8");
  } catch (error) {
    const base = verdict("unreadable", "unreadable");
    base.reason = `读不出来：${error && error.message || error}`;
    base.path = String(fp || "");
    return base;
  }
  const result = judgePromptText(text);
  result.path = String(fp || "");
  return result;
}

function verdict(kind, reasonCode) {
  const hits = [];
  if (reasonCode === "identity-left" || reasonCode === "identity-and-drops") hits.push(RAW_IDENTITY);
  if (reasonCode === "drops-inject" || reasonCode === "identity-and-drops") hits.push(RAW_DROPS_INJECT);
  if (reasonCode === "not-our-module") hits.push(MODULE_FINGERPRINT);
  return {
    verdict: kind,
    ok: kind === "clean",
    reasonCode,
    reason: REASONS[reasonCode] || reasonCode,
    hits,
  };
}

/** 给上一批文件出一张表，`--runs=N` 时比较每轮的判决是否一致。 */
export function summarizeVerdicts(rows) {
  const counts = { clean: 0, dirty: 0, foreign: 0, unreadable: 0 };
  for (const row of rows) {
    const k = row && row.verdict;
    if (k in counts) counts[k] += 1;
  }
  return {
    total: rows.length,
    counts,
    ok: rows.length > 0 && counts.clean === rows.length,
  };
}
