import { describe, expect, it } from "bun:test"
import { SessionMessage } from "../src/session/message.js"
import { calculateCeiling, previousCompactionTokens } from "../src/session/compaction.js"

describe("SessionCompaction calculateCeiling", () => {
  const deepseekModel = {
    ref: { providerID: "deepseek", id: "deepseek-chat" },
    limit: { context: 131_072, input: 128_000, output: 8_192 },
  } as any

  it("calculates default 80k threshold for DeepSeek when there is no previous compaction", () => {
    const ceiling = calculateCeiling(deepseekModel, undefined, undefined, [])
    expect(ceiling).toBe(80_000)
  })

  it("adds previous compaction tokens to the threshold (e.g. 80k new + 5k previous = 85k)", () => {
    // A completed compaction message with roughly 5k tokens of summary + recent
    // 1 token ~= 4 chars in Token.estimate for english
    const summaryText = "A".repeat(16_000) // ~4,000 tokens
    const recentText = "B".repeat(4_000)   // ~1,000 tokens
    const compactionMsg: SessionMessage.Info = {
      id: "msg_compaction_1" as SessionMessage.ID,
      sessionID: "ses_1" as any,
      timeCreated: 1,
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: summaryText,
      recent: recentText,
    } as any

    const prevTokens = previousCompactionTokens([compactionMsg], deepseekModel.ref)
    expect(prevTokens).toBeGreaterThanOrEqual(4_500)
    expect(prevTokens).toBeLessThanOrEqual(5_500)

    const ceiling = calculateCeiling(deepseekModel, undefined, undefined, [compactionMsg])
    expect(ceiling).toBe(80_000 + prevTokens)
    expect(ceiling).toBeGreaterThanOrEqual(84_500)
    expect(ceiling).toBeLessThanOrEqual(85_500)
  })

  it("supports custom threshold with previous compaction addition", () => {
    const summaryText = "Summary notes ".repeat(500) // ~1,750 tokens
    const compactionMsg: SessionMessage.Info = {
      id: "msg_compaction_2" as SessionMessage.ID,
      sessionID: "ses_1" as any,
      timeCreated: 1,
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: summaryText,
      recent: "",
    } as any

    const prevTokens = previousCompactionTokens([compactionMsg], deepseekModel.ref)
    const customThreshold = 50_000
    const ceiling = calculateCeiling(deepseekModel, undefined, customThreshold, [compactionMsg])
    expect(ceiling).toBe(customThreshold + prevTokens)
  })

  it("caps ceiling at model context limit minus reserve if threshold + checkpoint exceeds it", () => {
    const smallWindowModel = {
      ref: { providerID: "deepseek", id: "deepseek-chat" },
      limit: { context: 90_000, input: 90_000, output: 4_000 },
    } as any

    const hugeCompaction: SessionMessage.Info = {
      id: "msg_compaction_3" as SessionMessage.ID,
      sessionID: "ses_1" as any,
      timeCreated: 1,
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "X".repeat(80_000), // ~20,000 tokens
      recent: "",
    } as any

    // 80k threshold + 20k compaction = 100k, but window is 90k, reserve is 16k -> maxAllowed = 74k
    const ceiling = calculateCeiling(smallWindowModel, 16_000, 80_000, [hugeCompaction])
    expect(ceiling).toBe(80_000) // max(modelThreshold, maxAllowed) preserves at least the base threshold
  })
})
