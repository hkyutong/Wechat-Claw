import type { ProxyClientConfig, LoginStatus } from "./types.js";

export class ProxyClient {
  private apiKey: string;
  private accountId: string;
  readonly baseUrl: string;

  constructor(config: ProxyClientConfig) {
    this.apiKey = config.apiKey;
    this.accountId = config.accountId;
    if (!config.baseUrl) {
      throw new Error("proxyUrl 必填，请在配置中提供可用的代理地址。");
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
    // 这里统一折叠成节点内部使用的结果对象。
    if (result.code === "1000" || result.code === "1001" || result.code === "1002") {
      return result.data || result;
    }

    if (result.code && result.code !== "1000") {
      throw new Error(result.message || `Error: ${result.code}`);
    }

    return result;
  }

  // ===== 账号状态 =====

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

  // ===== 登录流程 =====

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

  // ===== 消息发送 =====

  async sendText(wcId: string, content: string): Promise<{
    msgId: number;
    newMsgId: number;
    createTime: number;
  }> {
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

  // ===== 联系人 =====

  async getContacts(wcId: string): Promise<{
    friends: string[];
    chatrooms: string[];
  }> {
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
   * 向代理服务注册回调地址。
   */
  async registerWebhook(wcId: string, webhookUrl: string): Promise<void> {
    await this.request("/v1/webhook/register", {
      wcId,
      webhookUrl
    });
  }
}
