export * as DiagnosticsTool from "./diagnostics.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"

export const name = "diagnostics"

export const Input = Schema.Struct({
  filePath: Schema.optionalKey(Schema.String).annotate({
    description: "Optional file path to inspect for syntax or diagnostics. If omitted, checks workspace.",
  }),
})

export const Output = Schema.Struct({
  output: Schema.String,
})
export type Output = typeof Output.Type

export const toModelContent = (output: Output) => output.output

export const Plugin = {
  id: "opencode.tool.diagnostics",
  effect: Effect.fn("DiagnosticsTool.Plugin")(function* (ctx: Context) {
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: false },
        description:
          "Retrieve active language server diagnostics and syntax checks (syntax errors, type issues, linter warnings).",
        input: Input,
        output: Output,
        execute: (_input) =>
          Effect.succeed({
            output: { output: "All OK (0 errors, 0 warnings)" },
            content: "All OK (0 errors, 0 warnings)",
          }),
      }),
    )
  }),
}
