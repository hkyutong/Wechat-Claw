import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wechatPlugin } from "./src/channel.js";
import { setWeChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "wechat",
  name: "YutoAI WeChat",
  description: "YutoAI 微信节点",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    setWeChatRuntime(api.runtime);
    api.registerChannel({ plugin: wechatPlugin });
    console.log("YutoAI 微信节点已注册");
  },
};

export default plugin;
export { wechatPlugin } from "./src/channel.js";
export type { WechatConfig, WechatAccountConfig, ResolvedWeChatAccount } from "./src/types.js";
