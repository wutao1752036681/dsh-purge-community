// 宿主系统提示词的形态判决。
// 三种输入形态各自代表一次真实翻车：身份没剥 / 注入被压扁 / 候选文件选错。
import {
  judgePromptText,
  judgePromptFile,
  summarizeVerdicts,
  IDENTITY_MARKER,
  INJECT_MARKERS,
  RAW_IDENTITY,
  RAW_DROPS_INJECT,
  MODULE_FINGERPRINT,
} from "../lib/prompt-verdict.js";
import { hostPromptKeepsInject } from "../lib/host-clean.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WRAPPED = (body) => `async function assemble() {\n  ${body}\n}\n`;

export default async function (t) {
  // 1. 标记齐全 → clean/marked
  {
    const text = `${IDENTITY_MARKER}\n${INJECT_MARKERS[0]}\n`;
    const r = judgePromptText(text);
    t.eq("标记齐全判 clean", r.verdict, "clean");
    t.eq("理由是 marked", r.reasonCode, "marked");
    t.ok("ok 为 true", r.ok === true);
  }

  // 2. 无标记但两处旧拦截都不在了 → clean/inferred
  {
    const text = WRAPPED(`const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "${MODULE_FINGERPRINT}", assembly, context, () => Promise.resolve(assembly));`);
    const r = judgePromptText(text);
    t.eq("无标记但干净判 clean", r.verdict, "clean");
    t.eq("理由是 inferred", r.reasonCode, "inferred");
  }

  // 3. 身份行仍在 → dirty/identity-left
  {
    const text = WRAPPED(`const s = { text: "${RAW_IDENTITY}" }; // ${MODULE_FINGERPRINT}`);
    const r = judgePromptText(text);
    t.eq("身份行残留判 dirty", r.verdict, "dirty");
    t.eq("理由是 identity-left", r.reasonCode, "identity-left");
    t.ok("命中项列出原始身份行", r.hits.includes(RAW_IDENTITY), JSON.stringify(r.hits));
  }

  // 4. 注入被压成 completeSection → dirty/drops-inject
  {
    const text = `${MODULE_FINGERPRINT} ... sections: ${RAW_DROPS_INJECT}`;
    const r = judgePromptText(text);
    t.eq("注入被压扁判 dirty", r.verdict, "dirty");
    t.eq("理由是 drops-inject", r.reasonCode, "drops-inject");
    t.ok("命中项列出压扁那行", r.hits.includes(RAW_DROPS_INJECT), JSON.stringify(r.hits));
  }

  // 5. 两处都残留 → dirty/identity-and-drops
  {
    const text = `${MODULE_FINGERPRINT}\n${RAW_IDENTITY}\n${RAW_DROPS_INJECT}`;
    const r = judgePromptText(text);
    t.eq("两处都残留判 dirty", r.verdict, "dirty");
    t.eq("理由是 identity-and-drops", r.reasonCode, "identity-and-drops");
    t.eq("命中项两条", r.hits.length, 2);
  }

  // 6. 不是这份模块 → foreign
  {
    const r = judgePromptText("console.log('some other file');");
    t.eq("无指纹判 foreign", r.verdict, "foreign");
    t.eq("理由是 not-our-module", r.reasonCode, "not-our-module");
  }

  // 7. 空内容 / 非字符串 → unreadable
  {
    t.eq("空串判 unreadable", judgePromptText("").verdict, "unreadable");
    t.eq("null 判 unreadable", judgePromptText(null).verdict, "unreadable");
    t.eq("undefined 判 unreadable", judgePromptText(undefined).verdict, "unreadable");
    t.eq("空串理由是 empty-text", judgePromptText("").reasonCode, "empty-text");
  }

  // 8. 标记优先于指纹检查（补丁里有整段替换 assembly 的变体）
  {
    const text = `${IDENTITY_MARKER}\n${INJECT_MARKERS[1]}\n// 已整段替换，不留原调用`;
    const r = judgePromptText(text);
    t.eq("标记齐全时不再要求指纹", r.verdict, "clean");
  }

  // 9. 两个 keeps 标记任一个都认
  {
    for (const marker of INJECT_MARKERS) {
      const r = judgePromptText(`${IDENTITY_MARKER}\n${marker}`);
      t.eq(`认标记 ${marker.slice(-24)}`, r.verdict, "clean");
    }
    t.eq("没有 keeps 标记时退回推断", judgePromptText(`${IDENTITY_MARKER}\n${MODULE_FINGERPRINT}`).reasonCode, "inferred");
  }

  // 10. hostPromptKeepsInject 与 judge 完全等价
  {
    const samples = [
      "",
      "other",
      `${IDENTITY_MARKER}\n${INJECT_MARKERS[0]}`,
      WRAPPED(`${MODULE_FINGERPRINT}`),
      WRAPPED(`${RAW_IDENTITY} // ${MODULE_FINGERPRINT}`),
      `${MODULE_FINGERPRINT} ${RAW_DROPS_INJECT}`,
      null,
    ];
    let same = true;
    for (const s of samples) {
      if (hostPromptKeepsInject(s) !== judgePromptText(s).ok) same = false;
    }
    t.ok("hostPromptKeepsInject 与 judgePromptText 一致", same);
  }

  // 11. judgePromptFile：读不到归 unreadable，不抛
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dshp-verdict-"));
    try {
      const missing = judgePromptFile(fs, path.join(dir, "nope.js"));
      t.eq("缺失文件判 unreadable", missing.verdict, "unreadable");
      t.ok("缺失文件不抛", missing.ok === false);
      const fp = path.join(dir, "ok.js");
      fs.writeFileSync(fp, `${IDENTITY_MARKER}\n${INJECT_MARKERS[0]}`, "utf8");
      const good = judgePromptFile(fs, fp);
      t.eq("正常文件判 clean", good.verdict, "clean");
      t.eq("结果带上路径", good.path, fp);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // 12. summarizeVerdicts
  {
    const all = summarizeVerdicts([{ verdict: "clean" }, { verdict: "clean" }]);
    t.ok("全 clean 时 ok", all.ok === true && all.counts.clean === 2);
    const mixed = summarizeVerdicts([{ verdict: "clean" }, { verdict: "dirty" }, { verdict: "foreign" }]);
    t.ok("混有非 clean 时 not ok", mixed.ok === false);
    t.eq("统计 dirty", mixed.counts.dirty, 1);
    t.eq("统计 foreign", mixed.counts.foreign, 1);
    t.ok("空列表不算 ok", summarizeVerdicts([]).ok === false);
  }
}
