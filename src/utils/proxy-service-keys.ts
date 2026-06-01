import type { ProxyServiceKey } from "@webext-core/proxy-service"

import type { RecorderService } from "./recorder-service"

export const RECORDER_SERVICE_KEY =
  "recorder-service" as ProxyServiceKey<RecorderService>
