# OpenClaw WeChat

`Wechat-Claw` 是一个面向 `OpenClaw` 的开源微信通道插件。

它只做一件事：把微信账号稳定接入 `OpenClaw`。仓库内保留的能力都围绕通道适配展开，包括消息接入、规则门控、回复分发、Webhook 回调和基础风控；不包含私有业务系统、工单流转或内部数据库逻辑。

## 项目定位

- 适配 `OpenClaw`
- 对接微信代理服务
- 输出公开可复现的安装和验证流程
- 保持插件独立，不绑定私有业务仓库

当前推荐的代理后端是 `WeChatPadPro`，同时仍兼容旧版通用 Proxy API。

## 特性

- 支持微信私聊、群聊消息接入
- 支持文本、图片、视频、文件、语音消息入站解析
- 支持群聊 `@` 提及门控、命令前缀、群/用户白名单与黑名单
- 支持规则驱动的路由覆写：关键词、命令、正则、群、用户、多账号
- 支持 `default`、`sender`、`group`、`group-member` 四种会话粒度
- 支持群回群、群转私聊、静默入链路三种回复模式
- 支持去重、限流、敏感词拦截等基础风控
- 支持二维码登录、登录状态探测、Webhook 自动注册
- 支持 `OpenClaw` reply dispatcher，沿用分段、延迟和 typing 能力
- 内建运维命令：`/ping`、`/status`、`/help`

## 边界

以下内容不在本仓库范围内：

- 私有业务系统同步
- 工单系统创建与流转
- 内部标签平台、审计平台、数据库写入
- 自定义模型服务封装

如果你需要这些能力，建议在上层业务仓库基于本插件扩展，而不是把私有逻辑直接塞回通道层。

## 兼容标识

为了与 `OpenClaw` 当前插件发现和自动启用逻辑保持一致，项目保留以下技术标识：

- 仓库名：`Wechat-Claw`
- npm 包名：`@hkyutong/wechat`
- 插件 id：`wechat`
- 通道 id：`wechat`

这几个标识分别服务于源码仓库、包元数据和运行时加载，不建议随意改动。

## 环境要求

- Node.js `>= 22`
- `OpenClaw >= 2026.2.9`
- 可用的微信代理服务
- 能被代理服务访问到的 Webhook 地址

## 组件关系

- `OpenClaw`：宿主网关，负责加载插件、维护会话和调用模型
- `OpenClaw WeChat`：本仓库，负责微信通道接入
- `Proxy API`：负责微信登录、收消息、发消息

README 里的 `apiKey` 指的是微信代理服务的鉴权凭证，不是模型厂商的 API Key。

## 快速开始

### 1. 安装 OpenClaw

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

### 2. 安装插件

当前仓库还没有发布到 npm 公共包名，安装请直接使用 GitHub 源码地址：

```bash
openclaw plugins install "git+https://github.com/hkyutong/Wechat-Claw.git"
```

### 3. 写入最小配置

```bash
openclaw config set channels.wechat.enabled true
openclaw config set channels.wechat.provider "wechatpadpro"
openclaw config set channels.wechat.apiKey "your-proxy-api-key"
openclaw config set channels.wechat.proxyUrl "http://your-proxy-service:1238"
openclaw config set channels.wechat.deviceType "ipad"
openclaw config set channels.wechat.webhookHost "https://your-domain.example.com"
openclaw config set channels.wechat.webhookPort 18792
```

字段说明：

- `apiKey`：微信代理服务的鉴权 Key
- `proxyUrl`：微信代理服务地址
- `deviceType`：当前推荐 `ipad`
- `webhookHost`：代理服务可以回调到的公网地址
- `webhookPort`：本地回调服务监听端口

### 4. 启动网关

```bash
openclaw gateway start --verbose
```

首次启动时，日志里会直接打印终端二维码和扫码链接。扫码成功后，可以在微信里发送 `/status` 做最小验收。

## Docker 部署

如果你把 `OpenClaw` 跑在 Docker 里，流程也是一样的，只是把命令放进 `openclaw-cli` 容器执行：

```bash
docker compose run --rm openclaw-cli plugins install "git+https://github.com/hkyutong/Wechat-Claw.git"
docker compose run --rm openclaw-cli config set channels.wechat.enabled true
docker compose run --rm openclaw-cli config set channels.wechat.provider "wechatpadpro"
docker compose run --rm openclaw-cli config set channels.wechat.apiKey "your-proxy-api-key"
docker compose run --rm openclaw-cli config set channels.wechat.proxyUrl "http://your-proxy-service:1238"
docker compose run --rm openclaw-cli config set channels.wechat.deviceType "ipad"
docker compose run --rm openclaw-cli config set channels.wechat.webhookHost "https://your-domain.example.com"
docker compose run --rm openclaw-cli config set channels.wechat.webhookPort 18792
docker compose restart openclaw-gateway
```

扫码时直接看网关日志：

```bash
docker compose logs -f openclaw-gateway
```

## WeChatPadPro 推荐配置

如果你使用 `WeChatPadPro`：

- `proxyUrl` 通常是 `http://host-or-service-name:1238`
- `apiKey` 填业务 `AuthKey`，不是 `ADMIN_KEY`
- 插件会优先使用 `QrLink`，并把二维码打印到终端
- `webhookHost` 应该指向代理服务可以反向访问到的地址

为了尽量稳定，建议遵守这些操作纪律：

- 固定长期稳定的代理线路，不要频繁切换出口 IP
- 不要在短时间内重复扫码、重复登录、重复登出
- 同一个微信号只接入一套协议链路，避免和其他 Pad/PC 组件混用
- 保持服务长期在线，避免账号反复离线后重新拉起

这些措施可以降低风控概率，但不能把非官方协议的风险降到零。

## 升级

```bash
openclaw plugins update wechat
```

如果你是通过本地目录挂载安装的，直接更新源码后重启 `openclaw-gateway` 即可。

## 最小配置示例

```yaml
channels:
  wechat:
    enabled: true
    provider: "wechatpadpro"
    apiKey: "your-proxy-api-key"
    proxyUrl: "http://127.0.0.1:1238"
    webhookHost: "https://claw.example.com"
    webhookPort: 18792
    webhookPath: "/webhook/wechat"
    deviceType: "ipad"
```

## 单账号配置示例

```yaml
channels:
  wechat:
    enabled: true
    provider: "wechatpadpro"
    apiKey: "your-proxy-api-key"
    proxyUrl: "http://127.0.0.1:1238"
    webhookHost: "https://claw.example.com"
    webhookPort: 18792
    webhookPath: "/webhook/wechat"
    deviceType: "ipad"
    inbound:
      allowDirect: true
      allowGroup: true
      requireMentionInGroup: true
      commandPrefixes: ["/", "#"]
      allowedMessageTypes: ["text", "image", "file", "voice", "video"]
      allowGroups: ["vip_room@chatroom"]
      blockSenders: ["wxid_spam"]
    routing:
      defaultSessionMode: "group-member"
      rules:
        - name: "sales-handoff"
          chatType: "group"
          matchType: "keyword"
          pattern: "发包"
          routeKey: "sales-room"
          agentId: "agent-sales"
          sessionMode: "group-member"
          replyMode: "direct"
        - name: "manual-service"
          chatType: "direct"
          matchType: "command"
          pattern: "human"
          autoReplyText: "已转人工，请稍候。"
          skipAgent: true
          auditTag: "manual-service"
    reply:
      defaultGroupReplyMode: "group"
      mentionSenderInGroup: true
      mentionTemplate: "@{name} "
    riskControl:
      dedupWindowMs: 1800000
      dedupMaxSize: 1000
      senderRateLimitPerMinute: 6
      groupRateLimitPerMinute: 30
      sensitiveWords: ["退款", "投诉", "人工"]
      sensitiveReplyText: "该类诉求已进入人工处理通道。"
      rateLimitReplyText: "消息较多，请稍后再试。"
    operations:
      enableBuiltinCommands: true
```

## 多账号配置示例

```yaml
channels:
  wechat:
    accounts:
      sales:
        enabled: true
        provider: "wechatpadpro"
        apiKey: "sales-key"
        proxyUrl: "http://127.0.0.1:1238"
        webhookHost: "https://claw.example.com"
        webhookPort: 18792
      support:
        enabled: true
        provider: "wechatpadpro"
        apiKey: "support-key"
        proxyUrl: "http://127.0.0.1:1238"
        webhookHost: "https://claw.example.com"
        webhookPort: 18793
```

## 验证

仓库内置了最小验证命令：

```bash
npm run verify
```

这会执行：

- `npm run typecheck`
- `test-channel.ts`
- `test-plugin.ts`
- `test-business.ts`
- `test-wechatpadpro.ts`

如果你没有在本机准备 Node 环境，也可以用 Docker 临时执行：

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-bullseye \
  bash -lc "npm ci --ignore-scripts && npm run verify"
```

## 常见问题

### 插件装好了但没有加载

- 先确认 `openclaw-gateway` 已经重启
- 再看日志里是否出现 `OpenClaw 微信通道已注册`
- 检查 `channels.wechat.enabled` 是否为 `true`

### 启动了但没有二维码

- 检查 `channels.wechat.apiKey` 和 `channels.wechat.proxyUrl`
- 检查代理服务是否可达
- 检查网关日志里是否已有登录成功状态，已登录时不会重复吐二维码

### Webhook 注册失败

- 检查 `webhookHost` 是否能被代理服务访问
- 检查 `webhookPort` 是否被放行
- 如果前面挂了 Nginx 或负载均衡，直接填完整 `https://` 地址

### 为什么扫码后还是容易掉线

这通常是代理线路、设备环境和登录行为共同造成的，不是通道插件单独能完全解决的问题。优先排查出口 IP 稳定性、登录频率和是否与其他协议栈混用。

## 开发

```bash
npm ci
npm run verify
```

提交前建议至少补齐对应的验证脚本：

- 规则和策略改动，优先补 `test-business.ts`
- 插件入口和运行时兼容改动，优先补 `test-plugin.ts`
- 通道基础能力改动，优先补 `test-channel.ts`

## 许可证

MIT
