import type { ProxyClientConfig, LoginStatus } from "./types.js";

export class ProxyClient {
  private apiKey: string;
  private accountId: string;
  readonly baseUrl: string;

  constructor(config: ProxyClientConfig) {
    this.apiKey = config.apiKey;
    this.accountId = config.accountId;
    if (!config.baseUrl) {
      throw new Error("proxyUrl is required. Please configure it in your config.");
    }
    this.baseUrl = config.baseUrl;
  }

  private async request(endpoint: string, data?: any): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        "X-Account-ID": this.accountId,
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    const result = await response.json().catch(() => ({
      error: `HTTP ${response.status}: ${response.statusText}`,
    }));

    if (!response.ok) {
      throw new Error(result.error || result.message || `Request failed: ${response.status}`);
    }

    // 代理服务返回格式: { code, message, data }
    // 转换为插件期望的格式
    // 1000: success, 1001: delayed (login required), 1002: success with warning
    if (result.code === "1000" || result.code === "1001" || result.code === "1002") {
      return result.data || result;
    }

    if (result.code && result.code !== "1000") {
      throw new Error(result.message || `Error: ${result.code}`);
    }

    return result;
  }

  // ===== Account Status =====

  async getStatus(): Promise<{
    valid: boolean;
    wcId?: string;
    isLoggedIn: boolean;
    nickName?: string;
    tier?: string;
    quota?: {
      maxMessagesPerDay: number;
      usedToday: number;
    };
    error?: string;
  }> {
    const result = await this.request("/v1/account/status");
    return {
      valid: result.valid ?? true,
      wcId: result.wcId,
      isLoggedIn: result.isLoggedIn ?? false,
      nickName: result.nickName,
      tier: result.tier,
      quota: result.quota,
    };
  }

  // ===== Login Flow =====

  async getQRCode(deviceType?: string, proxy?: string): Promise<{
    qrCodeUrl: string;
    wId: string;
  }> {
    const result = await this.request("/v1/iPadLogin", {
      deviceType: deviceType || "mac",
      proxy: proxy || "10",
    });
    return {
      wId: result.wId,
      qrCodeUrl: result.qrCodeUrl,
    };
  }

  async checkLogin(wId: string): Promise<LoginStatus> {
    const result = await this.request("/v1/getIPadLoginInfo", { wId });

    if (result.status === "logged_in") {
      return {
        status: "logged_in",
        wcId: result.wcId,
        nickName: result.nickName,
        headUrl: result.headUrl,
      };
    }

    if (result.status === "need_verify") {
      return {
        status: "need_verify",
        verifyUrl: result.verifyUrl,
      };
    }

    return { status: "waiting" };
  }

  // ===== Message Sending =====

  async sendText(wcId: string, content: string): Promise<{
    msgId: number;
    newMsgId: number;
    createTime: number;
  }> {
    // 直接发送 wcId，代理服务会自动查找对应的 wId
    const result = await this.request("/v1/sendText", {
      wcId,
      content
    });

    return {
      msgId: result.msgId,
      newMsgId: result.newMsgId,
      createTime: result.createTime,
    };
  }

  async sendImage(wcId: string, imageUrl: string): Promise<{
    msgId: number;
    newMsgId: number;
    createTime: number;
  }> {
    // 直接发送 wcId，代理服务会自动查找对应的 wId
    const result = await this.request("/v1/sendImage2", {
      wcId,
      imageUrl
    });

    return {
      msgId: result.msgId,
      newMsgId: result.newMsgId,
      createTime: result.createTime,
    };
  }

  // ===== Contacts =====

  async getContacts(wcId: string): Promise<{
    friends: string[];
    chatrooms: string[];
  }> {
    // 直接发送 wcId，代理服务会自动查找对应的 wId
    const result = await this.request("/v1/getAddressList", {
      wcId
    });

    return {
      friends: result.friends || [],
      chatrooms: result.chatrooms || [],
    };
  }

  // ===== Webhook =====

  /**
   * Register plugin webhook URL with Proxy.
   * Proxy forwards upstream messages to this URL.
   */
  async registerWebhook(webhookUrl: string): Promise<void> {
    await this.request("/v1/webhook/register", {
      webhookUrl
    });
  }
}
