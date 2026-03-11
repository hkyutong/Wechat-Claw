/**
 * YutoAI 微信节点的轻量二维码输出。
 * 这里不依赖额外终端库，只输出扫码链接。
 */

export async function displayQRCode(url: string): Promise<void> {
  console.log("\n");
  console.log("=".repeat(60));
  console.log("📱 请使用微信扫描二维码登录");
  console.log("=".repeat(60));
  console.log("\n");
  console.log("🔗 二维码地址:");
  console.log(`   ${url}`);
  console.log("\n");
  console.log("💡 提示: 如果无法扫描，请复制上面的链接到浏览器打开");
  console.log("=".repeat(60));
  console.log("\n");
}

export function displayLoginSuccess(nickName: string, wcId: string): void {
  console.log("\n");
  console.log("✅".repeat(30));
  console.log("✅                                                          ✅");
  console.log(`✅  登录成功！${" ".repeat(48)}✅`);
  console.log("✅                                                          ✅");
  console.log(`✅  昵称: ${nickName.padEnd(49)}✅`);
  console.log(`✅  微信号: ${wcId.padEnd(47)}✅`);
  console.log("✅                                                          ✅");
  console.log("✅".repeat(30));
  console.log("\n");
}
