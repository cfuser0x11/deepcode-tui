import { expect, test } from "bun:test"
import {
  parseDSMLAndXML,
  cleanModelText,
  stripToolTags,
  isPartialToolTag,
  hasCompleteToolBlock,
  findMatchingParen,
  convertPseudoArgsToInner,
} from "../src/protocols/utils/dsml-parser.js"

test("parseDSMLAndXML parses standard XML tool calls", () => {
  const content = `I will run a command:
<tool_call name="run_command">
<command>npm test</command>
</tool_call>`

  const { cleanText, toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("npm test")
  expect(cleanText).toBe("I will run a command:")
})

test("parseDSMLAndXML maps list_files to glob", () => {
  const content = `<tool_call name="list_files"><path>src</path></tool_call>`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("glob")
  expect(toolCalls[0].input.pattern).toBe("*")
  expect(toolCalls[0].input.path).toBe("src")
})

test("parseDSMLAndXML maps get_diagnostics to diagnostics", () => {
  const content = `<tool_call name="get_diagnostics"><path>src/index.ts</path></tool_call>`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("diagnostics")
  expect(toolCalls[0].input.filePath).toBe("src/index.ts")
})

test("parseDSMLAndXML maps search_files to grep", () => {
  const content = `<tool_call name="search_files"><query>calculate</query></tool_call>`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("grep")
  expect(toolCalls[0].input.pattern).toBe("calculate")
})

test("parseDSMLAndXML handles direct XML tags", () => {
  const content = `<write_file><path>test.txt</path><content>hello world</content></write_file>`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("write")
  expect(toolCalls[0].input.path).toBe("test.txt")
  expect(toolCalls[0].input.content).toBe("hello world")
})

test("parseDSMLAndXML handles XML tag attributes and direct body", () => {
  const content = `<write_file path="calculator.js">
function add(a, b) { return a + b; }
</write_file>`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("write")
  expect(toolCalls[0].input.path).toBe("calculator.js")
  expect(toolCalls[0].input.content).toBe("function add(a, b) { return a + b; }")
})

test("parseDSMLAndXML handles write tag and tool_call with file attribute", () => {
  const content = `<tool_call name="write" file="test.js">
console.log('ok');
</tool_call>`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("write")
  expect(toolCalls[0].input.path).toBe("test.js")
  expect(toolCalls[0].input.content).toBe("console.log('ok');")
})

test("parseDSMLAndXML handles replace_file_content with path attribute", () => {
  const content = `<replace_file_content path="src/app.ts">
<search>const a = 1;</search>
<replace>const a = 2;</replace>
</replace_file_content>`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("edit")
  expect(toolCalls[0].input.path).toBe("src/app.ts")
  expect(toolCalls[0].input.oldString).toBe("const a = 1;")
  expect(toolCalls[0].input.newString).toBe("const a = 2;")
})

test("cleanModelText removes tool calls and end_working tags", () => {
  const content = `Started.<tool_call name="run_command"><command>ls</command></tool_call>Done.<end_working>`
  const cleaned = cleanModelText(content)
  expect(cleaned).toContain("Started.")
  expect(cleaned).toContain("Done.")
  expect(cleaned).not.toContain("tool_call")
  expect(cleaned).not.toContain("end_working")
})

test("parseDSMLAndXML parses orphan DSML parameter blocks without invoke wrapper", () => {
  const content = `Some text
<｜｜DSML｜｜ parameter name="command" string="true">cat > test.js << 'EOF'
console.log('orphan');
EOF
echo "done"</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`

  const { cleanText, toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toContain("cat > test.js")
  expect(cleanText).toBe("Some text")
})

test("parseDSMLAndXML parses JS tools.write with array join", () => {
  const content = `<execute>
<parameter name="code">
const lines = [
  "const assert = require('assert');",
  "assert.strictEqual(1, 1);"
];
await tools.write({ path: 'test.js', content: lines.join('\\n') });
</parameter>
</execute>`

  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("write")
  expect(toolCalls[0].input.path).toBe("test.js")
  expect(toolCalls[0].input.content).toContain("assert.strictEqual(1, 1);")
})

test("parseDSMLAndXML groups contiguous orphan path and content parameters", () => {
  const content = `Some text
<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="path">calculator.js</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>
<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="content">
function add(a, b) { return a + b; }
</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>`

  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("write")
  expect(toolCalls[0].input.path).toBe("calculator.js")
  expect(toolCalls[0].input.content).toContain("function add")
})

test("parseDSMLAndXML maps orphan path-only parameter to read tool", () => {
  const content = `Some text
<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="path">package.json</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>`

  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("read")
  expect(toolCalls[0].input.path).toBe("package.json")
})

test("parseDSMLAndXML cleans trailing DSML tag from path parameter", () => {
  const content = `<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="path">src/lib/money.ts</\uFF5C\uFF5CDSML\uFF5C\uFF5C>
<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="content">export const a = 1;</\uFF5C\uFF5CDSML\uFF5C\uFF5C>`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("write")
  expect(toolCalls[0].input.path).toBe("src/lib/money.ts")
})

test("stripToolTags and cleanModelText remove orphan closing DSML calls tags", () => {
  const content = "Seed written. Now let me start Postgres, push the schema, and run the seed.\n\n</| | DSML | | calls>"
  expect(stripToolTags(content).trim()).toBe("Seed written. Now let me start Postgres, push the schema, and run the seed.")
  expect(cleanModelText(content)).toBe("Seed written. Now let me start Postgres, push the schema, and run the seed.")

  const fullwidthContent = "Seed written.\n\n</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>"
  expect(stripToolTags(fullwidthContent).trim()).toBe("Seed written.")
  expect(cleanModelText(fullwidthContent)).toBe("Seed written.")

  const compactContent = "Seed written.\n\n</\uFF5CDSML\uFF5Ccalls>"
  expect(stripToolTags(compactContent).trim()).toBe("Seed written.")
  expect(cleanModelText(compactContent)).toBe("Seed written.")

  const executeContent = "Seed written.\n\n</execute>"
  expect(stripToolTags(executeContent).trim()).toBe("Seed written.")
  expect(cleanModelText(executeContent)).toBe("Seed written.")
})

test("isPartialToolTag detects partial closing tags", () => {
  expect(isPartialToolTag("Seed written.\n\n<")).toBe(true)
  expect(isPartialToolTag("Seed written.\n\n</")).toBe(true)
  expect(isPartialToolTag("Seed written.\n\n</|")).toBe(true)
  expect(isPartialToolTag("Seed written.\n\n</| | DSML")).toBe(true)
  expect(isPartialToolTag("Seed written.\n\n</\uFF5C\uFF5CDSML")).toBe(true)
  expect(isPartialToolTag("Seed written.\n\n</tool")).toBe(true)
  expect(isPartialToolTag("Seed written.\n\n</| | DSML | | calls>")).toBe(false)
})

test("parseDSMLAndXML rejects prose mentioning unclosed tags without structured command", () => {
  const badMsg =
    "There is no planned task. Your messages so far contain only formatting directives and role reminders, not a concrete action.\n\nI will not fabricate tool calls. Emitting <shell> with nothing meaningful to run, or inventing a file to write, would be simulating execution rather than doing engineering work.\n\n<end_working>\n\nSummary:\n- No task was provided to execute."
  const res = parseDSMLAndXML(badMsg)
  expect(res.toolCalls.length).toBe(0)
  expect(res.cleanText).toContain("I will not fabricate tool calls.")
})

test("parseDSMLAndXML parses Assistant tool call: shell(command=...) with kwargs", () => {
  const content = `Let's run tests.
Assistant tool call: shell(command="pytest -v tests/test_calc.py")`

  const { toolCalls, cleanText } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("pytest -v tests/test_calc.py")
  expect(cleanText).toBe("Let's run tests.")
})

test("parseDSMLAndXML parses [Assistant tool call]: shell(...) bracket format", () => {
  const content = `[Assistant tool call]: shell(command="ls -la")`
  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("ls -la")
})

test("parseDSMLAndXML parses pseudo read and write calls", () => {
  const readContent = `Assistant tool call: read(path="package.json")`
  const readRes = parseDSMLAndXML(readContent)
  expect(readRes.toolCalls.length).toBe(1)
  expect(readRes.toolCalls[0].name).toBe("read")
  expect(readRes.toolCalls[0].input.path).toBe("package.json")

  const writeContent = `Assistant tool call: write(path="src/index.ts", content="console.log('hi');")`
  const writeRes = parseDSMLAndXML(writeContent)
  expect(writeRes.toolCalls.length).toBe(1)
  expect(writeRes.toolCalls[0].name).toBe("write")
  expect(writeRes.toolCalls[0].input.path).toBe("src/index.ts")
  expect(writeRes.toolCalls[0].input.content).toBe("console.log('hi');")
})

test("cleanModelText removes pseudo tool calls and simulated Tool result blocks", () => {
  const content = `I will run the command.
Assistant tool call: shell(command="pytest -v")
Tool result: Traceback (most recent call last):
  File "test.py", line 1, in <module>
    AssertionError: fail
Assistant tool call: shell(command="pytest -v --retry")
Tool result: All passed.
Everything is passing now!`

  const { toolCalls, cleanText } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(2)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("pytest -v")
  expect(toolCalls[1].name).toBe("shell")
  expect(toolCalls[1].input.command).toBe("pytest -v --retry")

  expect(cleanText).toContain("I will run the command.")
  expect(cleanText).toContain("Everything is passing now!")
  expect(cleanText).not.toContain("Assistant tool call")
  expect(cleanText).not.toContain("Tool result")
  expect(cleanText).not.toContain("AssertionError")
})

test("findMatchingParen handles parentheses inside quoted strings", () => {
  const text = 'shell(command="echo (nested parens) here") and some other text'
  const openIdx = text.indexOf("(")
  const closeIdx = findMatchingParen(text, openIdx)
  expect(closeIdx).toBe(text.indexOf('")') + 1)
})

test("hasCompleteToolBlock recognizes completed pseudo tool calls", () => {
  expect(hasCompleteToolBlock('Assistant tool call: shell(command="ls -la")')).toBe(true)
  expect(hasCompleteToolBlock('Assistant tool call: shell(command="ls')).toBe(false)
  expect(hasCompleteToolBlock('[Assistant tool call]: read(path="foo.txt")')).toBe(true)
})

test("parseDSMLAndXML parses Tool: {command: ...} benchmark format and cleans simulated [Result]", () => {
  const content = `I'll run tasklist to see the node processes.

Tool: {"command": "tasklist | findstr node"}

[Result]:
node.exe                      9232 Console                    1     45,120 K

Now I will terminate it.`

  const { toolCalls, cleanText } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("tasklist | findstr node")
  expect(cleanText).toContain("I'll run tasklist to see the node processes.")
  expect(cleanText).toContain("Now I will terminate it.")
  expect(cleanText).not.toContain("Tool:")
  expect(cleanText).not.toContain("[Result]")
  expect(cleanText).not.toContain("45,120 K")
})

test("parseDSMLAndXML parses Tool: shell {command: ...} format", () => {
  const content = `Tool: shell {"command": "git status"}`
  const { toolCalls, cleanText } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("git status")
  expect(cleanText).toBe("")
})

test("parseDSMLAndXML parses DeepSeek native tool calls with markdown JSON", () => {
  const content = `<\uFF5Ctool calls begin\uFF5C><\uFF5Ctool call begin\uFF5C>function<\uFF5Ctool sep\uFF5C>shell
\`\`\`json
{"command": "dir"}
\`\`\`<\uFF5Ctool call end\uFF5C><\uFF5Ctool calls end\uFF5C>`

  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("dir")
})

test("hasCompleteToolBlock recognizes Tool: {...} blocks", () => {
  expect(hasCompleteToolBlock('Tool: {"command": "dir"}')).toBe(true)
  expect(hasCompleteToolBlock('Tool: shell {"command": "dir"}')).toBe(true)
  expect(hasCompleteToolBlock('Tool: {"command": "dir"')).toBe(false)
  expect(hasCompleteToolBlock('Tool: shell {')).toBe(false)
})

test("isPartialToolTag detects Tool: trailing text", () => {
  expect(isPartialToolTag("Some text\nTool:")).toBe(true)
  expect(isPartialToolTag("Some text\nTool: shell")).toBe(true)
})

test("parseDSMLAndXML parses [Action: shell]: {command: ...} format", () => {
  const content = `[Action: shell]: {"command":"sed -n '1,120p' tools/fuzz.py"}

[Action: shell]: {"command":"sed -n '1,260p' tools/qemu_ctl.py"}`

  const { toolCalls, cleanText } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(2)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("sed -n '1,120p' tools/fuzz.py")
  expect(toolCalls[1].name).toBe("shell")
  expect(toolCalls[1].input.command).toBe("sed -n '1,260p' tools/qemu_ctl.py")
  expect(cleanText).toBe("")
})

test("parseDSMLAndXML parses Assistant: Action: shell: {command: ...} format and cleans simulated Result", () => {
  const content = `Now I'll read the input-handling code and the harness key injection to find the root cause.

Let me start by examining the WM input path and the key() implementation.

Assistant: Action: shell: {"command":"cd /c/Users/steep/Desktop/tinyos && sed -n '1,200p' src/wm_input.asm"}

Assistant: Action: shell: {"command":"cd /c/Users/steep/Desktop/tinyos && grep -n \\"def key\\" tools/qemu_ctl.py"}

Assistant: Result: Tool execution`

  const { toolCalls, cleanText } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(2)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("cd /c/Users/steep/Desktop/tinyos && sed -n '1,200p' src/wm_input.asm")
  expect(toolCalls[1].name).toBe("shell")
  expect(toolCalls[1].input.command).toContain("def key")
  expect(cleanText).toContain("Now I'll read the input-handling code")
  expect(cleanText).not.toContain("Assistant: Action: shell:")
  expect(cleanText).not.toContain("Result: Tool execution")
})

test("parseDSMLAndXML handles parameter=\"content\" shorthand in write tool call", () => {
  const content = `< | DSML | | calls>
< | DSML | | call name="write">
< | DSML | | parameter="content" string="true">export interface NavLink {
  id: string;
  label: string;
}
</ | DSML | | parameter>
< | DSML | | parameter name="path" string="true">C:\\Users\\steep\\Desktop\\ruff\\src\\lib\\nav.ts</ | DSML | | parameter>
</invoke>
</ | DSML | | calls>`

  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("write")
  expect(toolCalls[0].input.path).toBe("C:\\Users\\steep\\Desktop\\ruff\\src\\lib\\nav.ts")
  expect(toolCalls[0].input.content).toContain("export interface NavLink")
  expect(toolCalls[0].input.content).not.toContain("DSML")
  expect(toolCalls[0].input.content).not.toContain("parameter")
  expect(toolCalls[0].input.content).not.toContain("invoke")
})

test("parseDSMLAndXML handles parameter=\"command\" shorthand in shell call", () => {
  const content = `< | DSML | | calls>
< | DSML | | parameter="command">npm install --no-audit --no-fund</ | DSML | | parameter>
</ | DSML | | calls>`

  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe("npm install --no-audit --no-fund")
  expect(toolCalls[0].input.command).not.toContain("parameter")
  expect(toolCalls[0].input.command).not.toContain("DSML")
})

test("parseDSMLAndXML handles shell command with separate timeout parameter", () => {
  const content = `< | DSML | | parameter="command">cmd /c "if exist node_modules (echo INSTALLED) else (echo MISSING) & echo --- & npm run typecheck"</ | DSML | | parameter>
< | DSML | | parameter name="timeout" string="false">180000</ | DSML | | parameter>`

  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe(
    'cmd /c "if exist node_modules (echo INSTALLED) else (echo MISSING) & echo --- & npm run typecheck"',
  )
  expect(toolCalls[0].input.command).not.toContain("180000")
  expect(toolCalls[0].input.command).not.toContain("parameter")
})

test("parseDSMLAndXML handles <call name=\"shell\"> with trailing timeout line", () => {
  const content = `<call name="shell">
cmd /c "npm run build > build.log 2>&1 & echo EXIT:%ERRORLEVEL%"
300000
</call>`

  const { toolCalls } = parseDSMLAndXML(content)
  expect(toolCalls.length).toBe(1)
  expect(toolCalls[0].name).toBe("shell")
  expect(toolCalls[0].input.command).toBe('cmd /c "npm run build > build.log 2>&1 & echo EXIT:%ERRORLEVEL%"')
  expect(toolCalls[0].input.command).not.toContain("300000")
})





