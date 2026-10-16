export * as OptimizePlugin from "./optimize.js"

import type { Plugin } from "@opencode/plugin/effect/plugin"

/**
 * Model-specific prompt and tool optimization plugins.
 * In DeepCode, the default system prompt in `session/runner/prompt/system.txt`
 * is used directly for DeepSeek without legacy multi-provider prompt overrides.
 */
export const Plugins: readonly Plugin[] = []
