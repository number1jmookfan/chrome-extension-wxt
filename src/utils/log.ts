import {
  BrowserClient,
  defaultStackParser,
  getDefaultIntegrations,
  makeFetchTransport,
  Scope
} from "@sentry/browser"
import * as Sentry from "@sentry/browser"

// filter integrations that use the global variable
const integrations = getDefaultIntegrations({}).filter((defaultIntegration) => {
  return ![
    "BrowserApiErrors",
    "BrowserSession",
    "Breadcrumbs",
    "ConversationId",
    "GlobalHandlers",
    "FunctionToString"
  ].includes(defaultIntegration.name)
})

const client = new BrowserClient({
  dsn: "https://7da6feab0f0bfc4b4067849a8925b89d@o4510115992109057.ingest.us.sentry.io/4510116173316096",
  integrations: integrations,
  stackParser: defaultStackParser,
  transport: makeFetchTransport,
  enableLogs: true
})

const scope = new Scope()
scope.setClient(client)
client.init() // initializing has to be done after setting the client on the scope

export function remoteLog(
  msg: string,
  level: LogLevel = "info",
  attributes: Record<string, unknown> = {}
) {
  if (import.meta.env.DEV)
    console.log(
      "[Chrome Extension]",
      msg,
      Object.keys(attributes).length > 0 ? attributes : ""
    )
  Sentry.logger[level](`[Chrome Extension] ${msg}`, attributes, { scope })
}
