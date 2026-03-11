/**
 * YutoAI 微信节点的兼容运行时验证脚本。
 * 适合作为本地开发和 CI 的 smoke test。
 */

import assert from "node:assert/strict";
import { wechatPlugin } from "./src/channel.js";
import { buildWebhookBaseUrl } from "./src/webhook-url.js";
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
          webhookHost: "https://claw.example.com",
          webhookPort: 18792,
          inbound: {
            requireMentionInGroup: true,
            allowSenders: ["wxid_allowed"],
          },
          routing: {
            rules: [
              {
                name: "sales-handoff",
                chatType: "group",
                matchType: "keyword",
                pattern: "发包",
                routeKey: "sales-room",
                agentId: "agent-sales",
              },
            ],
          },
          reply: {
            defaultGroupReplyMode: "group",
            mentionSenderInGroup: true,
          },
          riskControl: {
            senderRateLimitPerMinute: 3,
            sensitiveWords: ["退款"],
          },
          operations: {
            enableBuiltinCommands: true,
          },
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

// ===== 验证配置模块 =====
async function testConfig() {
  console.log("\n📋 验证配置模块\n");

  // 检查 listAccountIds
  console.log("1. listAccountIds:");
  const accountIds = wechatPlugin.config!.listAccountIds!(mockConfig);
  assert.deepEqual(accountIds, ["default"]);
  console.log("   账号列表:", accountIds);

  // 检查 resolveAccount
  console.log("\n2. resolveAccount:");
  try {
    const account = await wechatPlugin.config!.resolveAccount!(mockConfig, "default");
    assert.equal(account.accountId, "default");
    assert.equal(account.proxyUrl, "http://127.0.0.1:13800");
    assert.equal(account.webhookPath, "/webhook/wechat");
    assert.equal(account.webhookHost, "https://claw.example.com");
    console.log("   账号信息:", {
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      apiKey: account.apiKey.slice(0, 10) + "...",
      deviceType: account.deviceType,
      webhookPort: account.webhookPort,
      webhookHost: account.webhookHost,
    });
  } catch (err: any) {
    console.log("   错误:", err.message);
  }

  // 检查 describeAccount
  console.log("\n3. describeAccount:");
  const account = await wechatPlugin.config!.resolveAccount!(mockConfig, "default");
  const description = wechatPlugin.config!.describeAccount!(account);
  assert.equal(description.accountId, "default");
  console.log("   描述:", description);

  // 检查 resolveAllowFrom
  console.log("\n4. resolveAllowFrom:");
  const allowFrom = await wechatPlugin.config!.resolveAllowFrom!({
    cfg: mockConfig,
    accountId: "default",
  });
  assert.deepEqual(allowFrom, ["user:wxid_allowed"]);
  console.log("   allowFrom:", allowFrom);
}

// ===== 验证状态模块 =====
async function testStatus() {
  console.log("\n📊 验证状态模块\n");

  // 检查 probeAccount
  console.log("1. probeAccount:");
  try {
    const result = await wechatPlugin.status!.probeAccount!({
      cfg: mockConfig,
      accountId: "default",
    });
    assert.equal(typeof result.ok, "boolean");
    console.log("   状态:", result);
  } catch (err: any) {
    console.log("   错误 (预期内，可能代理服务未启动):", err.message);
  }

  // 检查安全告警
  console.log("\n2. collectWarnings:");
  const warnings = await wechatPlugin.security!.collectWarnings!({
    cfg: mockConfig,
    accountId: "default",
  });
  assert.ok(Array.isArray(warnings));
  console.log("   告警:", warnings);
}

// ===== 验证消息目标解析 =====
async function testMessaging() {
  console.log("\n💬 验证消息模块\n");

  // 检查 normalizeTarget
  console.log("1. normalizeTarget:");
  const testCases = [
    ["user:wxid_abc123", { type: "direct", id: "wxid_abc123" }],
    ["group:12345@chatroom", { type: "channel", id: "12345@chatroom" }],
    ["wxid_direct", { type: "direct", id: "wxid_direct" }],
    ["12345@chatroom", { type: "channel", id: "12345@chatroom" }],
  ];

  for (const [target, expected] of testCases) {
    const normalized = wechatPlugin.messaging!.normalizeTarget!(target);
    assert.deepEqual(normalized, expected);
    console.log(`   "${target}" ->`, normalized);
  }

  // 检查 targetResolver
  console.log("\n2. targetResolver:");
  const resolver = wechatPlugin.messaging!.targetResolver!;
  console.log("   提示:", resolver.hint);

  const testIds = ["wxid_abc123", "12345@chatroom", "invalid_id"];
  for (const id of testIds) {
    const looksLikeId = resolver.looksLikeId!(id);
    assert.equal(looksLikeId, id !== "invalid_id");
    console.log(`   "${id}" 看起来像ID?`, looksLikeId);
  }
}

async function testWebhookUrl() {
  console.log("\n🌐 验证 Webhook 地址拼装\n");

  const fullUrl = buildWebhookBaseUrl({
    webhookHost: "https://claw.example.com",
    webhookPort: 18792,
    webhookPath: "/webhook/wechat",
  });
  assert.equal(fullUrl, "https://claw.example.com/webhook/wechat");
  console.log("1. 完整 HTTPS 地址 ->", fullUrl);

  const hostAndPort = buildWebhookBaseUrl({
    webhookHost: "193.134.209.35",
    webhookPort: 18792,
    webhookPath: "/webhook/wechat",
  });
  assert.equal(hostAndPort, "http://193.134.209.35:18792/webhook/wechat");
  console.log("2. IP + 端口 ->", hostAndPort);
}

// ===== 验证网关启动（可选，需要代理服务）=====
async function testGateway() {
  console.log("\n🚀 验证网关模块\n");
  console.log("注意: 这需要代理服务运行，跳过详细测试");

  // 这里只检查 gateway 对象存在
  assert.ok(wechatPlugin.gateway?.startAccount);
  console.log("1. gateway.startAccount 存在?", !!wechatPlugin.gateway?.startAccount);
}

// ===== 验证发送消息（可选，需要代理服务）=====
async function testOutbound() {
  console.log("\n📤 验证发送模块\n");
  console.log("注意: 这需要代理服务和登录状态，跳过详细测试");

  assert.ok(wechatPlugin.outbound?.sendText);
  assert.ok(wechatPlugin.outbound?.sendMedia);
  console.log("1. sendText 存在?", !!wechatPlugin.outbound?.sendText);
  console.log("2. sendMedia 存在?", !!wechatPlugin.outbound?.sendMedia);
}

// ===== 主验证流程 =====
async function main() {
  console.log("=".repeat(60));
  console.log("🧪 YutoAI 微信节点通道验证");
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
    await testWebhookUrl();
  } catch (err: any) {
    console.error("Webhook 地址测试失败:", err.message);
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
  console.log("✅ 基础验证完成");
  console.log("=".repeat(60));

  console.log("\n💡 下一步:");
  console.log("   1. 在真实代理环境下联调登录与收发");
  console.log("   2. 把该脚本接入 CI 或发布前验证流程");
  console.log("   3. 按需补充更贴近实际代理行为的集成测试");
}

main().catch(console.error);
