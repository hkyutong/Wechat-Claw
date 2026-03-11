/**
 * OpenClaw 微信通道插件验证脚本。
 * 用于验证 Webhook 回调与鉴权逻辑。
 */

import assert from "node:assert/strict";
import plugin from "./index.js";
import { ProxyClient } from "./src/proxy-client.js";
import { startCallbackServer } from "./src/callback-server.js";
import type { WechatMessageContext } from "./src/types.js";
import { buildWebhookAuthToken, attachWebhookAuthToken } from "./src/webhook-auth.js";

// ===== 验证配置 =====
const TEST_CONFIG = {
  apiKey: "test_api_key_xxx",
  accountId: "default",
  proxyUrl: "http://localhost:13800/v1", // 你的代理服务地址
};

const WEBHOOK_AUTH_TOKEN = buildWebhookAuthToken(
  TEST_CONFIG.accountId,
  TEST_CONFIG.apiKey
);
let receivedMessage: WechatMessageContext | null = null;

function testPluginMetadata() {
  console.log("\n🧪 验证插件元数据...");
  assert.equal(plugin.id, "wechat", "插件 id 应与 OpenClaw 通道标识一致");
  assert.equal(plugin.name, "OpenClaw WeChat");
  console.log("  ✓ 插件 id 与 OpenClaw 运行时标识对齐");
}

// ===== 验证 1: ProxyClient =====
async function testProxyClient() {
  console.log("\n🧪 验证 ProxyClient...");

  const client = new ProxyClient({
    apiKey: TEST_CONFIG.apiKey,
    accountId: TEST_CONFIG.accountId,
    baseUrl: TEST_CONFIG.proxyUrl,
  });

  try {
    // 检查账号状态
    console.log("  - 验证 getStatus()");
    const status = await client.getStatus();
    console.log("  ✓ Status:", status);
  } catch (err: any) {
    console.log("  ✗ getStatus 验证失败:", err.message);
  }

  try {
    // 检查二维码拉取
    console.log("  - 验证 getQRCode()");
    const qr = await client.getQRCode("ipad", "2");
    console.log("  ✓ QRCode:", qr);
  } catch (err: any) {
    console.log("  ✗ getQRCode 验证失败:", err.message);
  }
}

// ===== 验证 2: 回调服务 =====
async function testCallbackServer() {
  console.log("\n🧪 验证 CallbackServer...");

  try {
    const { port, stop } = await startCallbackServer({
      port: 18790,
      authToken: WEBHOOK_AUTH_TOKEN,
      onMessage: (message) => {
        receivedMessage = message;
        console.log("  📩 收到消息:", message);
      },
    });

    console.log(`  ✓ 回调服务启动在端口 ${port}`);

    // 5 秒后自动停止
    setTimeout(() => {
      stop();
      console.log("  ✓ 回调服务已停止");
    }, 5000);
  } catch (err: any) {
    console.log("  ✗ 启动失败:", err.message);
  }
}

// ===== 验证 3: 模拟消息接收 =====
async function testWebhookReceive() {
  console.log("\n🧪 验证 Webhook 接收...");

  // 模拟发送一个 webhook 请求到本地服务
  const testPayload = {
    messageType: "60001",
    wcId: "wxid_test123",
    timestamp: Date.now(),
    data: {
      newMsgId: 123456789,
      fromUser: "wxid_fromuser",
      content: "测试消息",
      timestamp: Date.now(),
    },
  };

  try {
    const unauthorized = await fetch("http://localhost:18790/webhook/wechat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testPayload),
    });
    assert.equal(unauthorized.status, 401, "未鉴权请求应返回 401");
    console.log("  ✓ 未鉴权请求被拒绝:", unauthorized.status);

    const response = await fetch(
      attachWebhookAuthToken("http://localhost:18790/webhook/wechat", WEBHOOK_AUTH_TOKEN),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testPayload),
      }
    );
    assert.equal(response.status, 200, "鉴权后的 webhook 应返回 200");
    assert.ok(receivedMessage, "回调服务应收到消息");
    assert.equal(receivedMessage.content, "测试消息");

    console.log("  ✓ Webhook 响应:", response.status);
  } catch (err: any) {
    console.log("  ✗ Webhook 请求失败:", err.message);
    throw err;
  }
}

// ===== 主验证流程 =====
async function main() {
  console.log("🚀 开始 OpenClaw 微信通道插件验证\n");

  testPluginMetadata();

  // 验证 ProxyClient
  await testProxyClient();

  // 验证回调服务
  await testCallbackServer();

  // 等待回调服务启动
  await new Promise((r) => setTimeout(r, 1000));

  // 验证 Webhook 接收
  await testWebhookReceive();

  console.log("\n✅ 验证完成");
  process.exit(0);
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
