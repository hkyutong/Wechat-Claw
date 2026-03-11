import type { LoginStatus, ProxyClientConfig, WechatProvider } from "./types.js";

type StatusResult = {
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
};

type RequestOptions = {
  method?: "GET" | "POST" | "PUT";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
};

type WeChatPadProResult = {
  code?: number;
  Code?: number;
  success?: boolean;
  Success?: boolean;
  message?: string;
  Message?: string;
  msg?: string;
  Msg?: string;
  text?: string;
  Text?: string;
  data?: any;
  Data?: any;
  [key: string]: any;
};

const WECHATPADPRO_DEFAULT_MESSAGE_TYPES = ["1", "3", "34", "43", "47", "49", "10000"];

export class ProxyClient {
  private apiKey: string;
  private accountId: string;
  readonly baseUrl: string;
  readonly provider: WechatProvider;
  private deviceType: string;
  private proxy: string;
  private loginProxyUrl?: string;
  private deviceName?: string;
  private deviceId?: string;
  private webhookSecret?: string;
  private webhookMessageTypes: string[];
  private webhookIncludeSelfMessage: boolean;
  private webhookRetryCount: number;
  private webhookTimeoutSec: number;

  constructor(config: ProxyClientConfig) {
    this.apiKey = config.apiKey;
    this.accountId = config.accountId;
    this.provider = config.provider || "legacy";
    this.deviceType = config.deviceType || "ipad";
    this.proxy = config.proxy || "2";
    this.loginProxyUrl = config.loginProxyUrl;
    this.deviceName = config.deviceName;
    this.deviceId = config.deviceId;
    this.webhookSecret = config.webhookSecret;
    this.webhookMessageTypes = config.webhookMessageTypes || WECHATPADPRO_DEFAULT_MESSAGE_TYPES;
    this.webhookIncludeSelfMessage = config.webhookIncludeSelfMessage ?? false;
    this.webhookRetryCount = config.webhookRetryCount ?? 3;
    this.webhookTimeoutSec = config.webhookTimeoutSec ?? 10;

    if (!config.baseUrl) {
      throw new Error("proxyUrl 必填，请在配置中提供可用的代理地址。");
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  private buildUrl(endpoint: string, query?: RequestOptions["query"]): string {
    const url = new URL(endpoint, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async requestLegacy(endpoint: string, data?: any): Promise<any> {
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

    const result: any = await response.json().catch(() => ({
      error: `HTTP ${response.status}: ${response.statusText}`,
    }));

    if (!response.ok) {
      throw new Error(result.error || result.message || `Request failed: ${response.status}`);
    }

    if (result.code === "1000" || result.code === "1001" || result.code === "1002") {
      return result.data || result;
    }

    if (result.code && result.code !== "1000") {
      throw new Error(result.message || `Error: ${result.code}`);
    }

    return result;
  }

  private buildWeChatPadProHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      ...(extra || {}),
    };
  }

  private extractWeChatPadProMessage(result: WeChatPadProResult | null | undefined, response?: Response): string {
    return (
      result?.Text ||
      result?.Message ||
      result?.Msg ||
      result?.message ||
      result?.msg ||
      result?.text ||
      (response ? `HTTP ${response.status}: ${response.statusText}` : "未知错误")
    );
  }

  private getWeChatPadProCode(result: WeChatPadProResult | null | undefined): number | undefined {
    if (!result) {
      return undefined;
    }
    return typeof result.code === "number"
      ? result.code
      : typeof result.Code === "number"
        ? result.Code
        : undefined;
  }

  private getWeChatPadProData(result: WeChatPadProResult | null | undefined): any {
    if (!result) {
      return undefined;
    }
    return result.data ?? result.Data;
  }

  private isWeChatPadProSuccess(result: WeChatPadProResult | null | undefined): boolean {
    if (!result) return false;
    const code = this.getWeChatPadProCode(result);
    const data = this.getWeChatPadProData(result);
    if (result.success === true || result.Success === true) return true;
    if (code === 0 || code === 200) return true;
    if (code === undefined && data !== undefined) return true;
    return false;
  }

  private async requestWeChatPadProRaw(
    endpoints: string[],
    options: RequestOptions = {}
  ): Promise<WeChatPadProResult> {
    let lastError: Error | null = null;

    for (const endpoint of endpoints) {
      try {
        const url = this.buildUrl(endpoint, options.query);
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: options.headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });

        const result = (await response.json().catch(() => null)) as WeChatPadProResult | null;
        if (!response.ok) {
          throw new Error(this.extractWeChatPadProMessage(result, response));
        }

        if (!result) {
          return {};
        }

        return result;
      } catch (error: any) {
        lastError = error;
      }
    }

    throw lastError || new Error("WeChatPadPro 请求失败");
  }

  private async requestWeChatPadPro(
    endpoints: string[],
    options: RequestOptions = {}
  ): Promise<any> {
    const result = await this.requestWeChatPadProRaw(endpoints, options);
    if (this.isWeChatPadProSuccess(result)) {
      return this.getWeChatPadProData(result) ?? result;
    }
    throw new Error(this.extractWeChatPadProMessage(result));
  }

  private normalizeWeChatPadProProfile(profile: any): {
    wcId?: string;
    nickName?: string;
    headUrl?: string;
  } {
    if (!profile || typeof profile !== "object") {
      return {};
    }

    const user = profile.userInfo && typeof profile.userInfo === "object"
      ? profile.userInfo
      : profile;

    return {
      wcId: user.wxid || user.wxId || user.userName || user.UserName,
      nickName: user.nickname || user.nickName || user.NickName,
      headUrl: user.avatar || user.headUrl || user.headImgUrl || user.HeadImgUrl,
    };
  }

  private isLikelyWeChatPadProAuthError(message: string): boolean {
    return /授权|auth|token|令牌|forbidden|unauthorized|invalid/i.test(message);
  }

  private isLikelyWeChatPadProNotLoggedIn(message: string): boolean {
    return /未登录|离线|offline|not\s*login|no\s*login|不存在状态|未初始化|重新登录/i.test(message);
  }

  private pickWeChatPadProLoginUrl(data: any): string | undefined {
    return (
      data?.QrLink ||
      data?.qrLink ||
      data?.qrCodeLink ||
      data?.QrCodeLink ||
      data?.qrcodeUrl ||
      data?.qrCodeUrl ||
      data?.QrCodeUrl ||
      data?.qrcode ||
      data?.qr ||
      data?.QrBase64 ||
      data?.qrCodeBase64 ||
      data?.QrCodeBase64 ||
      data?.QrBase64Data
    );
  }

  // ===== 账号状态 =====

  async getStatus(): Promise<StatusResult> {
    if (this.provider === "legacy") {
      const result = await this.requestLegacy("/v1/account/status");
      return {
        valid: result.valid ?? true,
        wcId: result.wcId,
        isLoggedIn: result.isLoggedIn ?? false,
        nickName: result.nickName,
        tier: result.tier,
        quota: result.quota,
      };
    }

    try {
      const profile = await this.requestWeChatPadPro(
        ["/user/GetProfile", "/api/user/GetProfile"],
        {
          method: "GET",
          query: {
            key: this.apiKey,
            authcode: this.apiKey,
          },
          headers: this.buildWeChatPadProHeaders(),
        }
      );
      const { wcId, nickName, headUrl } = this.normalizeWeChatPadProProfile(profile);
      return {
        valid: true,
        wcId,
        isLoggedIn: !!wcId,
        nickName,
      };
    } catch (error: any) {
      const message = String(error?.message || error);
      if (this.isLikelyWeChatPadProAuthError(message)) {
        return {
          valid: false,
          isLoggedIn: false,
          error: message,
        };
      }

      if (this.isLikelyWeChatPadProNotLoggedIn(message)) {
        return {
          valid: true,
          isLoggedIn: false,
        };
      }

      return {
        valid: true,
        isLoggedIn: false,
        error: message,
      };
    }
  }

  // ===== 登录流程 =====

  async getQRCode(deviceType?: string, proxy?: string): Promise<{
    qrCodeUrl: string;
    wId: string;
  }> {
    if (this.provider === "legacy") {
      const result = await this.requestLegacy("/v1/iPadLogin", {
        deviceType: deviceType || this.deviceType || "mac",
        proxy: proxy || this.proxy || "10",
      });
      return {
        wId: result.wId,
        qrCodeUrl: result.qrCodeUrl,
      };
    }

    const selectedDeviceType = deviceType || this.deviceType || "ipad";

    if (selectedDeviceType === "mac") {
      const result = await this.requestWeChatPadProRaw(
        ["/login/GetLoginQrCodeMac", "/api/Login/GetQRMac", "/api/login/GetQRMac", "/Login/GetQRMac"],
        {
          method: "GET",
          query: {
            key: this.apiKey,
            authcode: this.apiKey,
          },
          headers: this.buildWeChatPadProHeaders(),
        }
      );

      if (!this.isWeChatPadProSuccess(result)) {
        throw new Error(this.extractWeChatPadProMessage(result));
      }

      const data = this.getWeChatPadProData(result) ?? result;
      const qrCodeUrl = this.pickWeChatPadProLoginUrl(data);
      const uuid = data?.uuid || data?.UUID || data?.key || data?.sessionId || data?.wid || this.apiKey;
      if (!qrCodeUrl || !uuid) {
        throw new Error("WeChatPadPro Mac 登录二维码响应缺少必要字段。");
      }

      return {
        wId: String(uuid),
        qrCodeUrl: String(qrCodeUrl),
      };
    }

    const result = await this.requestWeChatPadProRaw(
      ["/api/login/qr/newx", "/login/GetLoginQrCodeNewX", "/api/login/GetLoginQrCodeNewX", "/login/GetLoginQrCodeNew", "/api/login/qr/new"],
      {
        method: "POST",
        query: {
          key: this.apiKey,
          authcode: this.apiKey,
        },
        headers: this.buildWeChatPadProHeaders({
          "Content-Type": "application/json",
        }),
        body: {
          Proxy: this.loginProxyUrl || proxy || undefined,
          proxy: this.loginProxyUrl || proxy || undefined,
          deviceName: this.deviceName,
          deviceId: this.deviceId,
        },
      }
    );

    if (!this.isWeChatPadProSuccess(result)) {
      throw new Error(this.extractWeChatPadProMessage(result));
    }

    const data = this.getWeChatPadProData(result) ?? result;
    const qrCodeUrl = this.pickWeChatPadProLoginUrl(data);
    const uuid = data?.uuid || data?.UUID || data?.key || data?.wid;
    if (!qrCodeUrl || !uuid) {
      throw new Error("WeChatPadPro 登录二维码响应缺少必要字段。");
    }

    return {
      wId: String(uuid),
      qrCodeUrl: String(qrCodeUrl),
    };
  }

  async checkLogin(wId: string): Promise<LoginStatus> {
    if (this.provider === "legacy") {
      const result = await this.requestLegacy("/v1/getIPadLoginInfo", { wId });

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

    const selectedDeviceType = this.deviceType || "ipad";
    const endpoints = selectedDeviceType === "mac"
      ? ["/login/CheckMacQR", "/api/Login/CheckMacQR", "/api/login/CheckMacQR", "/Login/CheckMacQR"]
      : ["/login/CheckLoginStatus", "/api/login/CheckLoginStatus", "/login/GetLoginStatus", "/api/login/status"];

    const result = await this.requestWeChatPadProRaw(endpoints, {
      method: "GET",
      query: selectedDeviceType === "mac"
        ? {
            uuid: wId,
            key: this.apiKey,
            authcode: this.apiKey,
          }
        : {
            key: wId,
          },
      headers: this.buildWeChatPadProHeaders(),
    });

    const code = this.getWeChatPadProCode(result);
    const data = this.getWeChatPadProData(result) ?? result;
    const normalized = this.normalizeWeChatPadProProfile(data?.userInfo || data);
    const rawStatus = String(
      data?.status ||
      data?.state ||
      data?.Status ||
      data?.State ||
      result.status ||
      result.state ||
      result.Status ||
      result.State ||
      ""
    ).toLowerCase();

    if (
      normalized.wcId &&
      !["scanned", "waiting", "pending", "confirm", "scaned"].includes(rawStatus)
    ) {
      return {
        status: "logged_in",
        wcId: normalized.wcId,
        nickName: normalized.nickName || normalized.wcId,
        headUrl: normalized.headUrl,
      };
    }

    if (code === -3) {
      return {
        status: "need_verify",
        verifyUrl: "请在 WeChatPadPro 控制台提交安全验证码。",
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
    if (this.provider === "legacy") {
      const result = await this.requestLegacy("/v1/sendText", {
        wcId,
        content
      });

      return {
        msgId: result.msgId,
        newMsgId: result.newMsgId,
        createTime: result.createTime,
      };
    }

    const now = Date.now();
    const result = await this.requestWeChatPadPro(
      ["/message/SendTextMessage", "/api/v1/message/SendTextMessage", "/api/v1/message/sendText"],
      {
        method: "POST",
        query: {
          key: this.apiKey,
          authcode: this.apiKey,
        },
        headers: this.buildWeChatPadProHeaders({
          "Content-Type": "application/json",
        }),
        body: {
          MsgItem: [
            {
              ToUserName: wcId,
              TextContent: content,
              MsgType: 0,
            },
          ],
        },
      }
    );

    const msgId = Number(
      result?.msgId ||
      result?.MsgId ||
      result?.newMsgId ||
      result?.NewMsgId ||
      now
    );

    return {
      msgId,
      newMsgId: msgId,
      createTime: now,
    };
  }

  async sendImage(wcId: string, imageUrl: string): Promise<{
    msgId: number;
    newMsgId: number;
    createTime: number;
  }> {
    if (this.provider === "legacy") {
      const result = await this.requestLegacy("/v1/sendImage2", {
        wcId,
        imageUrl
      });

      return {
        msgId: result.msgId,
        newMsgId: result.newMsgId,
        createTime: result.createTime,
      };
    }

    const now = Date.now();
    const result = await this.requestWeChatPadPro(
      ["/message/SendImageMessage", "/api/v1/message/SendImageMessage", "/api/v1/message/sendImage"],
      {
        method: "POST",
        query: {
          key: this.apiKey,
          authcode: this.apiKey,
        },
        headers: this.buildWeChatPadProHeaders({
          "Content-Type": "application/json",
        }),
        body: {
          MsgItem: [
            {
              ToUserName: wcId,
              ImageContent: imageUrl,
              MsgType: 2,
            },
          ],
        },
      }
    );

    const msgId = Number(
      result?.msgId ||
      result?.MsgId ||
      result?.newMsgId ||
      result?.NewMsgId ||
      now
    );

    return {
      msgId,
      newMsgId: msgId,
      createTime: now,
    };
  }

  // ===== 联系人 =====

  async getContacts(wcId: string): Promise<{
    friends: string[];
    chatrooms: string[];
  }> {
    if (this.provider === "legacy") {
      const result = await this.requestLegacy("/v1/getAddressList", {
        wcId
      });

      return {
        friends: result.friends || [],
        chatrooms: result.chatrooms || [],
      };
    }

    return {
      friends: [],
      chatrooms: [],
    };
  }

  // ===== Webhook =====

  async registerWebhook(_wcId: string, webhookUrl: string): Promise<void> {
    if (this.provider === "legacy") {
      await this.requestLegacy("/v1/webhook/register", {
        wcId: _wcId,
        webhookUrl
      });
      return;
    }

    const result = await this.requestWeChatPadProRaw(
      ["/webhook/Config", "/v1/webhook/Config"],
      {
        method: "POST",
        query: {
          key: this.apiKey,
          authcode: this.apiKey,
        },
        headers: this.buildWeChatPadProHeaders({
          "Content-Type": "application/json",
        }),
        body: {
          url: webhookUrl,
          secret: this.webhookSecret || "",
          enabled: true,
          timeout: this.webhookTimeoutSec,
          retryCount: this.webhookRetryCount,
          messageTypes: this.webhookMessageTypes,
          includeSelfMessage: this.webhookIncludeSelfMessage,
        },
      }
    );

    if (!this.isWeChatPadProSuccess(result)) {
      throw new Error(this.extractWeChatPadProMessage(result));
    }
  }
}
