import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { runDeepSeekSetup } from "../../setup"
import { runDefault } from "./default"

export default Runtime.handler(
  Commands.commands.setup,
  Effect.fn("cli.setup")((_input) =>
    Effect.gen(function* () {
      const ok = yield* Effect.promise(() => runDeepSeekSetup(true))
      if (!ok) return
      yield* runDefault({
        standalone: false,
        background: false,
        server: Option.none(),
        auto: false,
        yolo: false,
        dangerouslySkipPermissions: false,
        dead: false,
        setup: false,
        directory: Option.none(),
        continue: false,
        session: Option.none(),
        prompt: Option.none(),
      })
    }),
  ),
)

