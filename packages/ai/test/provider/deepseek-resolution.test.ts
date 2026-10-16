import { describe, expect, test } from "bun:test"
import { resolveTargetModelID, checkDeadMode, checkThinking, normalizeDeepSeekBody } from "../../src/providers/deepseek"

describe("DeepSeek model resolution & dead mode redirection", () => {
  test("chat is v4 (non-thinking)", () => {
    expect(resolveTargetModelID("deepseek-v4", { isDead: false, isThinking: false })).toBe("deepseek-chat")
    expect(resolveTargetModelID("v4", { isDead: false, isThinking: false })).toBe("deepseek-chat")
    expect(resolveTargetModelID("chat", { isDead: false, isThinking: false })).toBe("deepseek-chat")
    expect(resolveTargetModelID("deepseek-chat", { isDead: false, isThinking: false })).toBe("deepseek-chat")
  })

  test("r1, expert, and reasoner are equal (thinking)", () => {
    expect(resolveTargetModelID("deepseek-v4", { isDead: false, isThinking: true })).toBe("deepseek-reasoner")
    expect(resolveTargetModelID("deepseek-reasoner", { isDead: false, isThinking: true })).toBe("deepseek-reasoner")
    expect(resolveTargetModelID("deepseek-r1", { isDead: false, isThinking: true })).toBe("deepseek-reasoner")
    expect(resolveTargetModelID("deepseek-expert", { isDead: false, isThinking: true })).toBe("deepseek-reasoner")
    expect(resolveTargetModelID("reasoner", { isDead: false, isThinking: true })).toBe("deepseek-reasoner")
    expect(resolveTargetModelID("r1", { isDead: false, isThinking: true })).toBe("deepseek-reasoner")
    expect(resolveTargetModelID("expert", { isDead: false, isThinking: true })).toBe("deepseek-reasoner")
  })

  test("dead mode redirects with thinking or without thinking", () => {
    // dead mode without thinking -> deepseek-chat-dead
    expect(resolveTargetModelID("deepseek-v4", { isDead: true, isThinking: false })).toBe("deepseek-chat-dead")
    expect(resolveTargetModelID("deepseek-chat", { isDead: true, isThinking: false })).toBe("deepseek-chat-dead")

    // dead mode with thinking -> deepseek-expert-dead
    expect(resolveTargetModelID("deepseek-v4", { isDead: true, isThinking: true })).toBe("deepseek-expert-dead")
    expect(resolveTargetModelID("deepseek-reasoner", { isDead: true, isThinking: true })).toBe("deepseek-expert-dead")
    expect(resolveTargetModelID("deepseek-r1", { isDead: true, isThinking: true })).toBe("deepseek-expert-dead")
    expect(resolveTargetModelID("deepseek-expert", { isDead: true, isThinking: true })).toBe("deepseek-expert-dead")
  })

  test("checkThinking identifies thinking variants and reasoning models", () => {
    expect(checkThinking("deepseek-v4", undefined, undefined)).toBe(false)
    expect(checkThinking("deepseek-v4", { thinking: { type: "disabled" } }, undefined)).toBe(false)
    expect(checkThinking("deepseek-v4", { thinking: { type: "enabled" } }, undefined)).toBe(true)
    expect(checkThinking("deepseek-v4", undefined, { reasoningEffort: "high" })).toBe(true)
    expect(checkThinking("deepseek-reasoner", undefined, undefined)).toBe(true)
    expect(checkThinking("deepseek-r1", undefined, undefined)).toBe(true)
    expect(checkThinking("deepseek-expert", undefined, undefined)).toBe(true)
  })

  test("checkDeadMode checks deadMode flag, env vars, and -dead suffix", () => {
    expect(checkDeadMode("deepseek-v4", false)).toBe(false)
    expect(checkDeadMode("deepseek-v4", true)).toBe(true)
    expect(checkDeadMode("deepseek-chat-dead", false)).toBe(true)
    expect(checkDeadMode("deepseek-v4", false, { "x-dead-mode": "true" })).toBe(true)
  })

  test("normalizeDeepSeekBody converts object thinking to valid boolean", () => {
    expect(normalizeDeepSeekBody(undefined, false)).toBeUndefined()
    expect(normalizeDeepSeekBody({ mode: "dead" }, false)).toEqual({ mode: "dead" })
    expect(normalizeDeepSeekBody({ thinking: { type: "disabled" } }, false)).toEqual({ thinking: false })
    expect(normalizeDeepSeekBody({ thinking: { type: "enabled" } }, true)).toEqual({ thinking: true })
    expect(normalizeDeepSeekBody({ thinking: false }, false)).toEqual({ thinking: false })
    expect(normalizeDeepSeekBody({ thinking: true }, true)).toEqual({ thinking: true })
  })
})
