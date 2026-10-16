import fs from "fs"
import path from "path"
import { intro, isCancel, outro, select, text, confirm, note } from "@clack/prompts"
import { Path } from "@opencode/util/global"

export function hasDeepSeekConfig(): boolean {
  const envKey = (process.env.DEEPSEEK_API_KEY || process.env.DEEPCODE_API_KEY)?.trim()
  const envURL = (process.env.DEEPSEEK_BASE_URL || process.env.DEEPCODE_API_URL)?.trim()

  const candidateDirs = [
    Path.config,
    path.join(Path.home, ".deepcode"),
    path.join(Path.home, ".config", "deepcode"),
    process.cwd(),
  ]

  const candidateFiles = ["deepcode.json", "deepcode.jsonc", "opencode.json", "opencode.jsonc"]

  for (const dir of candidateDirs) {
    for (const file of candidateFiles) {
      const fullPath = path.join(dir, file)
      if (fs.existsSync(fullPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, "utf8"))
          const rawKey =
            content?.provider?.deepseek?.options?.apiKey ??
            content?.provider?.deepseek?.apiKey ??
            content?.apiKey ??
            envKey

          const rawURL =
            content?.provider?.deepseek?.options?.baseURL ??
            content?.provider?.deepseek?.baseURL ??
            content?.baseURL ??
            envURL

          const apiKey = typeof rawKey === "string" ? rawKey.trim() : ""
          const baseURL = typeof rawURL === "string" ? rawURL.trim() : ""

          // Both token and endpoint must be present and non-empty
          if (apiKey && baseURL) {
            return true
          }
        } catch {}
      }
    }
  }

  // If no config file provided both, check if both are in environment variables
  if (envKey && envURL) {
    return true
  }

  return false
}

export async function runDeepSeekSetup(force = false): Promise<boolean> {
  if (!force && hasDeepSeekConfig()) {
    return true
  }

  if (!process.stdin.isTTY) {
    return false
  }

  const targetDir = Path.config
  const targetFile = path.join(targetDir, "deepcode.json")
  let existingConfig: any = {}
  if (fs.existsSync(targetFile)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(targetFile, "utf8"))
    } catch {}
  }

  const existingEndpoint = (
    existingConfig?.provider?.deepseek?.options?.baseURL ||
    existingConfig?.baseURL ||
    process.env.DEEPSEEK_BASE_URL ||
    process.env.DEEPCODE_API_URL ||
    "https://api.deepseek.com/v1"
  ).trim()

  const existingKey = (
    existingConfig?.provider?.deepseek?.options?.apiKey ||
    existingConfig?.apiKey ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.DEEPCODE_API_KEY ||
    ""
  ).trim()

  intro("DeepCode — DeepSeek Setup")
  note(
    "DeepSeek API key and Endpoint are required to use DeepCode.\nGet your key at: https://platform.deepseek.com/api_keys",
    "Configuration",
  )

  const endpointInput = await text({
    message: "Enter API Endpoint (press Enter for default):",
    placeholder: existingEndpoint,
    defaultValue: existingEndpoint,
    validate: (val) => {
      if ((!val || !val.trim()) && !existingEndpoint) return "Endpoint cannot be empty (Ctrl+C to abort)"
    },
  })

  if (isCancel(endpointInput)) {
    outro("Setup cancelled.")
    return false
  }

  const baseURL = String(endpointInput).trim() || existingEndpoint

  const maskedKey = existingKey ? `${existingKey.slice(0, 4)}...${existingKey.slice(-4)}` : ""
  const apiKeyInput = await text({
    message: maskedKey
      ? `Enter API Key / Token (press Enter to keep [${maskedKey}]):`
      : "Enter API Key / Token:",
    placeholder: maskedKey ? "Press Enter to keep current" : "sk-...",
    defaultValue: existingKey || undefined,
    validate: (val) => {
      if ((!val || !val.trim()) && !existingKey) return "API Key cannot be empty (Ctrl+C to abort)"
    },
  })

  if (isCancel(apiKeyInput)) {
    outro("Setup cancelled.")
    return false
  }

  const apiKey = String(apiKeyInput).trim() || existingKey

  const modelChoice = await select({
    message: "Choose default model:",
    options: [
      { value: "deepseek/deepseek-v4", label: "V4", hint: "Flagship model with thinking toggle" },
    ],
  })

  if (isCancel(modelChoice)) {
    outro("Setup cancelled.")
    return false
  }

  const deadModeChoice = await confirm({
    message: "Enable Dead Mode by default (uncensored direct system instructions)?",
    initialValue: Boolean(existingConfig?.deadMode ?? false),
  })

  if (isCancel(deadModeChoice)) {
    outro("Setup cancelled.")
    return false
  }

  // Save configuration
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  const newConfig = {
    ...existingConfig,
    $schema: "https://deepcode.ai/schema.json",
    model: String(modelChoice),
    deadMode: Boolean(deadModeChoice),
    provider: {
      ...(existingConfig?.provider ?? {}),
      deepseek: {
        options: {
          apiKey,
          baseURL,
          deadMode: Boolean(deadModeChoice),
        },
      },
    },
  }

  fs.writeFileSync(targetFile, JSON.stringify(newConfig, null, 2) + "\n", "utf8")

  // Set environment variables for the current running process
  process.env.DEEPSEEK_API_KEY = apiKey
  process.env.DEEPSEEK_BASE_URL = baseURL
  if (deadModeChoice) {
    process.env.DEEPCODE_DEAD_MODE = "1"
    process.env.DEAD_MODE = "1"
  }

  outro(`Configuration saved to ${targetFile}\nLaunching DeepCode...`)
  return true
}
