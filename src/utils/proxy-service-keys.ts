import type { ProxyServiceKey } from "@webext-core/proxy-service"

import type { BackgroundServices } from "./bg-service/bg-service"

export const BACKGROUND_SERVICE_KEY =
  "recorder-service" as ProxyServiceKey<BackgroundServices>
