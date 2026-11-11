// fixture：注入被压成一节，waterfall 结果被丢掉
export default async function (ctx) {
  const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
  const sections = completeSection === void 0 ? transformed.sections : [{ ...base, text: inject + "\n\n" + base.text }];
  return sections; // transformed.sections : [completeSection]
}
