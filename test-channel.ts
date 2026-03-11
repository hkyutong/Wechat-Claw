/**
 * YutoAI 微信节点的兼容运行时调试脚本。
 * 建议在服务器环境执行。
 */

import { wechatPlugin } from "./src/channel.js";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";

// ===== 模拟运行时配置 =====
const mockConfig: ClawdbotConfig = {
  channels: {
    wechat: {
      accounts: {
        default: {
          enabled: true,
          name: "测试账号",
          apiKey: "wc_live_test_xxxxxxxx",
          proxyUrl: "http://127.0.0.1:13800",
          deviceType: "ipad",
          proxy: "2",
          webhookPort: 18790,
          // webhookHost: "你的公网域名或 IP",
        },
      },
    },
  },
} as any;

// ===== 模拟运行时 API =====
const mockApi = {
  log: {
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    warn: (msg: string) => console.log(`[WARN] ${msg}`),
    error: (msg: string) => console.log(`[ERROR] ${msg}`),
  },

  setStatus: (status: any) => {
    console.log("[STATUS]", status);
  },
};

// ===== 调试配置模块 =====
async function testConfig() {
  console.log("\n📋 测试配置模块\n");

  // 检查 listAccountIds
  console.log("1. listAccountIds:");
  const accountIds = wechatPlugin.config!.listAccountIds!(mockConfig);
  console.log("   账号列表:", accountIds);

  // 检查 resolveAccount
  console.log("\n2. resolveAccount:");
  try {
    const account = await wechatPlugin.config!.resolveAccount!(mockConfig, "default");
    console.log("   账号信息:", {
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      apiKey: account.apiKey.slice(0, 10) + "...",
      deviceType: account.deviceType,
      webhookPort: account.webhookPort,
    });
  } catch (err: any) {
    console.log("   错误:", err.message);
  }

  // 检查 describeAccount
  console.log("\n3. describeAccount:");
  const account = await wechatPlugin.config!.resolveAccount!(mockConfig, "default");
  const description = wechatPlugin.config!.describeAccount!(account);
  console.log("   描述:", description);
}

// ===== 调试状态模块 =====
async function testStatus() {
  console.log("\n📊 测试状态模块\n");

  // 检查 probeAccount
  console.log("1. probeAccount:");
  try {
    const result = await wechatPlugin.status!.probeAccount!({
      cfg: mockConfig,
      accountId: "default",
    });
    console.log("   状态:", result);
  } catch (err: any) {
    console.log("   错误 (预期内，可能代理服务未启动):", err.message);
  }
}

// ===== 调试消息目标解析 =====
async function testMessaging() {
  console.log("\n💬 测试消息模块\n");

  // 检查 normalizeTarget
  console.log("1. normalizeTarget:");
  const testCases = [
    "user:wxid_abc123",
    "group:12345@chatroom",
    "wxid_direct",
    "wxid_xxx@chatroom",
  ];

  for (const target of testCases) {
    const normalized = wechatPlugin.messaging!.normalizeTarget!(target);
    console.log(`   "${target}" ->`, normalized);
  }

  // 检查 targetResolver
  console.log("\n2. targetResolver:");
  const resolver = wechatPlugin.messaging!.targetResolver!;
  console.log("   提示:", resolver.hint);

  const testIds = ["wxid_abc123", "12345@chatroom", "invalid_id"];
  for (const id of testIds) {
    const looksLikeId = resolver.looksLikeId!(id);
    console.log(`   "${id}" 看起来像ID?`, looksLikeId);
  }
}

// ===== 调试网关启动（可选，需要代理服务）=====
async function testGateway() {
  console.log("\n🚀 测试网关模块\n");
  console.log("注意: 这需要代理服务运行，跳过详细测试");

  // 这里只检查 gateway 对象存在
  console.log("1. gateway.startAccount 存在?", !!wechatPlugin.gateway?.startAccount);
}

// ===== 调试发送消息（可选，需要代理服务）=====
async function testOutbound() {
  console.log("\n📤 测试发送模块\n");
  console.log("注意: 这需要代理服务和登录状态，跳过详细测试");

  console.log("1. sendText 存在?", !!wechatPlugin.outbound?.sendText);
  console.log("2. sendMedia 存在?", !!wechatPlugin.outbound?.sendMedia);
}

// ===== 主调试流程 =====
async function main() {
  console.log("=".repeat(60));
  console.log("🧪 YutoAI 微信节点服务器调试");
  console.log("=".repeat(60));

  try {
    await testConfig();
  } catch (err: any) {
    console.error("配置测试失败:", err.message);
  }

  try {
    await testStatus();
  } catch (err: any) {
    console.error("状态测试失败:", err.message);
  }

  try {
    await testMessaging();
  } catch (err: any) {
    console.error("消息测试失败:", err.message);
  }

  try {
    await testGateway();
  } catch (err: any) {
    console.error("网关测试失败:", err.message);
  }

  try {
    await testOutbound();
  } catch (err: any) {
    console.error("发送测试失败:", err.message);
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ 基础调试完成");
  console.log("=".repeat(60));

  console.log("\n💡 下一步:");
  console.log("   1. 启动代理服务: cd proxy-service && npm run dev");
  console.log("   2. 运行集成测试: npx tsx test-integration.ts");
  console.log("   3. 或使用兼容运行时进行完整验证");
}

main().catch(console.error);
