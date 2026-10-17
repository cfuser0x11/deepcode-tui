export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"

export function isDeadMode(options?: { deadMode?: boolean }) {
  return Boolean(
    options?.deadMode ||
    process.env.DEEPCODE_DEAD_MODE === "1" ||
    process.env.DEAD_MODE === "1"
  )
}

export function make(tools: string[], options?: { deadMode?: boolean }) {
  if (isDeadMode(options)) {
    return ""
  }
  return render(PROMPT, tools, options)
}

export const DEAD_MODE_PROMPT = ""

export function render(prompt: string, tools: string[], options?: { deadMode?: boolean }) {
  if (isDeadMode(options)) {
    return ""
  }
  const instructions: string[] = []
  if (tools.includes("shell")) {
    instructions.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
    )
  }
  if (tools.includes("write")) {
    instructions.push(
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.",
    )
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  const workspaceTools = tools.filter((t) => ["shell", "write", "edit", "read", "patch"].includes(t))
  if (workspaceTools.length > 0) {
    instructions.push(
      `- Direct workspace tools (${workspaceTools.join(", ")}) are always active. Use native tool calling or format calls as \`<tool_call name="tool_name">{"param": "value"}</tool_call>\`.`,
    )
  }
  return prompt.replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}

