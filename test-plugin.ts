/**
 * 插件本地测试脚本 - 不依赖外部运行时
 */

import { ProxyClient } from "./src/proxy-client.js";
import { startCallbackServer } from "./src/callback-server.js";

// ===== 测试配置 =====
const TEST_CONFIG = {
  apiKey: "test_api_key_xxx",
  accountId: "default",
  proxyUrl: "http://localhost:3000/v1", // 你的代理服务地址
};

// ===== 测试 1: ProxyClient =====
async function testProxyClient() {
  console.log("\n🧪 测试 ProxyClient...");

  const client = new ProxyClient({
    apiKey: TEST_CONFIG.apiKey,
    accountId: TEST_CONFIG.accountId,
    baseUrl: TEST_CONFIG.proxyUrl,
  });

  try {
    // 测试获取状态
    console.log("  - 测试 getStatus()");
    const status = await client.getStatus();
    console.log("  ✓ Status:", status);
  } catch (err: any) {
    console.log("  ✗ getStatus 失败:", err.message);
  }

  try {
    // 测试获取二维码
    console.log("  - 测试 getQRCode()");
    const qr = await client.getQRCode("ipad", "2");
    console.log("  ✓ QRCode:", qr);
  } catch (err: any) {
    console.log("  ✗ getQRCode 失败:", err.message);
  }
}

// ===== 测试 2: Callback Server =====
async function testCallbackServer() {
  console.log("\n🧪 测试 CallbackServer...");

  try {
    const { port, stop } = await startCallbackServer({
      port: 18790,
      apiKey: TEST_CONFIG.apiKey,
      onMessage: (message) => {
        console.log("  📩 收到消息:", message);
      },
    });

    console.log(`  ✓ 服务器启动在端口 ${port}`);

    // 5秒后停止
    setTimeout(() => {
      stop();
      console.log("  ✓ 服务器已停止");
    }, 5000);
  } catch (err: any) {
    console.log("  ✗ 启动失败:", err.message);
  }
}

// ===== 测试 3: 模拟消息接收 =====
async function testWebhookReceive() {
  console.log("\n🧪 测试 Webhook 接收...");

  // 模拟发送一个 webhook 请求到本地服务器
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

// ===== 主测试流程 =====
async function main() {
  console.log("🚀 开始 Wechat-Claw 本地测试\n");

  // 测试 ProxyClient
  await testProxyClient();

  // 测试 CallbackServer
  await testCallbackServer();

  // 等待服务器启动
  await new Promise((r) => setTimeout(r, 1000));

  // 测试 Webhook 接收
  await testWebhookReceive();

  console.log("\n✅ 测试完成");
  process.exit(0);
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
