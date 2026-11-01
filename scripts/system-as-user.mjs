#!/usr/bin/env node
/**
 * 中转兼容开关:告诉 dsh-purge 哪些 provider 会静默丢掉 role:"system"。
 *
 * patch #82 (SYSTEM_ROLE_AS_USER_FOR_RELAY) 读这个文件,把系统提示降级成 user 消息再发。
 *
 *   node scripts/system-as-user.mjs status
 *   node scripts/system-as-user.mjs on 192.168.31.250            # 按主机子串
 *   node scripts/system-as-user.mjs on relay.example.com,10.0.0.9:8080
 *   node scripts/system-as-user.mjs on '*'                        # 所有 provider
 *   node scripts/system-as-user.mjs off
 */
import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "../lib/core.js";

const home = findDshHome();
if (!home) {
  console.error("未找到 DSH_HOME(可用环境变量 DSH_HOME 指定)");
  process.exit(2);
}
const file = path.join(home, "system-as-user.txt");
const cmd = String(process.argv[2] || "status").toLowerCase();
const arg = process.argv.slice(3).join(",").trim();

function readHosts() {
  try {
    return String(fs.readFileSync(file, "utf8"))
      .split(/[\s,;]+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

if (cmd === "status") {
  const hosts = readHosts();
  console.log(`文件: ${file}`);
  console.log(hosts.length ? `已开启: ${hosts.join(", ")}` : "已关闭(系统提示仍按 system 角色发送)");
  process.exit(0);
}

if (cmd === "off") {
  try {
    fs.unlinkSync(file);
    console.log("已关闭:系统提示恢复 system 角色。新会话生效。");
  } catch {
    console.log("本来就是关闭状态。");
  }
  process.exit(0);
}

if (cmd === "on") {
  if (!arg) {
    console.error("用法: node scripts/system-as-user.mjs on <host1,host2|*>");
    process.exit(2);
  }
  const hosts = arg
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, hosts.join("\n") + "\n", "utf8");
  console.log(`已开启: ${hosts.join(", ")}`);
  console.log(`写入: ${file}`);
  console.log("需要重启 dsh(桌面端重启应用 / web 端重启 dsh web)并新开会话。");
  process.exit(0);
}

console.error(`未知命令: ${cmd}(status | on <hosts> | off)`);
process.exit(2);
