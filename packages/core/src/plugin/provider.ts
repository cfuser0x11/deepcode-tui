import { DeepSeekPlugin } from "./provider/deepseek.js"
import { OpenAIPlugin } from "./provider/openai.js"
import { PromptCacheKeyPlugin } from "./provider/prompt-cache-key.js"
import { DynamicProviderPlugin } from "./provider/dynamic.js"
import type { PluginInternal } from "./internal.js"

export const ProviderPlugins: PluginInternal.InternalPlugin[] = [
  DeepSeekPlugin,
  OpenAIPlugin,
  PromptCacheKeyPlugin,
  DynamicProviderPlugin,
]

