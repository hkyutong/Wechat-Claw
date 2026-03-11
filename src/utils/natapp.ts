interface NatappTunnel {
  name: string;
  public_url: string;
  proto: string;
  config: {
    addr: string;
  };
}

interface NatappResponse {
  tunnels: NatappTunnel[];
}

/**
 * 从 natapp 本地 API 获取隧道地址
 * @param webInterfacePort natapp Web Interface 端口，默认 4040
 * @returns 公网 URL (如 http://yourname.natapp1.cc)
 */
export async function getNatappTunnelUrl(
  webInterfacePort: number = 4040
): Promise<string | null> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${webInterfacePort}/api/tunnels`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as NatappResponse;

    // 只取 HTTP 隧道。
    const tunnel = data.tunnels.find((t) => t.proto === "http");

    return tunnel?.public_url || null;
  } catch (err) {
    return null;
  }
}

/**
 * 轮询等待 natapp 启动。
 */
export async function waitForNatappTunnel(
  webInterfacePort: number = 4040,
  maxAttempts: number = 30
): Promise<string> {
  console.log("⏳ 等待 natapp 隧道启动...");

  for (let i = 0; i < maxAttempts; i++) {
    const url = await getNatappTunnelUrl(webInterfacePort);

    if (url) {
      console.log(`✅ natapp 隧道已启动: ${url}`);
      return url;
    }

    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write(".");
  }

  throw new Error(
    "\n❌ 等待 natapp 超时，请检查:\n" +
      "  1. natapp 是否已启动: ./natapp -config=config.ini\n" +
      "  2. Web Interface 端口是否正确 (默认 4040)\n" +
      "  3. 隧道是否配置正确"
  );
}

/**
 * 拼接完整的 webhook URL。
 */
export async function getNatappWebhookUrl(
  webInterfacePort: number = 4040,
  path: string = "/webhook/wechat"
): Promise<string> {
  const tunnelUrl = await waitForNatappTunnel(webInterfacePort);
  return `${tunnelUrl}${path}`;
}
