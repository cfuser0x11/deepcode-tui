import { describe, expect, test } from "bun:test"
import { OptimizePlugin } from "@opencode/core/plugin/optimize"

describe("OptimizePlugin", () => {
  test("has no legacy multi-provider plugins in DeepCode", () => {
    expect(OptimizePlugin.Plugins).toEqual([])
  })
})
