// fixture：身份行没被剥掉（最典型的漏补丁）
const identity = { text: "You are an AI agent powered by DeepSeek Harness." };
export default async function (ctx) {
  const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
  return [...transformed.sections, identity];
}
