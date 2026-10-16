export interface ParsedToolCall {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

export interface DSMLParseResult {
  readonly cleanText: string
  readonly toolCalls: ReadonlyArray<ParsedToolCall>
}

// Regex matching DSML opening prefix: < | DSML | |  or  <｜DSML｜  or  <||DSML||
const DSML_OPEN_PREFIX = `<\\s*(?:[|\\uFF5C]\\s*){1,2}\\s*DSML\\s*(?:[|\\uFF5C]\\s*){1,2}`
const DSML_CLOSE_PREFIX = `<\\/\\s*(?:[|\\uFF5C]\\s*){1,2}\\s*DSML\\s*(?:[|\\uFF5C]\\s*){1,2}`

// Regex matching DeepSeek native tool call markers: <｜tool calls begin｜> or <|tool calls begin|>
const DEEPSEEK_TOOL_CALLS_BEGIN = `<\\s*(?:[|\\uFF5C]\\s*){1,2}\\s*tool\\s*calls?\\s*begin\\s*(?:[|\\uFF5C]\\s*){1,2}>`
const DEEPSEEK_TOOL_CALLS_END = `<\\s*(?:[|\\uFF5C]\\s*){1,2}\\s*tool\\s*calls?\\s*end\\s*(?:[|\\uFF5C]\\s*){1,2}>`

// Check if string might contain a tool call opening tag, raw JS tool invocation, or pseudo-tool call
const TOOL_START_REGEX = new RegExp(
  `${DSML_OPEN_PREFIX}\\s*(?:call|invoke|calls|parameter)|${DEEPSEEK_TOOL_CALLS_BEGIN}|<(?:tool_call|function_call|create_file|write_file|replace_file_content|edit_file|run_command|read_file|view_file|list_files|get_diagnostics|search_files|write|edit|read|shell|glob|grep|diagnostics)\\b|(?:(?:const|let|var)\\s+\\w+\\s*=\\s*)?await\\s+tools\\.|tools\\.(?:bash|shell|run_command|cmd|terminal|exec|write|read|edit|mkdir)\\s*\\(|(?:(?:\\[\\s*)?(?:Assistant\\s+)?(?:tool\\s+)?(?:call|action)\\s*\\]?:\\s*\\w+\\s*(?:\\(|\\{))|(?:(?:^|\\n)\\s*(?:Assistant:\\s*)?(?:\\[\\s*Action:[^\\]\\n]+\\]:?|(?:Tool|Action):)\\s*(?:[a-zA-Z0-9_]+\\s*)?:?\\s*\\{)|(?:(?:^|\\n)\\s*(?:Assistant:\\s*)?Action:\\s*[a-zA-Z0-9_]+[\\s\\S]*?Action Input:\\s*\\{)`,
  "i",
)

export function findToolBlockStart(text: string): number {
  const match = TOOL_START_REGEX.exec(text)
  return match ? match.index : -1
}

export function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  let inQuote: string | null = null
  let isEscaped = false

  for (let i = openIndex; i < text.length; i++) {
    const char = text[i]

    if (inQuote) {
      if (isEscaped) {
        isEscaped = false
      } else if (char === "\\") {
        isEscaped = true
      } else if (char === inQuote) {
        inQuote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      inQuote = char
      continue
    }

    if (char === "{") {
      depth++
    } else if (char === "}") {
      depth--
      if (depth === 0) {
        return i
      }
    }
  }

  return -1
}

export function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0
  let inQuote: string | null = null
  let isEscaped = false

  for (let i = openIndex; i < text.length; i++) {
    const char = text[i]

    if (inQuote) {
      if (isEscaped) {
        isEscaped = false
      } else if (char === "\\") {
        isEscaped = true
      } else if (char === inQuote) {
        inQuote = null
      }
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      inQuote = char
      continue
    }

    if (char === "(") {
      depth++
    } else if (char === ")") {
      depth--
      if (depth === 0) {
        return i
      }
    }
  }

  return -1
}

// Check if trailing string could be the start of a tool opening or closing tag
export function isPartialToolTag(text: string): boolean {
  const lastLt = text.lastIndexOf("<")
  if (lastLt !== -1) {
    const tail = text.slice(lastLt)
    if (tail.includes(">")) return false
    if (
      tail.length <= 60 &&
      (tail === "<" ||
        tail === "</" ||
        /^<\s*\/?\s*[|\uFF5C]/i.test(tail) ||
        /^<\s*\/?\s*(?:[|\uFF5C]\s*){1,2}\s*D/i.test(tail) ||
        /^<\s*\/?\s*(?:[|\uFF5C]\s*){1,2}\s*DSML/i.test(tail) ||
        /^<\s*\/?\s*t/i.test(tail) ||
        /^<\s*\/?\s*tool/i.test(tail) ||
        /^<\s*\/?\s*func/i.test(tail) ||
        /^<\s*\/?\s*param/i.test(tail) ||
        /^<\s*\/?\s*work/i.test(tail) ||
        /^<\s*\/?\s*end/i.test(tail) ||
        /^<\s*\/?\s*cr/i.test(tail) ||
        /^<\s*\/?\s*wr/i.test(tail) ||
        /^<\s*\/?\s*ed/i.test(tail) ||
        /^<\s*\/?\s*rep/i.test(tail) ||
        /^<\s*\/?\s*run/i.test(tail) ||
        /^<\s*\/?\s*read/i.test(tail) ||
        /^<\s*\/?\s*sh/i.test(tail) ||
        /^<\s*\/?\s*diag/i.test(tail) ||
        /^<\s*\/?\s*ex/i.test(tail))
    ) {
      return true
    }
  }

  // Also check if line might be starting raw JS tools call
  if (/(?:const|let|var|await|tools)\b\s*$/i.test(text) || /(?:await\s+tools\b|tools\b\.)$/i.test(text)) {
    return true
  }

  // Also check if line might be starting pseudo tool call like "Assistant tool call:"
  if (/(?:(?:\[\s*)?(?:Assistant\s+)?(?:tool\s+)?(?:call|action)(?:\s*\])?:?)\s*$/i.test(text)) {
    return true
  }

  // Also check if line might be starting Tool: { or Action:
  if (
    /(?:^|\n)\s*(?:Assistant:\s*)?(?:Tool|Action|\[\s*Action(?::\s*[a-zA-Z0-9_]+)?\s*\]?)(?:(?::\s*|\s+)[a-zA-Z0-9_]+)?\s*:?\s*$/i.test(text) ||
    /(?:^|\n)\s*(?:Assistant:\s*)?Action(?:\s+Input)?:\s*$/i.test(text)
  ) {
    return true
  }

  return false
}

export function hasCompleteToolBlock(text: string): boolean {
  if (!text) return false

  // If text starts with DeepSeek native tool calls begin:
  if (new RegExp(DEEPSEEK_TOOL_CALLS_BEGIN, "i").test(text)) {
    return new RegExp(DEEPSEEK_TOOL_CALLS_END, "i").test(text)
  }

  // If text starts with DSML calls:
  const isCallsBlock = new RegExp(`^\\s*${DSML_OPEN_PREFIX}\\s*calls`, "i").test(text)
  if (isCallsBlock) {
    const dsmlCloseCalls = new RegExp(`${DSML_CLOSE_PREFIX}\\s*calls>`, "i")
    return dsmlCloseCalls.test(text)
  }

  // If text starts with single DSML invoke / call:
  const isInvokeBlock = new RegExp(`^\\s*${DSML_OPEN_PREFIX}\\s*(?:invoke|call)`, "i").test(text)
  if (isInvokeBlock) {
    const dsmlCloseInvoke = new RegExp(`${DSML_CLOSE_PREFIX}\\s*(?:invoke|call|calls)>`, "i")
    return dsmlCloseInvoke.test(text)
  }

  // If text starts with DSML parameter directly:
  const isParamBlock = new RegExp(`^\\s*${DSML_OPEN_PREFIX}\\s*parameter`, "i").test(text)
  if (isParamBlock) {
    const dsmlCloseParam = new RegExp(`${DSML_CLOSE_PREFIX}\\s*(?:parameter|invoke|call|calls)>`, "i")
    return dsmlCloseParam.test(text)
  }

  // If text contains XML tool_call / function_call opening:
  if (/^\s*<(?:tool_call|function_call|tool)\b/i.test(text)) {
    return /<\/(?:tool_call|function_call|tool)>/i.test(text)
  }

  // If text contains direct tag:
  const directTagMatch = /^\s*<(create_file|write_file|replace_file_content|edit_file|run_command|read_file|view_file|list_files|get_diagnostics|search_files|write|edit|read|shell|glob|grep|diagnostics)\b/i.exec(text)
  if (directTagMatch) {
    return new RegExp(`<\\/${directTagMatch[1]}>`, "i").test(text)
  }

  // If text contains completed pseudo tool call: Assistant tool call: name(...)
  const pseudoStart = /(?:\[\s*)?(?:Assistant\s+)?(?:tool\s+)?(?:call|action)\s*\]?:\s*[a-zA-Z0-9_]+\s*\(/i.exec(text)
  if (pseudoStart) {
    const openParen = pseudoStart.index + pseudoStart[0].length - 1
    const closeParen = findMatchingParen(text, openParen)
    if (closeParen !== -1) {
      return true
    }
  }

  // If text contains [Action: shell]: {...} or Tool: {...} or Tool: shell {...} (with optional Assistant: prefix)
  const toolJsonMatch = /(?:^|\n)\s*(?:Assistant:\s*)?(?:\[\s*Action:\s*[a-zA-Z0-9_]+\s*\]:?|(?:Tool|Action):\s*(?:[a-zA-Z0-9_]+\s*)?:?)\s*\{/i.exec(text)
  if (toolJsonMatch) {
    const openBrace = toolJsonMatch.index + toolJsonMatch[0].lastIndexOf("{")
    const closeBrace = findMatchingBrace(text, openBrace)
    if (closeBrace !== -1) {
      return true
    }
  }

  // If text contains Action Input: {...}
  const actionJsonMatch = /(?:^|\n)\s*Action Input:\s*\{/i.exec(text)
  if (actionJsonMatch) {
    const openBrace = actionJsonMatch.index + actionJsonMatch[0].lastIndexOf("{")
    const closeBrace = findMatchingBrace(text, openBrace)
    if (closeBrace !== -1) {
      return true
    }
  }

  return false
}

function extractJsContent(code: string): string | null {
  const arrayMatch =
    code.match(/content\s*:\s*\[([\s\S]*?)\]\s*\.join\s*\(/i) ||
    code.match(/(?:const|let|var)\s+\w+\s*=\s*\[([\s\S]*?)\][\s\S]*?tools\.(?:fs\.)?write/i)
  if (arrayMatch) {
    const itemsText = arrayMatch[1]
    const stringRegex = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g
    const items: string[] = []
    let sm: RegExpExecArray | null
    while ((sm = stringRegex.exec(itemsText)) !== null) {
      items.push(sm[2].replace(/\\n/g, "\n").replace(/\\'/g, "'").replace(/\\"/g, '"'))
    }
    if (items.length > 0) {
      return items.join("\n")
    }
  }

  const str = extractJsString(code, "content")
  if (str !== null) return str

  const writeSyncMatch = code.match(/writeFileSync\s*\(\s*["'`][^"'`]+["'`]\s*,\s*(["'`])([\s\S]*?)\1\s*\)/i)
  if (writeSyncMatch) {
    return writeSyncMatch[2]
  }

  return null
}

function extractJsString(code: string, propName: string): string | null {
  const dbl = new RegExp(`${propName}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "is").exec(code)
  if (dbl) return dbl[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
  const sgl = new RegExp(`${propName}\\s*:\\s*'((?:\\\\.|[^'\\\\])*)'`, "is").exec(code)
  if (sgl) return sgl[1].replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
  const btk = new RegExp(`${propName}\\s*:\\s*\`((?:\\\\.|[^\`\\\\])*)\``, "is").exec(code)
  if (btk) return btk[1].replace(/\\`/g, "`").replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
  return null
}

function resolveJsTemplateCommand(codeContent: string, cmdStr: string): string {
  const vars: Record<string, string> = {}
  const varRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:`([\s\S]*?)`|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g
  let m: RegExpExecArray | null
  while ((m = varRegex.exec(codeContent)) !== null) {
    const varName = m[1]
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3].replace(/\\'/g, "'") : m[4].replace(/\\"/g, '"')
    vars[varName] = val
  }

  let resolvedCmd = cmdStr.replace(/\$\{\s*JSON\.stringify\(\s*(\w+)\s*\)\s*\}/g, (_, varName) => {
    if (vars[varName] !== undefined) {
      return JSON.stringify(vars[varName])
    }
    return _
  })

  resolvedCmd = resolvedCmd.replace(/\$\{\s*(\w+)\s*\}/g, (_, varName) => {
    if (vars[varName] !== undefined) {
      return vars[varName]
    }
    return _
  })

  return resolvedCmd
}

export function convertPseudoArgsToInner(fnName: string, rawArgs: string): string {
  const trimmed = rawArgs.trim()
  if (!trimmed) return ""

  // If already JSON object:
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed
  }

  // If single positional argument: e.g. "ls -la" or 'ls -la' or `ls -la`
  const singleQuotedMatch = trimmed.match(/^(['"`])([\s\S]*?)\1$/)
  if (singleQuotedMatch) {
    const val = singleQuotedMatch[2]
    const norm = fnName.toLowerCase()
    if (norm === "shell" || norm === "bash" || norm === "run_command" || norm === "cmd" || norm === "exec") {
      return `<parameter name="command">${val}</parameter>`
    }
    if (norm === "read" || norm === "read_file" || norm === "view_file" || norm === "cat") {
      return `<parameter name="path">${val}</parameter>`
    }
    if (norm === "glob" || norm === "list_files" || norm === "ls") {
      return `<parameter name="pattern">${val}</parameter>`
    }
    if (norm === "grep" || norm === "search_files") {
      return `<parameter name="pattern">${val}</parameter>`
    }
  }

  // Parse keyword arguments: key="value" or key='value' or key=`value` or key=value
  const params: Array<{ name: string; value: string }> = []
  const kwargRegex =
    /([a-zA-Z0-9_]+)\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`|([^,\s\)]+))/g
  let m: RegExpExecArray | null
  while ((m = kwargRegex.exec(trimmed)) !== null) {
    const key = m[1]
    const val =
      m[2] !== undefined
        ? m[2]
        : m[3] !== undefined
          ? m[3]
          : m[4] !== undefined
            ? m[4].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
            : m[5] !== undefined
              ? m[5].replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
              : m[6] !== undefined
                ? m[6].replace(/\\`/g, "`").replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
                : (m[7] || "").trim()
    params.push({ name: key, value: val })
  }

  if (params.length > 0) {
    return params.map((p) => `<parameter name="${p.name}">${p.value}</parameter>`).join("\n")
  }

  // Fallback: if tool is shell and cannot parse kwargs, treat whole trimmed string as command
  const norm = fnName.toLowerCase()
  if (norm === "shell" || norm === "bash" || norm === "run_command" || norm === "cmd" || norm === "exec") {
    const cleanCmd = trimmed.replace(/^['"`]+|['"`]+$/g, "")
    return `<parameter name="command">${cleanCmd}</parameter>`
  }

  return trimmed
}

export function stripToolTags(content: string): string {
  if (!content) return ""
  let text = content

  // 0. Remove DeepSeek native tool calls: <｜tool calls begin｜>...<｜tool calls end｜>
  const dsNativeRegex = new RegExp(
    `${DEEPSEEK_TOOL_CALLS_BEGIN}[\\s\\S]*?(?:${DEEPSEEK_TOOL_CALLS_END}|$)`,
    "gi",
  )
  text = text.replace(dsNativeRegex, "")

  // 1. Remove full DSML blocks: from opening calls/invoke to closing calls/invoke
  const dsmlBlockRegex = new RegExp(
    `${DSML_OPEN_PREFIX}\\s*(?:calls|call|invoke)[\\s\\S]*?(?:${DSML_CLOSE_PREFIX}\\s*(?:calls|call|invoke)[^>]*>|$)`,
    "gi",
  )
  text = text.replace(dsmlBlockRegex, "")

  // 1b. Remove orphan DSML parameter blocks
  const dsmlOrphanRegex = new RegExp(
    `${DSML_OPEN_PREFIX}\\s*parameter[\\s\\S]*?(?:${DSML_CLOSE_PREFIX}\\s*(?:parameter|calls|call|invoke)[^>]*>|$)`,
    "gi",
  )
  text = text.replace(dsmlOrphanRegex, "")

  // 2. Remove standard XML tool calls: <tool_call>...</tool_call>
  text = text.replace(/<(?:tool_call|function_call|tool)\b[\s\S]*?(?:<\/(?:tool_call|function_call|tool)>|$)/gi, "")

  // 3. Remove direct tags: <write_file>...</write_file>, etc.
  const directTags = [
    "create_file",
    "write_file",
    "replace_file_content",
    "edit_file",
    "run_command",
    "read_file",
    "view_file",
    "list_files",
    "get_diagnostics",
    "search_files",
    "write",
    "edit",
    "read",
    "shell",
    "glob",
    "grep",
    "diagnostics",
    "execute",
    "exec",
    "bash",
  ]
  for (const tag of directTags) {
    const r = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi")
    text = text.replace(r, "")
  }

  // 4. Clean up any stray/orphaned DSML tags (opening or closing)
  text = text.replace(/<\s*\/?\s*(?:[|\uFF5C]\s*)*DSML[^>]*>/gi, "")
  text = text.replace(new RegExp(`${DSML_OPEN_PREFIX}[^>]*>`, "gi"), "")
  text = text.replace(new RegExp(`${DSML_CLOSE_PREFIX}[^>]*>`, "gi"), "")
  text = text.replace(/<\/?(?:tool_call|function_call|tool|parameter|param|working|end_working|execute|exec|shell|action|command|function)\b[^>]*>/gi, "")

  // 5. Remove pseudo tool calls and any attached simulated Tool results
  const pseudoStripRegex = /(?:\[\s*)?(?:Assistant\s+)?(?:tool\s+)?(?:call|action)\s*\]?:\s*[a-zA-Z0-9_]+\s*\(/gi
  let sm: RegExpExecArray | null
  while ((sm = pseudoStripRegex.exec(text)) !== null) {
    const openParen = sm.index + sm[0].length - 1
    const closeParen = findMatchingParen(text, openParen)
    if (closeParen !== -1) {
      let endIdx = closeParen + 1
      if (text[endIdx] === ";") endIdx++

      // Check if immediately followed by a simulated Tool result block
      const tail = text.slice(endIdx)
      const boundedMatch =
        /^\s*(?:\[\s*)?(?:Result|Tool\s+result)\s*\]?:[\s\S]*?(?=(?:\n\s*(?:\[\s*)?(?:Assistant\s+)?(?:tool\s+)?(?:call|action)\b)|\n\s*\n)/i.exec(
          tail,
        )
      const indentedMatch =
        /^\s*(?:\[\s*)?(?:Result|Tool\s+result)\s*\]?:(?:[^\n]*\r?\n```[\s\S]*?```|[^\n]*(?:\r?\n[ \t]+[^\n]*)*)/i.exec(tail)
      const singleLineMatch = /^\s*(?:\[\s*)?(?:Result|Tool\s+result)\s*\]?:[^\n]*/i.exec(tail)
      const toolResultMatch = boundedMatch || indentedMatch || singleLineMatch

      if (toolResultMatch) {
        endIdx += toolResultMatch[0].length
      }

      text = text.slice(0, sm.index) + text.slice(endIdx)
      pseudoStripRegex.lastIndex = sm.index
    } else {
      break
    }
  }

  // 5b. Remove [Action: shell]: {...} or Tool: {...} calls (with optional Assistant: prefix) and any attached simulated Results
  const toolJsonStripRegex = /(?:^|\n)\s*(?:Assistant:\s*)?(?:\[\s*Action:\s*[a-zA-Z0-9_]+\s*\]:?|(?:Tool|Action):\s*(?:[a-zA-Z0-9_]+\s*)?:?)\s*\{/gi
  let tjm: RegExpExecArray | null
  while ((tjm = toolJsonStripRegex.exec(text)) !== null) {
    const openBrace = tjm.index + tjm[0].lastIndexOf("{")
    const closeBrace = findMatchingBrace(text, openBrace)
    if (closeBrace !== -1) {
      let endIdx = closeBrace + 1
      if (text[endIdx] === ";") endIdx++

      const tail = text.slice(endIdx)
      const boundedMatch =
        /^\s*(?:Assistant:\s*)?(?:\[\s*)?(?:Result|Tool\s+result)\s*\]?:[\s\S]*?(?=(?:\n\s*(?:Assistant:\s*)?(?:\[\s*Action:|(?:Tool|Action):)|\n\s*(?:\[\s*)?(?:Assistant\s+)?(?:tool\s+)?(?:call|action)\b)|\n\s*\n)/i.exec(
          tail,
        )
      const indentedMatch =
        /^\s*(?:Assistant:\s*)?(?:\[\s*)?(?:Result|Tool\s+result)\s*\]?:(?:[^\n]*\r?\n```[\s\S]*?```|[^\n]*(?:\r?\n[ \t]+[^\n]*)*)/i.exec(tail)
      const singleLineMatch = /^\s*(?:Assistant:\s*)?(?:\[\s*)?(?:Result|Tool\s+result)\s*\]?:[^\n]*/i.exec(tail)
      const resultMatch = boundedMatch || indentedMatch || singleLineMatch

      if (resultMatch) {
        endIdx += resultMatch[0].length
      }

      text = text.slice(0, tjm.index) + text.slice(endIdx)
      toolJsonStripRegex.lastIndex = tjm.index
    } else {
      break
    }
  }

  // 5c. Remove ReAct Action: ... Action Input: ...
  text = text.replace(/(?:^|\n)\s*(?:Assistant:\s*)?Action:\s*[a-zA-Z0-9_]+[\s\S]*?Action Input:\s*\{[\s\S]*?\}/gi, "")

  // Also clean up any standalone/orphan Result / Tool result blocks
  text = text.replace(
    /(?:^|\n)\s*(?:Assistant:\s*)?(?:\[\s*)?(?:Result|Tool\s+result)\s*\]?:(?:[^\n]*\r?\n```[\s\S]*?```|[^\n]*(?:\r?\n[ \t]+[^\n]*)*|[^\n]*)/gi,
    "\n\n",
  )

  return text
}

export function cleanModelText(content: string): string {
  if (!content) return ""
  let text = stripToolTags(content)

  // Remove raw JS tools invocations
  text = text.replace(/(?:(?:const|let|var)\s+\w+\s*=\s*)?await\s+tools\.[a-zA-Z0-9_.]+\s*\([\s\S]*?\);?/gi, "")
  text = text.replace(/tools\.[a-zA-Z0-9_.]+\s*\([\s\S]*?\);?/gi, "")
  text = text.replace(/console\.log\([\s\S]*?\);?/gi, "")

  // Remove any leftover pseudo tool call or Tool result lines
  text = text.replace(/(?:^|\n)\s*(?:\[\s*)?(?:Assistant\s+)?(?:tool\s+)?(?:call|action)\s*\]?:.*$/gim, "")
  text = text.replace(/(?:^|\n)\s*(?:Assistant:\s*)?\[\s*Action:\s*[a-zA-Z0-9_]+\s*\]:?.*$/gim, "")
  text = text.replace(/(?:^|\n)\s*(?:Assistant:\s*)?(?:Result|Tool\s+result)\s*\]?:.*$/gim, "")
  text = text.replace(/(?:^|\n)\s*(?:Assistant:\s*)?Tool:\s*\{.*$/gim, "")
  text = text.replace(/(?:^|\n)\s*(?:Assistant:\s*)?Tool:\s*[a-zA-Z0-9_]+\s*\{.*$/gim, "")
  text = text.replace(/(?:^|\n)\s*(?:Assistant:\s*)?Action:\s*[a-zA-Z0-9_]+\s*\{.*$/gim, "")
  text = text.replace(/(?:^|\n)\s*Assistant:\s*Result:.*$/gim, "")

  // Clean up multiple blank lines
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function parseDSMLAndXML(content: string, idPrefix: string = `call_dsml_${Date.now()}`): DSMLParseResult {
  const toolCalls: ParsedToolCall[] = []
  if (!content) return { cleanText: content, toolCalls }

  const cleanPath = (p: unknown): string => {
    if (typeof p !== "string") return ""
    let s = p.trim().replace(/^['"`]+|['"`]+$/g, "").trim()
    s = s.replace(new RegExp(`(?:${DSML_CLOSE_PREFIX}|<\\/\\s*(?:parameter|param|path|file|filepath|filename|target|name|invoke)?)[^>]*>`, "gi"), "")
    s = s.replace(/<[|｜\uFF5C].*$/g, "")
    s = s.replace(/<\/?[a-zA-Z0-9_\-:|｜\uFF5C\s]+>$/g, "")
    return s.trim().replace(/^['"`]+|['"`]+$/g, "").trim()
  }

  const processCall = (rawToolName: string, inner: string, rawAttrs: string = "") => {
    let toolName = (rawToolName || "").trim()
    let toolArgs: Record<string, unknown> = {}

    // Extract attributes from opening tag if present: e.g. path="...", file="...", cwd="..."
    const attrMatch = (attr: string): string | undefined => {
      const r = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i").exec(rawAttrs)
      return r ? r[1].trim() : undefined
    }
    const attrPath = cleanPath(
      attrMatch("path") ||
        attrMatch("file") ||
        attrMatch("filepath") ||
        attrMatch("file_path") ||
        attrMatch("file-path") ||
        attrMatch("filename") ||
        attrMatch("target") ||
        attrMatch("target_file") ||
        attrMatch("target-file") ||
        attrMatch("targetFile") ||
        attrMatch("destination") ||
        attrMatch("name"),
    )
    const attrOld =
      attrMatch("oldString") ||
      attrMatch("old_string") ||
      attrMatch("search") ||
      attrMatch("targetContent") ||
      attrMatch("target_content")
    const attrNew =
      attrMatch("newString") ||
      attrMatch("new_string") ||
      attrMatch("replace") ||
      attrMatch("replacementContent") ||
      attrMatch("replacement_content")
    const attrCwd = attrMatch("cwd") || attrMatch("workdir") || attrMatch("dir")

    // 1. JSON parsing attempt if inner is JSON
    const trimmedInner = inner.trim()
    if (trimmedInner.startsWith("{") && trimmedInner.endsWith("}")) {
      try {
        toolArgs = JSON.parse(trimmedInner)
      } catch {}
    }

    // 2. Extract DSML / XML parameter tags: <parameter name="..." ...>VALUE</parameter>
    const dsmlParams: Record<string, string> = {}
    const dsmlParamRegex = new RegExp(
      `(?:${DSML_OPEN_PREFIX}\\s*)?(?:parameter|param)\\s+name=["']?([^"'\\s>]+)["']?[^>]*>([\\s\\S]*?)(?:${DSML_CLOSE_PREFIX}[^>]*>|<\\/(?:parameter|param)[^>]*>|(?=${DSML_OPEN_PREFIX})|(?=<(?:parameter|param))|$)`,
      "gi",
    )
    let dMatch: RegExpExecArray | null
    while ((dMatch = dsmlParamRegex.exec(inner)) !== null) {
      dsmlParams[dMatch[1].trim()] = dMatch[2].trim()
    }

    // 3. Handle code execution / JS style calls like tools.bash({ command: "..." })
    const codeContent = dsmlParams.code || dsmlParams.script || (toolName === "execute" ? inner : "")
    if (codeContent) {
      let cmdStr = extractJsString(codeContent, "command")
      if (cmdStr) {
        cmdStr = resolveJsTemplateCommand(codeContent, cmdStr)
        toolName = "shell"
        toolArgs = { command: cmdStr.trim() }
      } else {
        const rawCode = codeContent.replace(/<\/[^>]+>$/g, "").trim()
        if (rawCode && !rawCode.includes("console.log") && !rawCode.includes("await tools.")) {
          toolName = "shell"
          toolArgs = { command: rawCode }
        }
      }

      if (!toolArgs.command && !toolArgs.path) {
        const mkdirMatch = codeContent.match(
          /tools\.(?:fs\.)?mkdir\s*\(\s*\{[\s\S]*?path\s*:\s*["'`]([\s\S]*?)["'`]\s*\}?\s*\)/i,
        )
        if (mkdirMatch) {
          toolName = "shell"
          toolArgs = { command: `mkdir -p "${mkdirMatch[1].trim()}"` }
        }

        const pathVal = cleanPath(extractJsString(codeContent, "path"))
        const contentVal = extractJsContent(codeContent)
        const isReadCall = /tools\.(?:fs\.)?read\b|readFileSync\b/i.test(codeContent)

        if (pathVal) {
          if (isReadCall) {
            toolName = "read"
            toolArgs = { path: pathVal }
          } else if (contentVal !== null) {
            toolName = "write"
            toolArgs = { path: pathVal, content: contentVal }
          }
        }
      }
    }

    // 4. Normalize tool names and parameters
    const normName = toolName.toLowerCase()
    if (
      normName === "run_command" ||
      normName === "bash" ||
      normName === "terminal" ||
      normName === "cmd" ||
      normName === "exec" ||
      normName === "shell"
    ) {
      const cm = inner.match(/<(?:command|cmd)>([\s\S]*?)<\/(?:command|cmd)>/i)
      const cwdMatch = inner.match(/<(?:cwd|dir|workdir)>([\s\S]*?)<\/(?:cwd|dir|workdir)>/i)
      let rawCmd = dsmlParams.command || dsmlParams.cmd || (cm ? cm[1].trim() : ((toolArgs.command as string) || inner.trim()))
      rawCmd = rawCmd
        .replace(new RegExp(`${DSML_CLOSE_PREFIX}\\s*(?:call|invoke)?`, "gi"), "")
        .replace(
          new RegExp(`^(?:${DSML_OPEN_PREFIX}\\s*)?(?:parameter|param)\\s+name=["']?(?:command|cmd)["']?[^>]*>`, "i"),
          "",
        )
        .replace(new RegExp(`<\/(?:${DSML_OPEN_PREFIX}\\s*)?(?:parameter|param)>$`, "i"), "")
        .replace(/^<(?:command|cmd)[^>]*>/i, "")
        .replace(/<\/(?:command|cmd)>$/i, "")
        .trim()
      const isProseMonologue =
        !cm &&
        !dsmlParams.command &&
        !dsmlParams.cmd &&
        !toolArgs.command &&
        (rawCmd.includes("<end_working>") ||
          rawCmd.includes("<working>") ||
          /(?:summary:|no task|declined to|ready to act|engineering work|simulating execution)/i.test(rawCmd) ||
          (rawCmd.includes("\n\n") && !/^(?:npm|git|bun|node|python|cargo|go|sh|bash|cat|cd|mkdir|rm|cp|mv|ls|dir|echo|export|set)\b/i.test(rawCmd)))
      if (isProseMonologue) {
        toolName = ""
        toolArgs = {}
      } else {
        toolName = "shell"
        toolArgs = {
          command: rawCmd,
          ...(dsmlParams.workdir || dsmlParams.cwd || cwdMatch || attrCwd
            ? { workdir: (dsmlParams.workdir || dsmlParams.cwd || (cwdMatch ? cwdMatch[1] : attrCwd!)).trim() }
            : {}),
        }
      }
    } else if (normName === "write_file" || normName === "create_file" || normName === "write") {
      const pm = inner.match(
        /<(?:path|file|filepath|file_path|file-path|filename|target|target_file|target-file|targetFile|destination|name)>([\s\S]*?)<\/(?:path|file|filepath|file_path|file-path|filename|target|target_file|target-file|targetFile|destination|name)>/i,
      )
      const cm = inner.match(/<content>([\s\S]*?)<\/content>/i)
      let pathVal = cleanPath(
        dsmlParams.path ||
          dsmlParams.file ||
          dsmlParams.filepath ||
          dsmlParams.file_path ||
          dsmlParams.filename ||
          dsmlParams.target ||
          dsmlParams.target_file ||
          dsmlParams.targetFile ||
          attrPath ||
          (pm ? pm[1].trim() : "") ||
          ((toolArgs.path as string) || (toolArgs.filePath as string) || (toolArgs.file as string) || (toolArgs.targetFile as string) || ""),
      )

      let contentVal = ""
      if (dsmlParams.content !== undefined) {
        contentVal = dsmlParams.content
      } else if (cm) {
        contentVal = cm[1]
      } else if (toolArgs.content !== undefined) {
        contentVal = toolArgs.content as string
      } else {
        // Strip any path tag or other known metadata tags from inner, the rest is content!
        let stripped = inner
          .replace(
            /<(?:path|file|filepath|file_path|file-path|filename|target|target_file|target-file|targetFile|destination|name)\b[^>]*>[\s\S]*?<\/(?:path|file|filepath|file_path|file-path|filename|target|target_file|target-file|targetFile|destination|name)>/gi,
            "",
          )
          .trim()
        contentVal = stripped
      }

      // If path is still empty, deduce it from comments or content signature
      if (!pathVal) {
        const commentMatch = (contentVal || inner).match(
          /(?:^|\n)\s*(?:\/\*+|\/{2,}|#|<!--)\s*([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]+)/,
        )
        if (commentMatch) {
          pathVal = cleanPath(commentMatch[1])
        }
      }

      if (!pathVal) {
        if (/<!DOCTYPE\s+html|<html[\s>]/i.test(contentVal)) {
          pathVal = "index.html"
        } else if (
          /(?:^|\n)\s*(?::root|\*|body|html|\.[a-zA-Z0-9_-]+)\s*\{[\s\S]*?(?:margin|padding|background|color|box-sizing):/i.test(
            contentVal,
          )
        ) {
          pathVal = "style.css"
        } else if (/(?:assert\.|describe\(|test\(|it\()[\s\S]*?(?:passed|failed|expect)/i.test(contentVal)) {
          pathVal = "test.js"
        } else if (
          /(?:THREE\.|requestAnimationFrame|canvas|renderer|PointerLock|createScene|GameMath|enemy|player|spawn)/i.test(
            contentVal,
          )
        ) {
          pathVal = "game.js"
        }
      }

      if (!pathVal) {
        const textBefore = content.slice(0, Math.max(0, content.indexOf(inner)))
        const fileMatch = textBefore.match(/(?:write|create|update|in)\s+`?([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]+)`?/i)
        if (fileMatch) {
          pathVal = cleanPath(fileMatch[1])
        }
      }

      // If content is wrapped in markdown code fence, unwrap it
      const codeFence = contentVal.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/)
      if (codeFence) {
        contentVal = codeFence[1]
      }

      toolName = "write"
      toolArgs = {
        path: pathVal,
        content: contentVal,
      }
    } else if (normName === "edit_file" || normName === "replace_file_content" || normName === "edit") {
      const pm = inner.match(
        /<(?:path|file|filepath|file_path|file-path|filename|target|target_file|target-file|targetFile|destination|name)>([\s\S]*?)<\/(?:path|file|filepath|file_path|file-path|filename|target|target_file|target-file|targetFile|destination|name)>/i,
      )
      const sm = inner.match(
        /<(?:search|target|targetContent|target_content|original|oldString|old_string|before)>([\s\S]*?)<\/(?:search|target|targetContent|target_content|original|oldString|old_string|before)>/i,
      )
      const rm = inner.match(
        /<(?:replace|replacement|replacementContent|replacement_content|newString|new_string|after)>([\s\S]*?)<\/(?:replace|replacement|replacementContent|replacement_content|newString|new_string|after)>/i,
      )
      let pathVal = cleanPath(
        dsmlParams.path ||
          dsmlParams.file ||
          dsmlParams.filepath ||
          dsmlParams.file_path ||
          dsmlParams.filename ||
          dsmlParams.target ||
          dsmlParams.target_file ||
          dsmlParams.targetFile ||
          attrPath ||
          (pm ? pm[1].trim() : "") ||
          ((toolArgs.path as string) || (toolArgs.filePath as string) || (toolArgs.file as string) || (toolArgs.targetFile as string) || ""),
      )
      const oldVal =
        dsmlParams.oldString ||
        dsmlParams.old_string ||
        dsmlParams.search ||
        dsmlParams.targetContent ||
        dsmlParams.target_content ||
        attrOld ||
        (sm ? sm[1] : "") ||
        ((toolArgs.oldString as string) || (toolArgs.targetContent as string) || (toolArgs.search as string) || "")
      const newVal =
        dsmlParams.newString ||
        dsmlParams.new_string ||
        dsmlParams.replace ||
        dsmlParams.replacementContent ||
        dsmlParams.replacement_content ||
        attrNew ||
        (rm ? rm[1] : "") ||
        ((toolArgs.newString as string) || (toolArgs.replacementContent as string) || (toolArgs.replace as string) || "")
      if (!pathVal) {
        const commentMatch = (oldVal + " " + newVal + " " + inner).match(
          /(?:^|\n|\s)(?:\/\*+|\/{2,}|#|<!--)\s*([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]+)/,
        )
        if (commentMatch) {
          pathVal = cleanPath(commentMatch[1])
        }
      }
      toolName = "edit"
      toolArgs = {
        path: pathVal,
        oldString: oldVal,
        newString: newVal,
      }
    } else if (
      normName === "read_file" ||
      normName === "view_file" ||
      normName === "view_file_slice" ||
      normName === "read" ||
      normName === "cat"
    ) {
      const pm = inner.match(
        /<(?:path|file|filepath|file_path|file-path|filename|target|target_file|target-file|targetFile|destination|name)>([\s\S]*?)<\/(?:path|file|filepath|file_path|file-path|filename|target|target_file|target-file|targetFile|destination|name)>/i,
      )
      const pathVal = cleanPath(
        dsmlParams.path ||
          dsmlParams.file ||
          dsmlParams.filepath ||
          dsmlParams.file_path ||
          dsmlParams.filename ||
          attrPath ||
          (pm ? pm[1].trim() : "") ||
          ((toolArgs.path as string) || (toolArgs.filePath as string) || (toolArgs.file as string) || inner.trim()),
      )
      toolName = "read"
      toolArgs = {
        path: pathVal,
      }
      if (dsmlParams.offset || dsmlParams.start_line) {
        toolArgs.offset = parseInt(dsmlParams.offset || dsmlParams.start_line, 10)
      }
      if (dsmlParams.limit) {
        toolArgs.limit = parseInt(dsmlParams.limit, 10)
      }
    } else if (
      normName === "list_files" ||
      normName === "list_workspace_files" ||
      normName === "ls" ||
      normName === "dir"
    ) {
      const pm = inner.match(/<(?:path|file|filepath|folder|directory)>([\s\S]*?)<\/(?:path|file|filepath|folder|directory)>/i)
      const pathVal = cleanPath(dsmlParams.path || dsmlParams.folder || attrPath || (pm ? pm[1].trim() : "") || ((toolArgs.path as string) || ""))
      toolName = "glob"
      toolArgs = {
        pattern: "*",
        ...(pathVal && pathVal !== "." ? { path: pathVal } : {}),
      }
    } else if (
      normName === "search_files" ||
      normName === "grep" ||
      normName === "find_files"
    ) {
      const qm = inner.match(/<(?:query|pattern)>([\s\S]*?)<\/(?:query|pattern)>/i)
      const queryVal =
        dsmlParams.query ||
        dsmlParams.pattern ||
        (qm ? qm[1].trim() : ((toolArgs.query as string) || (toolArgs.pattern as string) || inner.trim()))
      toolName = "grep"
      toolArgs = {
        pattern: queryVal,
      }
    } else if (
      normName === "get_diagnostics" ||
      normName === "diagnostics"
    ) {
      const pm = inner.match(/<(?:path|file|filepath)>([\s\S]*?)<\/(?:path|file|filepath)>/i)
      const pathVal = cleanPath(dsmlParams.path || dsmlParams.filePath || attrPath || (pm ? pm[1].trim() : "") || ((toolArgs.filePath as string) || ""))
      toolName = "diagnostics"
      toolArgs = {
        ...(pathVal ? { filePath: pathVal } : {}),
      }
    }

    if (toolName && Object.keys(toolArgs).length > 0) {
      toolCalls.push({
        id: `${idPrefix}_${toolCalls.length}`,
        name: toolName,
        input: toolArgs,
      })
    }
  }

  // 0. Match DeepSeek native tool calls: <｜tool calls begin｜><｜tool call begin｜>function<｜tool sep｜>name\n```json\n{...}\n```<｜tool call end｜><｜tool calls end｜>
  const dsNativeBlockRegex = new RegExp(
    `${DEEPSEEK_TOOL_CALLS_BEGIN}([\\s\\S]*?)(?:${DEEPSEEK_TOOL_CALLS_END}|$)`,
    "gi",
  )
  let dsBlockMatch: RegExpExecArray | null
  while ((dsBlockMatch = dsNativeBlockRegex.exec(content)) !== null) {
    const inner = dsBlockMatch[1]
    const callRegex = new RegExp(
      `<\\s*(?:[|\\uFF5C]\\s*){1,2}\\s*tool\\s*call\\s*begin\\s*(?:[|\\uFF5C]\\s*){1,2}>function<\\s*(?:[|\\uFF5C]\\s*){1,2}\\s*tool\\s*sep\\s*(?:[|\\uFF5C]\\s*){1,2}>([a-zA-Z0-9_]+)\\s*(?:\`\`\`(?:json)?\\s*)?([\\s\\S]*?)(?:\`\`\`)?(?:<\\s*(?:[|\\uFF5C]\\s*){1,2}\\s*tool\\s*call\\s*end\\s*(?:[|\\uFF5C]\\s*){1,2}>|$)`,
      "gi",
    )
    let callMatch: RegExpExecArray | null
    while ((callMatch = callRegex.exec(inner)) !== null) {
      const fnName = callMatch[1].trim()
      const rawBody = callMatch[2].trim()
      processCall(fnName, rawBody)
    }
  }

  // 1. Match DSML invoke/call blocks
  const dsmlRegex = new RegExp(
    `${DSML_OPEN_PREFIX}\\s*(?:call|invoke)\\s+name=["']?([^"'\\s>]+)["']?[^>]*>([\\s\\S]*?)(?:${DSML_CLOSE_PREFIX}\\s*(?:call|invoke|calls)[^>]*>|(?=${DSML_OPEN_PREFIX}\\s*(?:call|invoke))|$)`,
    "gi",
  )
  let m: RegExpExecArray | null
  let remainingContent = content
  while ((m = dsmlRegex.exec(content)) !== null) {
    processCall(m[1], m[2])
    remainingContent =
      remainingContent.slice(0, m.index) + " ".repeat(m[0].length) + remainingContent.slice(m.index + m[0].length)
  }

  // 1b. Match orphan DSML parameter blocks (where model omitted opening invoke/call tag)
  const orphanParamRegex = new RegExp(
    `${DSML_OPEN_PREFIX}\\s*parameter\\s+name=["']?([^"'\\s>]+)["']?[^>]*>([\\s\\S]*?)(?:${DSML_CLOSE_PREFIX}\\s*(?:parameter|invoke|call|calls)[^>]*>|<\\/(?:parameter|param)[^>]*>|(?=${DSML_OPEN_PREFIX}\\s*(?:parameter|call|invoke))|(?=<(?:parameter|param))|$)`,
    "gi",
  )
  const rawMatches: Array<{ name: string; value: string; start: number; end: number }> = []
  while ((m = orphanParamRegex.exec(remainingContent)) !== null) {
    rawMatches.push({
      name: m[1].toLowerCase().trim(),
      value: m[2].trim(),
      start: m.index,
      end: m.index + m[0].length,
    })
  }

  const groups: Array<Array<{ name: string; value: string }>> = []
  let currentGroup: Array<{ name: string; value: string; start: number; end: number }> | null = null

  for (const match of rawMatches) {
    if (!currentGroup) {
      currentGroup = [match]
    } else {
      const prev = currentGroup[currentGroup.length - 1]
      const gap = remainingContent.slice(prev.end, match.start).trim()
      if (gap.length < 50 && (!gap || gap.startsWith("</") || gap.startsWith("<|") || gap.startsWith("<｜"))) {
        currentGroup.push(match)
      } else {
        groups.push(currentGroup)
        currentGroup = [match]
      }
    }
  }
  if (currentGroup) {
    groups.push(currentGroup)
  }

  for (const group of groups) {
    const pMap: Record<string, string> = {}
    for (const item of group) {
      pMap[item.name] = item.value
    }
    const cmd = pMap.command || pMap.bash || pMap.cmd || pMap.shell
    const pPath = pMap.path || pMap.file || pMap.filepath || pMap.target
    const pContent = pMap.content

    if (cmd) {
      const workdir = pMap.workdir || pMap.cwd
      processCall("shell", `<parameter name="command">${cmd}</parameter>${workdir ? `<parameter name="workdir">${workdir}</parameter>` : ""}`)
    } else if (pPath && pContent !== undefined) {
      processCall("write", `<parameter name="path">${pPath}</parameter><parameter name="content">${pContent}</parameter>`)
    } else if (pPath && pContent === undefined) {
      processCall("read", `<parameter name="path">${pPath}</parameter>`)
    } else if (!pPath && pContent !== undefined) {
      processCall("write", `<parameter name="content">${pContent}</parameter>`)
    }
  }

  // 2. Match standard XML <tool_call name="..."> or <function_call name="...">
  const xmlRegex =
    /<(?:tool_call|function_call|tool)\s+([^>]*?)name=["']?([^"'\s>]+)["']?([^>]*)>([\s\S]*?)(?:<\/(?:tool_call|function_call|call|tool)>|$)/gi
  while ((m = xmlRegex.exec(content)) !== null) {
    processCall(m[2], m[4], `${m[1]} ${m[3]}`)
  }

  // 3. Match direct tags: <run_command>..., <write_file path="...">..., etc.
  const directTagRegex =
    /<(create_file|write_file|replace_file_content|edit_file|run_command|read_file|view_file|list_files|get_diagnostics|search_files|write|edit|read|shell|glob|grep|diagnostics|execute|exec|bash)\b([^>]*)>([\s\S]*?)(?:<\/\1>|$)/gi
  while ((m = directTagRegex.exec(content)) !== null) {
    const isClosed = m[0].toLowerCase().endsWith(`</${m[1].toLowerCase()}>`)
    const hasAttributes = m[2].trim().length > 0
    const hasChildTags = /<(?:command|cmd|path|file|content|parameter|param)\b/i.test(m[3])
    if (!isClosed && !hasAttributes && !hasChildTags) {
      continue
    }
    processCall(m[1], m[3], m[2])
  }

  // 3b. Match pseudo tool calls: Assistant tool call: shell(command="...") or [Action: shell]: ...
  const pseudoHeaderRegex =
    /(?:\[\s*)?(?:Assistant\s+)?(?:tool\s+)?(?:call|action)\s*\]?:\s*([a-zA-Z0-9_]+)\s*\(/gi
  let pm: RegExpExecArray | null
  while ((pm = pseudoHeaderRegex.exec(content)) !== null) {
    const fnName = pm[1]
    const openParen = pm.index + pm[0].length - 1
    const closeParen = findMatchingParen(content, openParen)
    if (closeParen !== -1) {
      const rawArgs = content.slice(openParen + 1, closeParen).trim()
      const convertedInner = convertPseudoArgsToInner(fnName, rawArgs)
      processCall(fnName, convertedInner)
      pseudoHeaderRegex.lastIndex = closeParen + 1
    }
  }

  // 3c. Match [Action: shell]: {...} or Tool: {...} or Action: {...} (with optional Assistant: prefix)
  const toolJsonRegex = /(?:^|\n)\s*(?:Assistant:\s*)?(?:\[\s*Action:\s*([a-zA-Z0-9_]+)\s*\]:?|(?:Tool|Action):\s*(?:([a-zA-Z0-9_]+)\s*)?:?)\s*(\{)/gi
  let tjMatch: RegExpExecArray | null
  while ((tjMatch = toolJsonRegex.exec(content)) !== null) {
    const explicitName = tjMatch[1] || tjMatch[2]
    const openBrace = tjMatch.index + tjMatch[0].lastIndexOf("{")
    const closeBrace = findMatchingBrace(content, openBrace)
    if (closeBrace !== -1) {
      const jsonStr = content.slice(openBrace, closeBrace + 1)
      try {
        const parsed = JSON.parse(jsonStr)
        let resolvedName = explicitName || (parsed.tool as string) || (parsed.name as string) || (parsed.action as string)
        if (!resolvedName) {
          if (parsed.command || parsed.cmd) {
            resolvedName = "shell"
          } else if (parsed.path && parsed.content !== undefined) {
            resolvedName = "write"
          } else if (parsed.path && (parsed.oldString !== undefined || parsed.old_string !== undefined)) {
            resolvedName = "edit"
          } else if (parsed.path && parsed.content === undefined) {
            resolvedName = "read"
          } else if (parsed.pattern) {
            resolvedName = "grep"
          } else {
            resolvedName = "shell"
          }
        }
        processCall(resolvedName, jsonStr)
        toolJsonRegex.lastIndex = closeBrace + 1
      } catch {}
    }
  }

  // 3d. Match ReAct Action: <name>\nAction Input: {...}
  const reactActionRegex = /(?:^|\n)\s*(?:Assistant:\s*)?Action:\s*([a-zA-Z0-9_]+)[\s\S]*?Action Input:\s*(\{)/gi
  let raMatch: RegExpExecArray | null
  while ((raMatch = reactActionRegex.exec(content)) !== null) {
    const fnName = raMatch[1]
    const openBrace = raMatch.index + raMatch[0].lastIndexOf("{")
    const closeBrace = findMatchingBrace(content, openBrace)
    if (closeBrace !== -1) {
      const jsonStr = content.slice(openBrace, closeBrace + 1)
      processCall(fnName, jsonStr)
      reactActionRegex.lastIndex = closeBrace + 1
    }
  }

  // 4. Fallback: match raw JS tools.bash / tools.write invocations if no tags matched
  if (toolCalls.length === 0) {
    let cmdStr = extractJsString(content, "command")
    if (cmdStr) {
      cmdStr = resolveJsTemplateCommand(content, cmdStr)
      toolCalls.push({
        id: `${idPrefix}_0`,
        name: "shell",
        input: { command: cmdStr.trim() },
      })
    }
    const pathVal = cleanPath(extractJsString(content, "path"))
    const contentVal = extractJsContent(content)
    if (pathVal && contentVal !== null) {
      toolCalls.push({
        id: `${idPrefix}_${toolCalls.length}`,
        name: "write",
        input: { path: pathVal, content: contentVal },
      })
    }
  }

  // 5. Fallback: match simulated "Tool: <shell-command>" lines like "Tool: node test.js" or "Tool: cat ..."
  if (toolCalls.length === 0) {
    const toolLineRegex = /(?:^|\n)\s*Tool:\s*(`?)(node\b|cat\b|npm\b|git\b|sh\b|bash\b|bun\b|python\b|ls\b|touch\b|echo\b|rm\b|dir\b|mkdir\b|[a-zA-Z0-9_.-]+\.(?:js|ts|py|sh|bat))\s*([^\n\r`]*)\1/gi
    let tMatch: RegExpExecArray | null
    while ((tMatch = toolLineRegex.exec(content)) !== null) {
      const fullCmd = `${tMatch[2]} ${tMatch[3]}`.trim()
      if (fullCmd && !fullCmd.endsWith(" written") && !fullCmd.endsWith(" created")) {
        toolCalls.push({
          id: `${idPrefix}_${toolCalls.length}`,
          name: "shell",
          input: { command: fullCmd },
        })
      }
    }
  }

  // 6. Fallback: match markdown code block if preceded by filename or path comment
  if (toolCalls.length === 0) {
    const codeBlockRegex = /(?:(?:File|Path|filename):\s*`?([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]+)`?|(?:^|\n)\s*([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]+)\s*:?)\s*\r?\n```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```/gi
    let cbMatch: RegExpExecArray | null
    while ((cbMatch = codeBlockRegex.exec(content)) !== null) {
      const p = cleanPath(cbMatch[1] || cbMatch[2])
      const code = cbMatch[3]
      if (p && code && code.length > 5) {
        toolCalls.push({
          id: `${idPrefix}_${toolCalls.length}`,
          name: "write",
          input: { path: p, content: code },
        })
      }
    }

    if (toolCalls.length === 0) {
      const inlineCommentRegex = /```[a-zA-Z0-9_-]*\r?\n\s*(?:\/\*+|\/{2,}|#|<!--)\s*([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]+)[\s\S]*?\r?\n([\s\S]*?)\r?\n```/gi
      let icMatch: RegExpExecArray | null
      while ((icMatch = inlineCommentRegex.exec(content)) !== null) {
        const p = cleanPath(icMatch[1])
        const code = icMatch[0].replace(/^```[a-zA-Z0-9_-]*\r?\n/, "").replace(/\r?\n```$/, "")
        if (p && code && code.length > 5) {
          toolCalls.push({
            id: `${idPrefix}_${toolCalls.length}`,
            name: "write",
            input: { path: p, content: code },
          })
        }
      }
    }
  }

  const cleanText = cleanModelText(content)
  return { cleanText, toolCalls }
}
