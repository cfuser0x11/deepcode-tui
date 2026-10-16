import { expect, test } from "bun:test"
import { isAssistantWaitingForUser, isConcludingAssistantSummary } from "../src/session/runner/step.js"
import { cleanModelText } from "@opencode/ai"

test("isAssistantWaitingForUser identifies genuine questions from assistant", () => {
  expect(isAssistantWaitingForUser("Какой калькулятор вы хотите создать?")).toBe(true)
  expect(isAssistantWaitingForUser("Пожалуйста, уточните требования к проекту.")).toBe(true)
  expect(isAssistantWaitingForUser("What framework would you like to use?")).toBe(true)
  expect(isAssistantWaitingForUser("Папка test существует и пуста. Создам в ней калькулятор.")).toBe(false)
  expect(isAssistantWaitingForUser("Все файлы успешно созданы. <end_working>")).toBe(false)
})

test("cleanModelText removes <end_working> tags from user-facing text", () => {
  const raw = "Калькулятор успешно создан.\n<end_working>\nГотово к проверке."
  const cleaned = cleanModelText(raw)
  expect(cleaned).not.toContain("<end_working>")
  expect(cleaned).toContain("Калькулятор успешно создан.")
  expect(cleaned).toContain("Готово к проверке.")
})

test("detects premature <end_working> when model emits tag without tools or text", () => {
  const onlyEndWorking = "   <end_working>   "
  const clean1 = onlyEndWorking.replace(/<\/?(?:working|end_working)\b[^>]*>/gi, "").trim()
  expect(clean1.length).toBe(0)

  const summaryWithEndWorking = "Все файлы созданы и протестированы. <end_working>"
  const clean2 = summaryWithEndWorking.replace(/<\/?(?:working|end_working)\b[^>]*>/gi, "").trim()
  expect(clean2.length).toBeGreaterThan(0)
  expect(clean2).toBe("Все файлы созданы и протестированы.")
})

test("identifies empty response as stuck response for DeepSeek provider", () => {
  const checkStuck = (hasTools: boolean, text: string, provider: string, hasEndWorking: boolean) => {
    const clean = text.replace(/<\/?(?:working|end_working)\b[^>]*>/gi, "").trim()
    const hasVisibleText = clean.length > 0
    const isDeepSeek = provider.toLowerCase().includes("deepseek")
    return !hasTools && !hasVisibleText && (isDeepSeek || hasEndWorking)
  }

  // DeepSeek with 0 content tokens and no tools
  expect(checkStuck(false, "", "deepseek", false)).toBe(true)
  expect(checkStuck(false, "   ", "deepseek-chat", false)).toBe(true)

  // Other model with empty text and no end_working (e.g. test/mock end of turn)
  expect(checkStuck(false, "", "test", false)).toBe(false)

  // Any model with <end_working> but no text/tools
  expect(checkStuck(false, "<end_working>", "test", true)).toBe(true)

  // DeepSeek with actual visible text
  expect(checkStuck(false, "Готово!", "deepseek", false)).toBe(false)

  // DeepSeek with tools
  expect(checkStuck(true, "", "deepseek", false)).toBe(false)
})

test("isConcludingAssistantSummary identifies conclusion statements", () => {
  expect(isConcludingAssistantSummary("Все задачи выполнены. Код готов к использованию.")).toBe(true)
  expect(isConcludingAssistantSummary("Все проверки завершены, автотесты успешно пройдены.")).toBe(true)
  expect(isConcludingAssistantSummary("All tasks completed. Ready for use.")).toBe(true)
  expect(isConcludingAssistantSummary("Now the test file.")).toBe(false)
  expect(isConcludingAssistantSummary("Создаю калькулятор.")).toBe(false)
  expect(isConcludingAssistantSummary("")).toBe(false)
})

