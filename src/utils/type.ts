import type { Timestamp } from "firebase/firestore"

// API request types
export type PageVisitApiReq = {
  tab_id: number
  url: string
  session_id: string
  visited_at: number
}

export type CaptureApiReq = {
  session_id: string
  source_url: string
  image_data_url: string
}

export type BrowserDataApiReq = {
  session_id: string
  rawEvent: string
  storageExport?: StorageExport
}

export type DocUploadApiReq = {
  session_id: string
  source_url: string
  filename: string
}

// Other types
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export interface LogEntry {
  _time: string
  traceId: string
  msg: string
  level: LogLevel
  attributes: Record<string, unknown>
}

export type CommDocMessage = {
  action:
    | "capture_req"
    | "full_page_capture_req"
    | "capture_resp"
    | "doc_capture_req"
    | "doc_capture_resp"
    | "doc_capture_done"
    | "pwd_input_found"
    | "session_initialized"
  createdAt?: Timestamp
  payload?: CaptureRespPayload
}

export type CaptureRespPayload = {
  status: string
  message?: string
  data: { id: string }
}

// --- Recording (Playwright replay) ---
export type RecordedStep =
  | { type: "goto"; pageUrl: string; timestamp: number; description?: string }
  | {
      type: "click"
      selector: string
      xpath: string
      pageUrl: string
      timestamp: number
      description?: string
    }
  | {
      type: "fill"
      selector: string
      xpath: string
      value: string
      pageUrl: string
      timestamp: number
      description?: string
    }
  | {
      type: "select"
      selector: string
      xpath: string
      value: string
      pageUrl: string
      timestamp: number
      description?: string
    }
  | {
      type: "analyze"
      pageUrl: string
      fullPage: boolean
      timestamp: number
      inquiry?: string
      description?: string
    }

export type Recording = {
  steps: RecordedStep[]
  startedAt: string
  metadata?: { userAgent?: string }
}

// --- Storage export (cookies + localStorage) ---
export type StorageExportCookie = {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: "Lax" | "None" | "Strict"
}

export type StorageExportOrigin = {
  origin: string
  localStorage: { name: string; value: string }[]
}

export type StorageExport = {
  cookies: StorageExportCookie[]
  origins: StorageExportOrigin[]
}

//not in WXT browser for some reason
export interface TabChangeInfo {
  /** Optional. The status of the tab. Can be either loading or complete. */
  status?: string | undefined
  /**
   * The tab's new pinned state.
   * @since Chrome 9
   */
  pinned?: boolean | undefined
  /** Optional. The tab's URL if it has changed. */
  url?: string | undefined
  /**
   * The tab's new audible state.
   * @since Chrome 45
   */
  audible?: boolean | undefined
  /**
   * The tab's new discarded state.
   * @since Chrome 54
   */
  discarded?: boolean | undefined
  /**
   * The tab's new auto-discardable
   * @since Chrome 54
   */
  autoDiscardable?: boolean | undefined
  /**
   * The tab's new group.
   * @since Chrome 88
   */
  groupId?: number | undefined
  /**
   * The tab's new muted state and the reason for the change.
   * @since Chrome 46
   */
  mutedInfo?: Browser.tabs.MutedInfo | undefined
  /**
   * The tab's new favicon URL.
   * @since Chrome 27
   */
  favIconUrl?: string | undefined
  /**
   * The tab's new frozen state.
   * @since Chrome 132
   */
  frozen?: boolean
  /**
   * The tab's new title.
   * @since Chrome 48
   */
  title?: string | undefined
}
