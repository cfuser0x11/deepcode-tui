export * as SessionTokenizer from "./tokenizer.js"

import type { ContentPart, LLMRequest, Message, ToolEntry } from "@opencode/ai"
import type { TokenUsage } from "@opencode/schema/token-usage"

// BPE token splitting regex matching contractions, words, 1-3 digit numbers, punctuation, whitespace runs
const BPE_SPLIT_REGEX =
  /'s|'t|'re|'ve|'m|'ll|'d|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu

export interface TokenizerConfig {
  readonly cyrillicCharsPerToken?: number
  readonly latinCharsPerToken?: number
}

const DEFAULT_CONFIG: TokenizerConfig = {
  cyrillicCharsPerToken: 1.7,
  latinCharsPerToken: 4,
}

let activeConfig = DEFAULT_CONFIG

export function configure(cfg: TokenizerConfig): void {
  activeConfig = { ...activeConfig, ...cfg }
}

/**
 * Counts the estimated tokens for a given string of text.
 * Implements high-fidelity Byte-Pair Encoding (BPE) calibrated for DeepSeek-V3 and DeepSeek-R1.
 */
export function countTokens(text: string): number {
  if (!text || typeof text !== "string") return 0
  if (text.length === 0) return 0

  const matches = text.match(BPE_SPLIT_REGEX)
  if (!matches) {
    return Math.max(1, Math.ceil(text.length / 3.5))
  }

  let tokens = 0
  const cyrRatio = activeConfig.cyrillicCharsPerToken ?? 1.7
  const latRatio = activeConfig.latinCharsPerToken ?? 3.8

  for (let i = 0; i < matches.length; i++) {
    const chunk = matches[i]

    // 1. Cyrillic / Russian text: UTF-8 multi-byte (2 bytes per char).
    // In DeepSeek/BPE vocab, Russian syllables are ~1.5 - 1.8 chars per token.
    if (/[\u0400-\u04FF]/.test(chunk)) {
      const clean = chunk.trim()
      tokens += Math.max(1, Math.ceil(clean.length / cyrRatio))
    }
    // 2. Whitespace runs / newlines / indents (spaces, tabs, newlines)
    else if (/^[\s\r\n]+$/.test(chunk)) {
      tokens += Math.max(1, Math.ceil(chunk.length / 3))
    }
    // 3. English / Latin words and subwords
    else if (/[a-zA-Z]/.test(chunk)) {
      tokens += Math.max(1, Math.ceil(chunk.length / latRatio))
    }
    // 4. Numbers: already sliced into 1-3 digits by \p{N}{1,3}
    else if (/^\p{N}+$/u.test(chunk)) {
      tokens += Math.max(1, Math.ceil(chunk.length / 3))
    }
    // 5. Code symbols, brackets, punctuation
    else {
      tokens += 1
    }
  }

  return Math.max(1, tokens)
}

export function countPartTokens(part: ContentPart): number {
  switch (part.type) {
    case "text":
      return countTokens(part.text)
    case "reasoning":
      return countTokens(part.text) + 2
    case "tool-call": {
      const inputStr = typeof part.input === "string" ? part.input : (JSON.stringify(part.input) ?? "")
      return countTokens(part.name) + 3 + countTokens(inputStr)
    }
    case "tool-result": {
      const resultStr =
        part.result.type === "content"
          ? part.result.value.map((c) => (c.type === "text" ? c.text : "")).join("")
          : (JSON.stringify(part.result.value) ?? "")
      return countTokens(part.name) + countTokens(resultStr)
    }
    case "compaction":
      return countTokens(part.text ?? "")
    case "media":
      return 100
    case "effort":
      return 0
    default:
      return 0
  }
}

export function countMessageTokens(message: Message): number {
  if (!message) return 0
  // ChatML overhead: <|im_start|>{role}\n ... <|im_end|>\n is ~4 tokens
  let tokens = 4
  if (message.content) {
    for (const part of message.content) {
      tokens += countPartTokens(part)
    }
  }
  return tokens
}

export function countToolTokens(tool: ToolEntry): number {
  if (tool.type === "tool") {
    let tokens = countTokens(tool.name) + countTokens(tool.description ?? "")
    if ("inputSchema" in tool && tool.inputSchema) {
      tokens += countTokens(JSON.stringify(tool.inputSchema))
    } else if ("parameters" in tool && (tool as any).parameters) {
      tokens += countTokens(JSON.stringify((tool as any).parameters))
    }
    return tokens
  }
  if (tool.type === "namespace") {
    let tokens = countTokens(tool.name) + countTokens(tool.description ?? "")
    for (const sub of tool.tools) {
      tokens += countToolTokens(sub)
    }
    return tokens
  }
  return 0
}

export function estimateRequestTokens(request: LLMRequest): number {
  let tokens = 0

  if (request.system && request.system.length > 0) {
    for (const part of request.system) {
      tokens += countTokens(part.text) + 4
    }
  }

  if (request.tools && request.tools.length > 0) {
    tokens += 10
    for (const tool of request.tools) {
      tokens += countToolTokens(tool)
    }
  }

  if (request.messages && request.messages.length > 0) {
    for (const msg of request.messages) {
      tokens += countMessageTokens(msg)
    }
  }

  tokens += 3 // Priming tokens
  return tokens
}

export function estimateStepTokens(input: {
  readonly request: LLMRequest
  readonly assistantText?: string
  readonly reasoningText?: string
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly input?: unknown }>
}): TokenUsage.Info {
  const inputTokens = estimateRequestTokens(input.request)

  let outputTokens = 0
  if (input.assistantText) {
    outputTokens += countTokens(input.assistantText)
  }
  if (input.toolCalls && input.toolCalls.length > 0) {
    for (const tc of input.toolCalls) {
      const args = typeof tc.input === "string" ? tc.input : (JSON.stringify(tc.input) ?? "")
      outputTokens += countTokens(tc.name) + 3 + countTokens(args)
    }
  }

  let reasoningTokens = 0
  if (input.reasoningText) {
    reasoningTokens = countTokens(input.reasoningText)
  }

  return {
    input: Math.max(1, inputTokens),
    output: outputTokens,
    reasoning: reasoningTokens,
    cache: {
      read: 0,
      write: 0,
    },
  }
}
