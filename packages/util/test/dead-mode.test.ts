import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import { getSavedDeadMode, saveDeadMode } from "../src/dead-mode.js"
import { Path } from "../src/global.js"

describe("dead-mode persistence", () => {
  const configFile = path.join(Path.config, "deepcode.json")
  let originalConfig: string | null = null
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.DEEPCODE_DEAD_MODE
    delete process.env.DEEPCODE_DEAD_MODE
    delete process.env.DEAD_MODE

    if (fs.existsSync(configFile)) {
      originalConfig = fs.readFileSync(configFile, "utf8")
    } else {
      originalConfig = null
    }
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DEEPCODE_DEAD_MODE = originalEnv
    } else {
      delete process.env.DEEPCODE_DEAD_MODE
      delete process.env.DEAD_MODE
    }

    if (originalConfig !== null) {
      fs.writeFileSync(configFile, originalConfig, "utf8")
    } else if (fs.existsSync(configFile)) {
      fs.unlinkSync(configFile)
    }
  })

  test("saveDeadMode(true) persists to config and sets env var", () => {
    saveDeadMode(true)
    expect(process.env.DEEPCODE_DEAD_MODE).toBe("1")
    expect(process.env.DEAD_MODE).toBe("1")

    // delete env var to simulate fresh process restart
    delete process.env.DEEPCODE_DEAD_MODE
    delete process.env.DEAD_MODE

    expect(getSavedDeadMode()).toBe(true)
  })

  test("saveDeadMode(false) persists to config and clears env var", () => {
    saveDeadMode(true)
    expect(getSavedDeadMode()).toBe(true)

    saveDeadMode(false)
    expect(process.env.DEEPCODE_DEAD_MODE).toBeUndefined()
    expect(process.env.DEAD_MODE).toBeUndefined()

    expect(getSavedDeadMode()).toBe(false)
  })
})
