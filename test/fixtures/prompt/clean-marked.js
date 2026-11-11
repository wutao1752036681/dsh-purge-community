// fixture：洗过且注入保留（标记齐全）
export const section = { name: "dsh-purge", text: "" };
export function assemble(transformed) {
  return transformed.sections;
}
// [dsh-purge] identity stripped
// [dsh-purge] complete prompt keeps waterfall inject
