import { expect, test, afterEach } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

afterEach(() => {
  delete process.env.DEEPCODE_DEAD_MODE
  delete process.env.DEAD_MODE
})

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
  expect(prompt).toContain("You are DeepCode agent")
})

test("omits persona but keeps tool instructions in dead mode option", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"], { deadMode: true })
  expect(prompt).not.toContain("DeepCode agent")
  expect(prompt).toContain("Available tools: edit, read, shell.")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})

test("omits persona but keeps tool instructions when DEEPCODE_DEAD_MODE is set", () => {
  process.env.DEEPCODE_DEAD_MODE = "1"
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("DeepCode agent")
  expect(prompt).toContain("Available tools: edit, read, shell.")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})

test("omits persona but keeps tool instructions when DEAD_MODE is set", () => {
  process.env.DEAD_MODE = "1"
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("DeepCode agent")
  expect(prompt).toContain("Available tools: edit, read, shell.")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})

