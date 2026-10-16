import { describe, expect, it } from "bun:test"
import { LLM, Message, ToolDefinition } from "@opencode/ai"
import { JsonSchema } from "@opencode/ai/schema/options"
import { countTokens, countMessageTokens, countToolTokens, estimateRequestTokens, estimateStepTokens } from "../src/session/tokenizer.js"

describe("SessionTokenizer", () => {
  it("counts English text with BPE weights", () => {
    const text = "Hello world! This is a test of the DeepSeek tokenizer."
    const tokens = countTokens(text)
    expect(tokens).toBeGreaterThan(5)
    expect(tokens).toBeLessThan(30)
  })

  it("calibrates for Russian Cyrillic text", () => {
    const english = "Hello world"
    const russian = "Привет мир"
    const engTokens = countTokens(english)
    const rusTokens = countTokens(russian)
    // Russian multi-byte utf8 chars should be counted with ~1.7 chars per token
    expect(rusTokens).toBeGreaterThan(0)
    expect(countTokens("Тестирование подсчета токенов для русского языка")).toBeGreaterThan(10)
  })

  it("handles empty and whitespace text", () => {
    expect(countTokens("")).toBe(0)
    expect(countTokens("   \n\n  \t ")).toBeGreaterThanOrEqual(1)
  })

  it("estimates messages including ChatML overhead", () => {
    const msg = Message.user("Hello there")
    const tokens = countMessageTokens(msg)
    // 4 overhead + ~3 text tokens
    expect(tokens).toBeGreaterThanOrEqual(5)
  })

  it("estimates tools including schema parameters", () => {
    const tool = new ToolDefinition({
      name: "bash",
      description: "Execute a command in the bash shell",
      inputSchema: JsonSchema.make({
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
      }),
    })
    const tokens = countToolTokens(tool)
    expect(tokens).toBeGreaterThan(10)
  })

  it("estimates complete step tokens when provider returns 0", () => {
    const request = {
      system: [{ type: "text" as const, text: "You are a helpful assistant." }],
      messages: [Message.user("Привет, как дела?")],
      tools: [],
    } as unknown as LLMRequest

    const stepTokens = estimateStepTokens({
      request,
      assistantText: "Привет! Всё отлично, чем могу помочь?",
      reasoningText: "Пользователь поздоровался. Отвечаю вежливо.",
    })

    expect(stepTokens.input).toBeGreaterThan(10)
    expect(stepTokens.output).toBeGreaterThan(5)
    expect(stepTokens.reasoning).toBeGreaterThan(5)
    expect(stepTokens.cache.read).toBe(0)
  })
})
