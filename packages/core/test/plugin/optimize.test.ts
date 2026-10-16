import { describe, expect, test } from "vitest"
import { OptimizePlugin } from "@opencode/core/plugin/optimize"

describe("OptimizePlugin", () => {
  test("has no legacy multi-provider plugins in DeepCode", () => {
    expect(OptimizePlugin.Plugins).toEqual([])
  })
})
