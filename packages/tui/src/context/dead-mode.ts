import { createSignal } from "solid-js"
import { getSavedDeadMode, saveDeadMode } from "@opencode/util/dead-mode"

const initial = getSavedDeadMode()
if (initial) {
  process.env.DEEPCODE_DEAD_MODE = "1"
  process.env.DEAD_MODE = "1"
}

const [isDeadMode, setIsDeadMode] = createSignal(initial)

export function useDeadMode() {
  return {
    get: isDeadMode,
    toggle: () => {
      const next = !isDeadMode()
      setIsDeadMode(next)
      saveDeadMode(next)
      return next
    },
  }
}
