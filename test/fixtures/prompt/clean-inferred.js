// fixture：没有补丁标记，但两处旧拦截都不在了（推断为干净）
export default async function (ctx) {
  const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
  const purge = (transformed.sections || []).filter((s) => String(s && s.name || "").startsWith("dsh-purge"));
  return [...purge, ...(transformed.sections || []).filter((s) => !String(s && s.name || "").startsWith("dsh-purge"))];
}
