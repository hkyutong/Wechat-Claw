/**
 * YutoAI 微信节点调试脚本。
 * 建议只在服务器环境运行，不在本地落任何构建产物。
 */

import { ProxyClient } from "./src/proxy-client.js";
import { startCallbackServer } from "./src/callback-server.js";

// ===== 调试配置 =====
const TEST_CONFIG = {
  apiKey: "test_api_key_xxx",
  accountId: "default",
  proxyUrl: "http://localhost:13800/v1", // 你的代理服务地址
};

// ===== 调试 1: ProxyClient =====
async function testProxyClient() {
  console.log("\n🧪 调试 ProxyClient...");

  const client = new ProxyClient({
    apiKey: TEST_CONFIG.apiKey,
    accountId: TEST_CONFIG.accountId,
    baseUrl: TEST_CONFIG.proxyUrl,
  });

  try {
    // 检查账号状态
    console.log("  - 调试 getStatus()");
    const status = await client.getStatus();
    console.log("  ✓ Status:", status);
  } catch (err: any) {
    console.log("  ✗ getStatus 调试失败:", err.message);
  }

  try {
    // 检查二维码拉取
    console.log("  - 调试 getQRCode()");
    const qr = await client.getQRCode("ipad", "2");
    console.log("  ✓ QRCode:", qr);
  } catch (err: any) {
    console.log("  ✗ getQRCode 调试失败:", err.message);
  }
}

// ===== 调试 2: 回调服务 =====
async function testCallbackServer() {
  console.log("\n🧪 调试 CallbackServer...");

  try {
    const { port, stop } = await startCallbackServer({
      port: 18790,
      apiKey: TEST_CONFIG.apiKey,
      onMessage: (message) => {
        console.log("  📩 收到消息:", message);
      },
    });

    console.log(`  ✓ 服务器启动在端口 ${port}`);

    // 5 秒后自动停止
    setTimeout(() => {
      stop();
      console.log("  ✓ 服务器已停止");
    }, 5000);
  } catch (err: any) {
    console.log("  ✗ 启动失败:", err.message);
  }
}

// ===== 调试 3: 模拟消息接收 =====
async function testWebhookReceive() {
  console.log("\n🧪 调试 Webhook 接收...");

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
    const response = await fetch("http://localhost:18790/webhook/wechat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testPayload),
    });

    console.log("  ✓ Webhook 响应:", response.status);
  } catch (err: any) {
    console.log("  ✗ Webhook 请求失败:", err.message);
  }
}

// ===== 主调试流程 =====
async function main() {
  console.log("🚀 开始 YutoAI 微信节点服务器调试\n");

  // 调试 ProxyClient
  await testProxyClient();

  // 调试回调服务
  await testCallbackServer();

  // 等待回调服务启动
  await new Promise((r) => setTimeout(r, 1000));

  // 调试 Webhook 接收
  await testWebhookReceive();

  console.log("\n✅ 调试完成");
  process.exit(0);
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
