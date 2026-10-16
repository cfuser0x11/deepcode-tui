import { createSignal } from "solid-js"

const [isDeadMode, setIsDeadMode] = createSignal(
  process.env.DEEPCODE_DEAD_MODE === "1" || process.env.DEAD_MODE === "1",
)

export function useDeadMode() {
  return {
    get: isDeadMode,
    toggle: () => {
      const next = !isDeadMode()
      setIsDeadMode(next)
      if (next) {
        process.env.DEEPCODE_DEAD_MODE = "1"
        process.env.DEAD_MODE = "1"
      } else {
        delete process.env.DEEPCODE_DEAD_MODE
        delete process.env.DEAD_MODE
      }
      return next
    },
  }
}
