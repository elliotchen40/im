#!/usr/bin/env node
/**
 * 静态一致性守门 —— 零依赖，只读，不需要 npm install 就能跑。
 *
 * 为什么需要它：本项目的开发机可能没有网络/没有装依赖（或工具约束不允许写
 * node_modules），但「移植是否留下断链」必须能验证。本脚本检查：
 *
 *   1) 所有相对 import / export ... from 的目标文件存在
 *      （ESM + Node16 解析下必须写 `.js` 后缀，但磁盘上是 `.ts` —— 逐个映射）
 *   2) 渠道层改造后不应再有任何 `weixin/` 引用（渠道抽象是否彻底）
 *   3) 关键导出符号存在（把「改了调用方忘了改实现」这类错误挡在编译前）
 *
 * 用法：
 *   node scripts/check_imports.mjs [srcDir]
 *   退出码 0 = 通过；1 = 发现问题
 */

import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(process.argv[2] ?? "src");

/** 递归收集 .ts 文件 */
function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 把 import 说明符解析为磁盘文件路径（.js → .ts） */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // 第三方或 node: 内置，跳过
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [];
  if (spec.endsWith(".js")) {
    candidates.push(base.slice(0, -3) + ".ts");
    candidates.push(base); // 万一真的是 .js 文件
  } else {
    candidates.push(base + ".ts");
    candidates.push(path.join(base, "index.ts"));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return { missing: candidates[0] };
}

const files = collect(SRC_DIR, []);
const problems = [];
let importCount = 0;

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;'"]*?from\s+["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

for (const file of files) {
  const text = fs.readFileSync(file, "utf-8");
  const rel = path.relative(process.cwd(), file);

  // 1) 相对 import 目标存在
  const specs = [];
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  }
  for (const spec of specs) {
    importCount++;
    const r = resolveSpecifier(file, spec);
    if (r && r.missing) {
      problems.push(`${rel}: import "${spec}" → 找不到文件 (期望 ${path.relative(process.cwd(), r.missing)})`);
    }
  }

  // 2) 渠道抽象彻底性：不应再有 weixin/ 引用
  if (/from\s+["'][^"']*weixin\//.test(text)) {
    problems.push(`${rel}: 仍引用 weixin/ —— 渠道抽象未彻底`);
  }
  // 3) 凭证对象不应再出现（改造后由 Channel 内部持有）
  if (/\bcredentials\b/.test(text) && !/credentials?\.json|credential/i.test(text)) {
    if (/req|ctx\.credentials|this\.credentials/.test(text)) {
      problems.push(`${rel}: 仍引用 credentials —— 应改走 Channel`);
    }
  }
}

// 4) 关键导出符号存在性
const REQUIRED_EXPORTS = [
  ["src/channel/types.ts", ["Channel", "InboundMessage", "OutboundMessage", "ChannelPollResult"]],
  ["src/channel/http_channel.ts", ["HttpChannel"]],
  ["src/commands.ts", ["formatHelp", "formatStatus", "handleMemoryCommand"]],
  ["src/care/scheduled_tick.ts", ["runScheduledCareTick"]],
  ["src/bot.ts", ["Bot", "BotContext"]],
];
for (const [rel, names] of REQUIRED_EXPORTS) {
  const p = path.join(path.dirname(SRC_DIR), rel);
  if (!fs.existsSync(p)) {
    problems.push(`缺少必需文件: ${rel}`);
    continue;
  }
  const text = fs.readFileSync(p, "utf-8");
  for (const name of names) {
    const re = new RegExp(
      `export\\s+(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?` +
        `(?:interface|class|function|const|let|var|type|enum)\\s+${name}\\b`,
    );
    if (!re.test(text)) problems.push(`${rel}: 未找到导出 ${name}`);
  }
}

console.log(`[check_imports] 扫描 ${files.length} 个 .ts 文件，${importCount} 条相对 import`);
if (problems.length === 0) {
  console.log("[check_imports] ✅ 全部通过：无断链、无 weixin 残留、关键导出齐全");
  process.exit(0);
}
console.error(`[check_imports] ❌ 发现 ${problems.length} 个问题：`);
for (const p of problems) console.error("  - " + p);
process.exit(1);
