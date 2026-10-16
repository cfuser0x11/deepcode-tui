import { createSignal, onCleanup, onMount } from "solid-js"
import { createSimpleContext } from "./helper"
import { useLog } from "./log"
import { useStorage } from "./storage"
import { useEvent } from "./event"
import { errorMessage } from "../util/error"
import { useExit } from "./exit"
import { useDialog } from "../ui/dialog"
import { DialogUpdate } from "../component/dialog-update"

type ClientNotice = { readonly type: "available" | "installed"; readonly version: string }
type Notice = ClientNotice & ({ readonly source: "client" } | { readonly source: "server"; readonly remote: boolean })
export type UpdateState =
  | ClientNotice
  | { readonly type: "installing"; readonly version: string }
  | { readonly type: "failed"; readonly message: string }

export type UpdateSource = {
  readonly remote: boolean
  readonly subscribe: (notify: (notice: ClientNotice) => void) => () => void
  readonly check: (
    signal: AbortSignal,
    onInstall: (version: string) => void,
  ) => Promise<ClientNotice | { readonly type: "unavailable"; readonly message: string } | undefined>
  readonly apply: (version: string) => Promise<void>
}

export const { use: useUpdateNotification, provider: UpdateNotificationProvider } = createSimpleContext({
  name: "UpdateNotification",
  init: (props: { updater?: UpdateSource }) => {
    const event = useEvent()
    const exit = useExit()
    const dialog = useDialog()
    const log = useLog({ component: "update-notification" })
    const [state, setState] = createSignal<UpdateState>()
    const [notification, setNotification] = createSignal<Notice>()
    const [notifications, markNotification] = useStorage().store<{ versions: string[] }>("update-notifications", {
      initial: { versions: [] },
    })

    const notify = (notice: Notice) => {
      if (!props.updater) return
      if (
        notifications.versions.includes(`${notice.source}:${notice.version}`) ||
        (notice.source === "client" && notifications.versions.includes(notice.version))
      )
        return
      setNotification((current) => {
        if (notice.source === "server" && current?.source === "client") return current
        return notice
      })
    }

    const dismiss = () => {
      const current = notification()
      if (!current) return
      setNotification(undefined)
      // Only interactions with the automatic notification update its history.
      void markNotification((draft) => {
        draft.versions = [...draft.versions, `${current.source}:${current.version}`].slice(-100)
      }).catch((error) => log.error("failed to persist update notification", { error }))
    }

    const install = async () => {
      const current = state()
      if (!current || current.type !== "available") return
      setState({ type: "installing", version: current.version })
      const updater = props.updater
      if (!updater) {
        setState({
          type: "failed",
          message:
            "Updater service is not available. Please download the release from https://github.com/cfuser0x11/deepcode-tui/releases/latest",
        })
        return
      }
      await updater.apply(current.version).then(
        () => setState({ type: "installed", version: current.version }),
        (error) => setState({ type: "failed", message: errorMessage(error) }),
      )
    }

    const check = async (signal: AbortSignal) => {
      const updater = props.updater
      if (state()?.type === "installing") return
      if (!updater) {
        try {
          const res = await fetch("https://github.com/cfuser0x11/deepcode-tui/releases/latest", {
            method: "HEAD",
            redirect: "manual",
            headers: { "User-Agent": "deepcode-tui" },
            signal,
          })
          let tag: string | undefined
          if (res.status >= 300 && res.status < 400) {
            tag = res.headers.get("location")?.split("/").pop()?.trim()
          }
          if (!tag) {
            const apiRes = await fetch("https://api.github.com/repos/cfuser0x11/deepcode-tui/releases/latest", {
              headers: { "User-Agent": "deepcode-tui", Accept: "application/vnd.github.v3+json" },
              signal,
            })
            if (apiRes.ok) {
              const data = (await apiRes.json()) as { tag_name?: string }
              tag = data.tag_name?.trim()
            }
          }
          if (tag) {
            setState({ type: "available", version: tag })
            return undefined
          }
          return "Could not fetch release information from GitHub."
        } catch (error) {
          return errorMessage(error)
        }
      }
      const result = await updater
        .check(signal, (version) => {
          if (!signal.aborted) setState({ type: "installing", version })
        })
        .finally(() => {
          if (state()?.type === "installing") setState(undefined)
        })
      if (signal.aborted) return
      if (result?.type === "unavailable") return result.message
      setState(result)
    }

    const restart = () => {
      const current = state()
      if (current?.type !== "installed") return
      exit()
    }

    const open = (origin: "manual" | "notification") => {
      const current = notification()
      const known = current && (current.source === "client" || !current.remote) ? current : undefined
      if (origin === "notification" && !known) return
      const active = state()
      // The notification can predate an installation through /update.
      if (known && active?.type !== "installing" && !(active?.type === "installed" && active.version === known.version))
        setState({ type: known.type, version: known.version })
      const status = state()?.type
      dialog.replace(() => (
        <DialogUpdate
          check={status === undefined || status === "failed" ? check : undefined}
          state={state}
          skip={dismiss}
          install={install}
          restart={restart}
          autoInstall={origin === "manual"}
        />
      ))
    }

    onMount(() => {
      if (!props.updater) return
      onCleanup(props.updater.subscribe((notice) => notify({ ...notice, source: "client" })))
    })

    onCleanup(
      event.on("installation.update-available", (event) =>
        notify({
          source: "server",
          remote: props.updater?.remote ?? false,
          type: "available",
          version: event.data.version,
        }),
      ),
    )
    onCleanup(
      event.on("installation.updated", (event) =>
        notify({
          source: "server",
          remote: props.updater?.remote ?? false,
          type: "installed",
          version: event.data.version,
        }),
      ),
    )

    return {
      notification,
      dismiss,
      open,
    }
  },
})
