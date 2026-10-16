/**
 * Model-facing file-write leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as WriteTool from "./write.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { Bom } from "@opencode/util/bom"
import { Environment } from "../../environment/index.js"
import { FileMutation } from "../../file-mutation.js"
import { Formatter } from "../../formatter.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { fileDiff } from "./file-diff.js"

export const name = "write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description: "Path to the file to write to",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Alternative path to the file to write to",
  }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelContent = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred write UX integrations remain visible at the model-facing seam. */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after LSP runtime exists.

export const Plugin = {
  id: "opencode.tool.write",
  effect: Effect.fn("WriteTool.Plugin")(function* (ctx: Context) {
    const access = yield* FileAccess.Service
    const fileMutation = yield* FileMutation.Service
    const environment = yield* Environment.Service
    const formatter = yield* Formatter.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, permission: "edit" },
          description:
            "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              let targetPath = (String(input.path || input.filePath || (input as Record<string, any>).file || "")).trim()
              if (!targetPath) {
                const commentMatch = (input.content || "").match(
                  /(?:^|\n)\s*(?:\/\*+|\/{2,}|#|<!--)\s*([a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]+)/,
                )
                if (commentMatch) {
                  targetPath = commentMatch[1].trim()
                } else if (/<!DOCTYPE\s+html|<html[\s>]/i.test(input.content || "")) {
                  targetPath = "index.html"
                } else if (
                  /(?:^|\n)\s*(?::root|\*|body|html|\.[a-zA-Z0-9_-]+)\s*\{[\s\S]*?(?:margin|padding|background|color|box-sizing):/i.test(
                    input.content || "",
                  )
                ) {
                  targetPath = "style.css"
                } else if (/(?:assert\.|describe\(|test\(|it\()[\s\S]*?(?:passed|failed|expect)/i.test(input.content || "")) {
                  targetPath = "test.js"
                }
              }
              if (!targetPath) {
                return yield* Effect.fail(
                  new ToolFailure({ message: "No file path provided to write", error: new Error("Empty path") }),
                )
              }
              const source = {
                type: "tool" as const,
                messageID: context.messageID,
                id: context.id,
              }
              const target = yield* access.resolve({ path: targetPath, kind: "file" })
              yield* access.authorizeExternal([target], context)
              const current = yield* FileMutation.readText(environment.files, target.absolute).pipe(
                Effect.catchTag("Environment.NotFound", () => Effect.undefined),
              )
              if (current && current.text.trim().length > 0 && input.content.trim().length === 0) {
                return yield* Effect.fail(
                  new ToolFailure({
                    message: `Refused to overwrite existing file '${targetPath}' (${current.text.length} bytes) with empty content. Provide the full new content or use edit tool.`,
                    error: new Error("Refused empty content overwrite"),
                  }),
                )
              }
              if (!current && input.content.trim().length === 0 && !targetPath.endsWith(".gitkeep")) {
                return yield* Effect.fail(
                  new ToolFailure({
                    message: `Refused to create empty file '${targetPath}'. Provide file content when calling write.`,
                    error: new Error("Empty file content"),
                  }),
                )
              }
              const next = Bom.split(input.content)
              const preview = fileDiff(target.resource, current?.text ?? "", next.text, current ? "modified" : "added")
              yield* permission.assert({
                action: "edit",
                resources: [target.resource],
                save: ["*"],
                metadata: { files: [preview] },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const result = yield* fileMutation.writeTextPreservingBom({ target, content: input.content })
              const bom = (yield* FileMutation.readText(environment.files, target.absolute)).bom
              if (yield* formatter.file(target.absolute)) {
                yield* FileMutation.syncTextBom(environment.files, target.absolute, bom)
              }
              return result
            }).pipe(
              Effect.map((output) => ({ output, content: toModelContent(output) })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to write ${input.path || input.filePath || ""}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
