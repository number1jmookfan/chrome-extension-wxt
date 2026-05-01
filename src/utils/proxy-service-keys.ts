import type { ProxyServiceKey } from "@webext-core/proxy-service"

import type { RecorderService } from "./services"

export const RECORDER_SERVICE_KEY =
  "recorder-service" as ProxyServiceKey<RecorderService>
