# 贡献指南

感谢你愿意改进 `OpenClaw WeChat`。

## 开始之前

- Node.js 请使用 `22` 或更高版本
- 安装依赖使用 `npm ci`
- 提交前请确保 `npm run verify` 通过

## 开发流程

1. Fork 仓库并创建功能分支
2. 完成代码修改和必要测试
3. 运行 `npm run verify`
4. 提交 Pull Request，并说明变更动机、行为变化和验证结果

## 代码约定

- 优先保持配置驱动，避免把业务判断硬编码到通道主链路
- 新增规则能力时，优先补充 `test-business.ts`
- 新增通道能力时，优先补充 `test-channel.ts` 或 `test-plugin.ts`
- 文档默认使用中文，面向公开用户，不要写内部部署或私人上下文

## Pull Request 建议内容

- 变更目标
- 影响范围
- 配置变更
- 测试结果
- 兼容性说明

## Issue 建议内容

- 使用的 `OpenClaw` 版本
- 使用的 Node.js 版本
- 代理服务的关键行为或报错
- 最小可复现配置
- 实际结果与预期结果
