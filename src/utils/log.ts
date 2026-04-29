import * as Sentry from "@sentry/browser"

import type { LogLevel } from "./type"

Sentry.init({
  dsn: "https://7da6feab0f0bfc4b4067849a8925b89d@o4510115992109057.ingest.us.sentry.io/4510116173316096",
  enableLogs: true
})

export function remoteLog(
  msg: string,
  level: LogLevel = "info",
  attributes: Record<string, unknown> = {}
) {
  if (import.meta.env.NODE_ENV === "development")
    console.log(
      "[Chrome Extension]",
      msg,
      Object.keys(attributes).length > 0 ? attributes : ""
    )
  // Sentry.logger[level](`[Chrome Extension] ${msg}`, attributes)
}
