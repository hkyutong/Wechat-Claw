# YutoAI 微信节点

`wechat-claw` 是一个面向 `OpenClaw` 的微信通道插件，通过代理层的 Proxy API 接入微信账号，提供消息接收、规则处理、回复分发和 Webhook 回调能力。

项目目标很明确：把微信账号稳定接入 `OpenClaw`，并且把“群聊门控、规则路由、回复策略、基础风控”这些高频能力做成可配置的通道层，而不是散落在业务代码里的临时判断。

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

## 适用范围

这个仓库定位为独立开源的微信通道插件，只负责微信侧接入与 `OpenClaw` 通道集成。

以下能力不在当前仓库范围内：

- Penum 侧业务同步
- 工单系统对接
- 私有业务数据库或内部审计平台接入

如果你需要这些能力，建议在上层业务仓库中基于本插件继续扩展。

## 兼容标识

为了兼容现有运行时，项目保留以下技术标识：

- 通道 id: `wechat`
- 包名: `wechat-claw`
- 运行时入口: `openclaw`

这些属于技术兼容层，不影响对外品牌命名。

## 环境要求

- Node.js `>= 22`
- `OpenClaw >= 2026.2.9`
- 可用的微信 Proxy API 服务
- 能被代理服务访问到的 Webhook 地址

## 先搞清楚这 3 个组件

- `OpenClaw`: 宿主网关，负责加载插件、维护会话、调用模型
- `wechat-claw`: 本仓库，负责把微信消息接进 `OpenClaw`
- `Proxy API`: 负责微信登录、收消息、发消息；README 里的 `apiKey` 是它的凭证，不是模型厂商的 Key

如果你还没跑过 `OpenClaw`，最省事的做法是先把 `OpenClaw` 跑起来，再安装本插件。

## 5 分钟上手

这条路径最适合第一次接触 `OpenClaw` 的用户。

### 1. 安装 OpenClaw

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

如果执行完后提示找不到 `openclaw` 命令，重新打开终端再试一次。

### 2. 安装微信插件

```bash
openclaw plugins install wechat-claw
```

### 3. 写入最小配置

把下面 5 行直接替换成你自己的真实值后执行：

```bash
openclaw config set channels.wechat.enabled true
openclaw config set channels.wechat.apiKey "your-proxy-api-key"
openclaw config set channels.wechat.proxyUrl "http://your-proxy-service:13800"
openclaw config set channels.wechat.webhookHost "https://your-domain.example.com"
openclaw config set channels.wechat.webhookPort 18792
```

字段说明：

- `apiKey`: 微信代理服务的 Key，不是 OpenAI、Anthropic 或其他模型 Key
- `proxyUrl`: 你的微信代理服务地址
- `webhookHost`: 代理服务能够回调到的公网 IP、域名，或完整 `https://` 地址

### WeChatPadPro 推荐配置

如果你用的是 `WeChatPadPro`，建议明确写 provider，不要继续沿用旧的通用示例：

```bash
openclaw config set channels.wechat.enabled true
openclaw config set channels.wechat.provider "wechatpadpro"
openclaw config set channels.wechat.apiKey "your-auth-key"
openclaw config set channels.wechat.proxyUrl "http://127.0.0.1:1238"
openclaw config set channels.wechat.deviceType "ipad"
openclaw config set channels.wechat.webhookHost "https://your-domain.example.com"
openclaw config set channels.wechat.webhookPort 18792
```

注意：

- `apiKey` 这里要填 `WeChatPadPro` 业务 `AuthKey`，不是 `ADMIN_KEY`
- 默认 API 端口通常是 `1238`，不是旧文档里常见的 `13800`
- `WeChatPadPro` 新版接口会返回 `QrLink` 和 `QrCodeUrl`，插件会优先使用可直接扫码的 `QrLink`
- 首次登录或长期离线后重新登录，风控概率会升高，这不是插件能彻底消除的

为了尽量稳定，建议同时满足这几点：

- 固定一条长期稳定、同城的代理线路，不要频繁切换出口 IP
- 不要在短时间内重复获取二维码、重复登录、重复登出
- 同一个微信号只接入一套协议链路，避免和其他 Pad/PC 组件混用
- 保持服务长期在线，避免账号频繁离线后再重新拉起

### 4. 启动网关

```bash
openclaw gateway start --verbose
```

首次启动时，你会看到二维码或扫码链接。扫码成功后，再用微信给机器人发一条 `/status`；只要能正常回复，说明接入已经打通。

现在默认会在日志里直接打印可扫码的终端二维码，同时保留二维码地址作为兜底，不需要再额外把链接粘到浏览器里。

## Docker 部署

如果你希望把 `OpenClaw` 也跑在 Docker 里，推荐先按官方 Docker 指南准备运行环境：

- 官方 Docker 文档：[OpenClaw Docker](https://docs.openclaw.ai/install/docker)
- 官方快速开始：[Getting started](https://docs.openclaw.ai/start/getting-started)

准备好 `OpenClaw` 的 Docker 环境后，再执行下面这些命令安装和配置本插件：

```bash
docker compose run --rm openclaw-cli plugins install wechat-claw
docker compose run --rm openclaw-cli config set channels.wechat.enabled true
docker compose run --rm openclaw-cli config set channels.wechat.apiKey "your-proxy-api-key"
docker compose run --rm openclaw-cli config set channels.wechat.proxyUrl "http://your-proxy-service:13800"
docker compose run --rm openclaw-cli config set channels.wechat.webhookHost "https://your-domain.example.com"
docker compose run --rm openclaw-cli config set channels.wechat.webhookPort 18792
docker compose restart openclaw-gateway
```

Docker 场景最容易踩的坑：

- 如果你的 Proxy API 跑在宿主机上，不要在容器里写 `127.0.0.1`，而要写宿主机可访问地址
- `webhookHost` 必须让 Proxy API 反向访问得到，仅本地回环地址无效
- 如果你走 Nginx 或云负载均衡，`webhookHost` 直接填完整的 `https://你的域名`
- 插件安装完成后要重启 `openclaw-gateway`，否则新插件不会被加载

首次登录时，直接看网关日志就可以扫码：

```bash
docker compose logs -f openclaw-gateway
```

## 安装

```bash
openclaw plugins install wechat-claw
```

## 升级

```bash
openclaw plugins update wechat
```

## 最小配置

```bash
openclaw config set channels.wechat.apiKey "your-api-key"
openclaw config set channels.wechat.proxyUrl "http://your-proxy-service:13800"
openclaw config set channels.wechat.webhookHost "https://your-domain.example.com"
openclaw config set channels.wechat.webhookPort 18792
openclaw config set channels.wechat.enabled true
```

## 单账号配置示例

```yaml
channels:
  wechat:
    enabled: true
    apiKey: "your-api-key"
    proxyUrl: "http://127.0.0.1:13800"
    webhookHost: "https://claw.example.com"
    webhookPort: 18792
    webhookPath: "/webhook/wechat"
    deviceType: "mac"
    proxy: "2"
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
          autoReplyText: "已为 {{sender}} 转人工，请稍候。"
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
        apiKey: "sales-key"
        proxyUrl: "http://127.0.0.1:13800"
        webhookHost: "https://claw.example.com"
        webhookPort: 18792
      support:
        enabled: true
        apiKey: "support-key"
        proxyUrl: "http://127.0.0.1:13800"
        webhookHost: "https://claw.example.com"
        webhookPort: 18793
```

## 首次登录

```bash
openclaw gateway start
```

首次启动会输出二维码或扫码链接。完成扫码后，节点会自动轮询登录状态并向代理服务注册回调地址。

## 最小验收清单

- 启动 `openclaw gateway start --verbose` 后，没有出现插件加载报错
- 日志中能看到二维码或扫码链接
- 扫码登录后，日志中能看到登录状态变化和 Webhook 注册信息
- 用微信发 `/status`，机器人能正常回复
- 在群里开启 `requireMentionInGroup: true` 后，不 `@` 机器人时它不会乱回

## 配置说明

### `inbound`

- `allowDirect`: 是否允许私聊进入
- `allowGroup`: 是否允许群聊进入
- `requireMentionInGroup`: 群聊是否要求 `@`
- `requireCommandPrefixInGroup`: 群聊是否要求命令前缀
- `commandPrefixes`: 命令前缀列表
- `allowedMessageTypes`: 放行的消息类型
- `allowSenders` / `blockSenders`: 用户白名单 / 黑名单
- `allowGroups` / `blockGroups`: 群白名单 / 黑名单

### `routing`

- `defaultAgentId`: 默认 agent 覆写
- `defaultSessionMode`: 默认 session 颗粒度
- `rules[]`: 规则列表，支持按聊天类型、群、用户、消息类型、关键词、命令、正则匹配
- `routeKey`: 自定义路由键，适合把不同群或关键词导向不同业务智能体
- `replyMode`: `group`、`direct`、`silent`

### `reply`

- `defaultGroupReplyMode`: 群默认回复模式
- `mentionSenderInGroup`: 群回复时是否自动 `@` 发送人
- `mentionTemplate`: 群回复前缀模板，支持 `{name}` 和 `{id}`

### `riskControl`

- `dedupWindowMs`: 去重窗口
- `dedupMaxSize`: 去重缓存上限
- `senderRateLimitPerMinute`: 单用户每分钟限流
- `groupRateLimitPerMinute`: 单群每分钟限流
- `sensitiveWords`: 敏感词列表
- `sensitiveReplyText`: 命中敏感词后的提示文案
- `rateLimitReplyText`: 命中限流后的提示文案

### `operations`

- `enableBuiltinCommands`: 是否启用 `/ping`、`/status`、`/help`

## 常见用法

- 群里只有被 `@` 才回复：`inbound.requireMentionInGroup: true`
- 某些群走不同智能体：在 `routing.rules[]` 中设置 `groupIds + agentId + routeKey`
- 群里触发后改私聊继续：把规则的 `replyMode` 设为 `direct`
- 命中关键词后直接回复，不进入智能体：设置 `autoReplyText` 并把 `skipAgent` 设为 `true`
- 风险话术直接拦截：配置 `riskControl.sensitiveWords` 和 `sensitiveReplyText`

## 开发与验证

安装依赖：

```bash
npm ci
```

类型检查：

```bash
npm run typecheck
```

运行全部验证：

```bash
npm run verify
```

如果本机没有 Node 环境，也可以使用 Docker：

```bash
docker run --rm -v "$(pwd):/app" -w /app node:22-bullseye \
  bash -lc 'npm ci --ignore-scripts && npm run verify'
```

## 测试说明

- `test-channel.ts`: 通道配置、目录查询、状态接口和目标解析
- `test-plugin.ts`: Webhook 接收与鉴权验证
- `test-business.ts`: 业务规则链路，包括群 `@` 门控、路由覆写、私聊回落、敏感词拦截和媒体消息入链路

这些测试不依赖真实微信账号，适合作为本地开发和 CI smoke test。

## 已知限制

- 当前稳定的出站能力是文本和图片；其他媒体类型会回退成文本链接，避免因为代理侧实现差异导致发送失败
- 登录态目前依赖代理服务返回和运行时配置，不包含独立持久化存储
- 规则中的 `auditTag` 当前只写入上下文，不负责外部审计系统落库

## 常见问题

- `apiKey` 是什么：它是微信 Proxy API 的凭证，不是模型服务的 API Key
- 为什么扫完码没反应：优先检查 `proxyUrl` 是否可用、`webhookHost` 是否能被代理服务回调
- 为什么 Docker 里连不上代理：容器内的 `127.0.0.1` 指向容器自己，不是宿主机
- 为什么插件装好了但没生效：重启 `openclaw-gateway`，然后看日志里是否出现 `YutoAI 微信节点已注册`

## 贡献

欢迎提交 Issue 和 Pull Request。提交前建议先运行：

```bash
npm run verify
```

更多说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

MIT
