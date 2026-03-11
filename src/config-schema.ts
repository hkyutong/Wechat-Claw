/**
 * YutoAI 微信节点配置类型。
 * 同时支持顶级单账号配置和 accounts 多账号配置。
 */

export type WechatMessageType = "text" | "image" | "video" | "file" | "voice";
export type WechatChatType = "direct" | "group" | "all";
export type WechatSessionMode = "default" | "sender" | "group" | "group-member";
export type WechatReplyMode = "default" | "group" | "direct" | "silent";
export type WechatRuleMatchType = "command" | "keyword" | "regex";

export interface WechatInboundPolicy {
  allowDirect?: boolean;
  allowGroup?: boolean;
  requireMentionInGroup?: boolean;
  requireCommandPrefixInGroup?: boolean;
  commandPrefixes?: string[];
  allowedMessageTypes?: WechatMessageType[];
  allowSenders?: string[];
  blockSenders?: string[];
  allowGroups?: string[];
  blockGroups?: string[];
  stripMentions?: boolean;
  normalizeWhitespace?: boolean;
}

export interface WechatRoutingRule {
  name: string;
  enabled?: boolean;
  chatType?: WechatChatType;
  messageTypes?: WechatMessageType[];
  senderIds?: string[];
  groupIds?: string[];
  mentionRequired?: boolean;
  matchType?: WechatRuleMatchType;
  pattern?: string;
  routeKey?: string;
  agentId?: string;
  sessionMode?: WechatSessionMode;
  replyMode?: WechatReplyMode;
  autoReplyText?: string;
  skipAgent?: boolean;
  auditTag?: string;
}

export interface WechatRoutingPolicy {
  defaultAgentId?: string;
  defaultSessionMode?: WechatSessionMode;
  rules?: WechatRoutingRule[];
}

export interface WechatReplyPolicy {
  defaultGroupReplyMode?: Exclude<WechatReplyMode, "default">;
  mentionSenderInGroup?: boolean;
  mentionTemplate?: string;
}

export interface WechatRiskControl {
  dedupWindowMs?: number;
  dedupMaxSize?: number;
  senderRateLimitPerMinute?: number;
  groupRateLimitPerMinute?: number;
  sensitiveWords?: string[];
  sensitiveReplyText?: string;
  rateLimitReplyText?: string;
  blockOnSensitive?: boolean;
}

export interface WechatOperationsPolicy {
  enableBuiltinCommands?: boolean;
}

export interface WechatSharedConfig {
  inbound?: WechatInboundPolicy;
  routing?: WechatRoutingPolicy;
  reply?: WechatReplyPolicy;
  riskControl?: WechatRiskControl;
  operations?: WechatOperationsPolicy;
}

export interface WechatAccountConfig extends WechatSharedConfig {
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

export interface WechatConfig extends WechatSharedConfig {
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

const MESSAGE_TYPE_ENUM = ["text", "image", "video", "file", "voice"] as const;
const CHAT_TYPE_ENUM = ["direct", "group", "all"] as const;
const SESSION_MODE_ENUM = ["default", "sender", "group", "group-member"] as const;
const REPLY_MODE_ENUM = ["default", "group", "direct", "silent"] as const;
const DEFAULTABLE_REPLY_MODE_ENUM = ["group", "direct", "silent"] as const;
const RULE_MATCH_TYPE_ENUM = ["command", "keyword", "regex"] as const;

const inboundPolicySchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    allowDirect: { type: "boolean" },
    allowGroup: { type: "boolean" },
    requireMentionInGroup: { type: "boolean" },
    requireCommandPrefixInGroup: { type: "boolean" },
    commandPrefixes: {
      type: "array" as const,
      items: { type: "string" },
    },
    allowedMessageTypes: {
      type: "array" as const,
      items: { type: "string", enum: [...MESSAGE_TYPE_ENUM] },
    },
    allowSenders: {
      type: "array" as const,
      items: { type: "string" },
    },
    blockSenders: {
      type: "array" as const,
      items: { type: "string" },
    },
    allowGroups: {
      type: "array" as const,
      items: { type: "string" },
    },
    blockGroups: {
      type: "array" as const,
      items: { type: "string" },
    },
    stripMentions: { type: "boolean" },
    normalizeWhitespace: { type: "boolean" },
  },
};

const routingRuleSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    enabled: { type: "boolean" },
    chatType: { type: "string", enum: [...CHAT_TYPE_ENUM] },
    messageTypes: {
      type: "array" as const,
      items: { type: "string", enum: [...MESSAGE_TYPE_ENUM] },
    },
    senderIds: {
      type: "array" as const,
      items: { type: "string" },
    },
    groupIds: {
      type: "array" as const,
      items: { type: "string" },
    },
    mentionRequired: { type: "boolean" },
    matchType: { type: "string", enum: [...RULE_MATCH_TYPE_ENUM] },
    pattern: { type: "string" },
    routeKey: { type: "string" },
    agentId: { type: "string" },
    sessionMode: { type: "string", enum: [...SESSION_MODE_ENUM] },
    replyMode: { type: "string", enum: [...REPLY_MODE_ENUM] },
    autoReplyText: { type: "string" },
    skipAgent: { type: "boolean" },
    auditTag: { type: "string" },
  },
  required: ["name"],
};

const routingPolicySchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    defaultAgentId: { type: "string" },
    defaultSessionMode: { type: "string", enum: [...SESSION_MODE_ENUM] },
    rules: {
      type: "array" as const,
      items: routingRuleSchema,
    },
  },
};

const replyPolicySchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    defaultGroupReplyMode: { type: "string", enum: [...DEFAULTABLE_REPLY_MODE_ENUM] },
    mentionSenderInGroup: { type: "boolean" },
    mentionTemplate: { type: "string" },
  },
};

const riskControlSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    dedupWindowMs: { type: "integer" },
    dedupMaxSize: { type: "integer" },
    senderRateLimitPerMinute: { type: "integer" },
    groupRateLimitPerMinute: { type: "integer" },
    sensitiveWords: {
      type: "array" as const,
      items: { type: "string" },
    },
    sensitiveReplyText: { type: "string" },
    rateLimitReplyText: { type: "string" },
    blockOnSensitive: { type: "boolean" },
  },
};

const operationsPolicySchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    enableBuiltinCommands: { type: "boolean" },
  },
};

const sharedConfigProperties = {
  inbound: inboundPolicySchema,
  routing: routingPolicySchema,
  reply: replyPolicySchema,
  riskControl: riskControlSchema,
  operations: operationsPolicySchema,
} as const;

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
    ...sharedConfigProperties,

    // 多账号配置
    accounts: {
      type: "object" as const,
      additionalProperties: {
        type: "object" as const,
        additionalProperties: false,
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
          ...sharedConfigProperties,
        },
        required: ["apiKey"],
      },
    },
  },
};
