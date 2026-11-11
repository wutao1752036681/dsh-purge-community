/**
 * lib/core.js 的 restartGateVerdict()：重启闸门到底拦什么。
 *
 * 原来这段埋在 ensureHostClean() 里，写的是
 * `if (pending.length || blocking.length || !flashOk) return { ok: false }`。
 * flash 是 CMD 闪窗那一组（ensureHiddenConsole / stubDoctorSupervisor / …），
 * 在钉不进去的机器上永远是 false —— 于是每次点重启都先被取消一次：补齐 → 仍然
 * 不 ok → 取消。用户看到的就是「第一次点没反应，第二次才行」。
 *
 * 新判定只有一条取消理由：补丁真的没写进宿主。flash 不 ok 降级成 flashWarn，
 * 由界面提示，不再挡住重启。这几条锁死它。
 */
const core = await import(new URL("../lib/core.js", import.meta.url).href);
const { restartGateVerdict } = core;

export default async (t) => {
  await t.group("放行：补丁都写了", async () => {
    const v = restartGateVerdict({ pending: [], blocking: [], flashOk: true });
    t.eq("ok", v.ok, true);
    t.eq("reason", v.reason, "clean");
    t.eq("flashWarn", v.flashWarn, false);
  });

  await t.group("flash 不 ok 不再取消重启（回归）", async () => {
    const v = restartGateVerdict({ pending: [], blocking: [], flashOk: false });
    t.eq("仍然放行", v.ok, true);
    t.eq("reason 仍是 clean", v.reason, "clean");
    t.eq("但标记 flashWarn", v.flashWarn, true);
  });

  await t.group("pending 非空仍然拦", async () => {
    const v = restartGateVerdict({ pending: [3, 17], blocking: [], flashOk: true });
    t.eq("拦下", v.ok, false);
    t.eq("reason", v.reason, "patches-not-written");
    t.eq("pending 原样透传", v.pending.join(","), "3,17");
    t.eq("failed 为 0", v.failed, 0);
    t.eq("拦下时不带 flashWarn", v.flashWarn, false);
  });

  await t.group("有真正失败的补丁也拦", async () => {
    const v = restartGateVerdict({ pending: [], blocking: [{ patch_id: 1 }, { patch_id: 2 }], flashOk: true });
    t.eq("拦下", v.ok, false);
    t.eq("failed 计数", v.failed, 2);
    t.eq("pending 为空", v.pending.length, 0);
  });

  await t.group("两者都有", async () => {
    const v = restartGateVerdict({ pending: [7], blocking: [{}], flashOk: false });
    t.eq("拦下", v.ok, false);
    t.eq("pending 保留", v.pending.join(","), "7");
    t.eq("failed 保留", v.failed, 1);
  });

  await t.group("缺参不炸", async () => {
    const v = restartGateVerdict();
    t.eq("无参放行", v.ok, true);
    t.eq("flashOk 没给就当警告", v.flashWarn, true);
    t.eq("pending 是空数组", v.pending.length, 0);
  });

  await t.group("脏入参归一化", async () => {
    const a = restartGateVerdict({ pending: null, blocking: null, flashOk: true });
    t.eq("null 视为空", a.ok, true);
    const b = restartGateVerdict({ pending: "3", blocking: 0, flashOk: true });
    t.eq("非数组视为空", b.ok, true);
    t.eq("不把字符串当 pending 列表", b.pending.length, 0);
    const c = restartGateVerdict({ pending: [], blocking: [], flashOk: undefined });
    t.eq("flashOk undefined 当警告", c.flashWarn, true);
    t.eq("但仍放行", c.ok, true);
  });
};
