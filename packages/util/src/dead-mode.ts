import fs from "fs"
import path from "path"
import { Path } from "./global.js"

const candidateFiles = ["deepcode.json", "deepcode.jsonc", "opencode.json", "opencode.jsonc"]

function candidateDirs(): string[] {
  return [
    Path.config,
    path.join(Path.home, ".deepcode"),
    path.join(Path.home, ".config", "deepcode"),
    process.cwd(),
  ]
}

export function getSavedDeadMode(): boolean {
  if (process.env.DEEPCODE_DEAD_MODE === "1" || process.env.DEAD_MODE === "1") {
    return true
  }

  for (const dir of candidateDirs()) {
    for (const file of candidateFiles) {
      const fullPath = path.join(dir, file)
      if (fs.existsSync(fullPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, "utf8"))
          const isDead = content?.deadMode ?? content?.provider?.deepseek?.options?.deadMode
          if (typeof isDead === "boolean") {
            return isDead
          }
        } catch {}
      }
    }
  }

  return false
}

export function saveDeadMode(enabled: boolean): void {
  let updated = false

  for (const dir of candidateDirs()) {
    for (const file of candidateFiles) {
      const fullPath = path.join(dir, file)
      if (fs.existsSync(fullPath)) {
        try {
          const raw = fs.readFileSync(fullPath, "utf8")
          const content = JSON.parse(raw)
          content.deadMode = enabled
          if (content.provider?.deepseek?.options) {
            content.provider.deepseek.options.deadMode = enabled
          }
          fs.writeFileSync(fullPath, JSON.stringify(content, null, 2) + "\n", "utf8")
          updated = true
        } catch {}
      }
    }
  }

  if (!updated) {
    const targetDir = Path.config
    const targetFile = path.join(targetDir, "deepcode.json")
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }
      const content = {
        $schema: "https://deepcode.ai/schema.json",
        deadMode: enabled,
      }
      fs.writeFileSync(targetFile, JSON.stringify(content, null, 2) + "\n", "utf8")
    } catch {}
  }

  if (enabled) {
    process.env.DEEPCODE_DEAD_MODE = "1"
    process.env.DEAD_MODE = "1"
  } else {
    delete process.env.DEEPCODE_DEAD_MODE
    delete process.env.DEAD_MODE
  }
}
