/**
 * YutoAI 微信节点配置类型。
 * 同时支持顶级单账号配置和 accounts 多账号配置。
 */

export interface WechatAccountConfig {
  enabled?: boolean;
  name?: string;
  apiKey: string;
  proxyUrl?: string;       // 代理服务地址
  deviceType?: "ipad" | "mac";
  proxy?: string;          // 网络线路
  webhookHost?: string;    // Webhook 公网地址（IP 或域名）
  webhookPort?: number;
  webhookPath?: string;    // Webhook 路径，默认 /webhook/wechat
  natappEnabled?: boolean;
  natapiWebPort?: number;
  wcId?: string;           // 登录后自动填充
  nickName?: string;       // 登录后自动填充
  configured?: boolean;    // 运行时标记
}

export interface WechatConfig {
  enabled?: boolean;

  // 简化配置（单账号，顶级字段）
  apiKey?: string;
  proxyUrl?: string;
  deviceType?: "ipad" | "mac";
  proxy?: string;
  webhookHost?: string;    // Webhook 公网地址（IP 或域名）
  webhookPort?: number;
  webhookPath?: string;    // Webhook 路径

  // 多账号配置（可选）
  accounts?: Record<string, WechatAccountConfig | undefined>;
}

// 运行时配置校验对象。
export const WechatConfigSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },

    // 简化配置（顶级字段）
    apiKey: { type: "string" },
    proxyUrl: { type: "string" },
    deviceType: { type: "string", enum: ["ipad", "mac"] },
    proxy: { type: "string" },
    webhookHost: { type: "string" },
    webhookPort: { type: "integer" },
    webhookPath: { type: "string" },

    // 多账号配置
    accounts: {
      type: "object" as const,
      additionalProperties: {
        type: "object" as const,
        additionalProperties: true,
        properties: {
          enabled: { type: "boolean" },
          name: { type: "string" },
          apiKey: { type: "string" },
          proxyUrl: { type: "string" },
          deviceType: { type: "string", enum: ["ipad", "mac"] },
          proxy: { type: "string" },
          webhookHost: { type: "string" },
          webhookPort: { type: "integer" },
          webhookPath: { type: "string" },
          natappEnabled: { type: "boolean" },
          natapiWebPort: { type: "integer" },
          wcId: { type: "string" },
          nickName: { type: "string" },
        },
        required: ["apiKey"],
      },
    },
  },
};
