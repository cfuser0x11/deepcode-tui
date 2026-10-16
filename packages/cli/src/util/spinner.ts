export interface Spinner {
  update: (message: string) => void
  stop: (doneMessage?: string) => void
}

export function startSpinner(initialMessage: string): Spinner {
  const isTTY = Boolean(process.stderr.isTTY)
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let index = 0
  let currentMsg = initialMessage
  let active = true

  let timer: any = null

  if (isTTY) {
    timer = setInterval(() => {
      if (!active) return
      const frame = frames[index++ % frames.length]
      process.stderr.write(`\r\x1b[36m${frame}\x1b[0m [*] ${currentMsg}  `)
    }, 80)
  } else {
    process.stderr.write(`[*] ${initialMessage}\n`)
  }

  return {
    update(next: string) {
      currentMsg = next
      if (!isTTY) {
        process.stderr.write(`[*] ${next}\n`)
      }
    },
    stop(doneMessage?: string) {
      if (!active) return
      active = false
      if (timer) clearInterval(timer)
      if (isTTY) {
        if (doneMessage) {
          process.stderr.write(`\r\x1b[2K[+] ${doneMessage}\n`)
        } else {
          process.stderr.write(`\r\x1b[2K`)
        }
      } else if (doneMessage) {
        process.stderr.write(`[+] ${doneMessage}\n`)
      }
    },
  }
}
