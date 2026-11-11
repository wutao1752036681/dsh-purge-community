import { judgePromptText } from "./prompt-verdict.js";

/** 重启前看系统提示词文件：标记写上了，或者当前原文里已经没有那两处旧拦截。 */
export function hostPromptKeepsInject(text) {
  return judgePromptText(text).ok;
}
