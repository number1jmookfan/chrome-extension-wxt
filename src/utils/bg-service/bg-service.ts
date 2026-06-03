import { initializeApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"

import { RecordedStep } from "../type"
import { initCommChannel } from "./comm"
import {
  captureFullPage,
  captureVisibleScreen,
  getActiveTab,
  sendMessagetoActiveTab,
  sendToBrowserDataAPI,
  sendToCaptureAPI
} from "./utils"

export class BackgroundServices {
  private SETUP_SESSION_URL = import.meta.env.WXT_PUBLIC_SETUP_SESSION_URL
  private sessionInitialized = false
  private globalSessionId = "no-session-id"
  private globalSendCommMsg: ((data: CommDocMessage) => void) | null = null

  // Document detection state
  private pendingDocConfirmations = new Map<
    string,
    { url: string; filename: string; downloadId?: number; blob?: Blob }
  >()
  private docUploadCount = 0

  private alreadyDetectedDocs = new Set<String>()

  private recordingActive = true
  private recordingTabId: number | null = null
  private recordedSteps: RecordedStep[] = []
  private recordingStartedAt = ""

  constructor() {
    browser.storage.local.get(
      ["sessionId"],
      (result: { sessionId?: string }) => {
        if (result.sessionId) {
          this.globalSessionId = result.sessionId
          this.sessionInitialized = true
          remoteLog("init: sessionId from storage", "info", {
            sessionId: this.globalSessionId
          })
          this.setupCommChannel(this.globalSessionId)
        } else {
          remoteLog("sessionId not found in storage", "info")
        }
      }
    )
  }

  async docConfirm(payload: DocConfirmPayload) {
    try {
      const { url, filename } = payload
      const pending = this.pendingDocConfirmations.get(url)
      const finalFilename = pending?.filename || filename || "document.pdf"

      // Use pre-fetched blob if available, otherwise fetch now
      let blob = pending?.blob
      if (!blob) {
        remoteLog("No pre-fetched blob, fetching now", "info", { url })
        const response = await fetch(url, {
          headers: new Headers({
            "ngrok-skip-browser-warning": "69420"
          }),
          credentials: "include"
        })
        blob = await response.blob()
      }

      await this.sendDocToServer(blob, {
        session_id: this.globalSessionId,
        source_url: url,
        filename: finalFilename
      })

      this.pendingDocConfirmations.delete(url)
      this.docUploadCount++

      // Notify content script of success + update badge
      const activeTab = await getActiveTab()
      if (activeTab?.id) {
        try {
          await browser.tabs.sendMessage(activeTab.id, {
            action: "doc:sent"
          })
          await browser.tabs.sendMessage(activeTab.id, {
            action: "doc:updateBadge",
            payload: { count: this.docUploadCount }
          })
        } catch {
          // Content script may not be available
        }
      }
    } catch (error) {
      const errMessage =
        error instanceof Error ? error.message : "Unknown error"
      remoteLog("doc:confirm failed", "error", {
        error: errMessage
      })
      this.pendingDocConfirmations.delete(payload.url)
      return { ok: false, error: errMessage }
    }
  }

  docCancel(url: string) {
    this.pendingDocConfirmations.delete(url)
    this.alreadyDetectedDocs.delete(url)
    return { ok: true }
  }

  docCaptureComplete() {
    if (this.globalSendCommMsg) {
      this.globalSendCommMsg({ action: "doc_capture_done" })
      return { ok: true }
    }
    return false
  }

  setupSessionInfo(url: string, tabId?: number): string | void {
    if (!this.sessionInitialized && url.startsWith(this.SETUP_SESSION_URL)) {
      const redirectUrl =
        new URL(url).searchParams.get("redirectUrl") || "https://www.google.com"
      const sessionId = new URL(url).searchParams.get("sid") || "no-sessionId"

      const redirectMsg = { action: "redirect", payload: redirectUrl }
      // if (tabId != null) {
      //   browser.tabs.sendMessage(tabId, redirectMsg).catch(() => {
      //     sendMessagetoActiveTab(redirectMsg)
      //   })
      // } else {
      //   sendMessagetoActiveTab(redirectMsg)
      // }
      sendMessagetoActiveTab(redirectMsg)
      this.initSession(sessionId)
      this.setupCommChannel(sessionId)
      this.globalSendCommMsg!({ action: "session_initialized" })
    }
    return this.globalSessionId
  }

  pwdInputFound() {
    this.globalSendCommMsg!({ action: "pwd_input_found" })
  }

  //helper methods
  private async sendDocToServer(docBlob: Blob, metadata: DocUploadApiReq) {
    const DOC_UPLOAD_API_URL = import.meta.env.WXT_PUBLIC_DOC_UPLOAD_API_URL
    if (!DOC_UPLOAD_API_URL) {
      remoteLog("DOC_UPLOAD_API_URL not configured", "warn")
      return { error: "Doc upload URL not configured" }
    }
    try {
      const formData = new FormData()
      formData.append("doc", docBlob, metadata.filename)
      formData.append("session_id", metadata.session_id)
      formData.append("source_url", metadata.source_url)
      formData.append("filename", metadata.filename)

      const resp = await fetch(DOC_UPLOAD_API_URL, {
        headers: new Headers({
          "ngrok-skip-browser-warning": "69420"
        }),
        method: "POST",
        body: formData
      })
      const result = await resp.json()
      remoteLog("Doc sent to server", "info", { filename: metadata.filename })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      remoteLog("sendDocToServer failed", "error", {
        error: message
      })
      return { error: message }
    }
  }

  private setupCommChannel(sessionId: string) {
    remoteLog("init: comm channel setup", "info", { sessionId })
    const app = initializeApp({
      apiKey: import.meta.env.WXT_PUBLIC_FIREBASE_API_KEY,
      projectId: import.meta.env.WXT_PUBLIC_FIREBASE_PROJECT_ID,
      appId: import.meta.env.WXT_PUBLIC_FIREBASE_APP_ID,
      measurementId: import.meta.env.WXT_PUBLIC_FIREBASE_MEASUREMENT_ID
    })
    const db = getFirestore(app)
    const commChannel = initCommChannel(
      db,
      sessionId,
      (doc: CommDocMessage) => {
        if (doc.action === "capture_req") {
          this.analyzeCurrentTab(false)
        }
        if (doc.action === "full_page_capture_req") {
          this.analyzeCurrentTab(true)
        }
      }
    )
    if (commChannel) {
      this.globalSendCommMsg = commChannel.sendCommMsg
    } else {
      throw new Error("failed to initialize comm channel - fatal")
    }
  }

  async analyzeCurrentTab(fullpage: boolean) {
    remoteLog("init: analyzeCurrentTab", "info", { fullpage })
    const startTime = Date.now()

    const activeTab = await getActiveTab()
    const currentTabUrl = activeTab?.url || "unknown"

    if (this.recordingActive) {
      this.recordedSteps.push({
        type: "analyze",
        pageUrl: currentTabUrl,
        fullPage: fullpage,
        timestamp: Date.now()
      })
      const storageExport = await this.getStorageExport()
      await sendToBrowserDataAPI({
        session_id: this.globalSessionId,
        rawEvent: JSON.stringify(this.recordedSteps),
        storageExport
      })
    }

    const screenshotDataUrl = fullpage
      ? await captureFullPage(activeTab?.id || null)
      : await captureVisibleScreen()

    await sendToCaptureAPI({
      session_id: this.globalSessionId,
      source_url: currentTabUrl,
      image_data_url: screenshotDataUrl as string
    })

    const endTime = Date.now()
    const durationInSeconds = (endTime - startTime) / 1000
    remoteLog("done: analyzeCurrentTab completed", "info", {
      duration: durationInSeconds
    })
  }

  private initSession(sessionId: string) {
    this.globalSessionId = sessionId
    this.sessionInitialized = true
    browser.storage.local.set({ sessionId: this.globalSessionId })
    remoteLog("init: sessionId initialized from content.ts", "info", {
      sessionId: this.globalSessionId
    })
  }

  //recorder
  async recorderEvent(payload: RecorderEvent): Promise<boolean> {
    const { kind, selector, xpath, url, value, description } = payload
    remoteLog("recorder:event, " + kind, "info")
    if (this.recordingActive) {
      const base = {
        selector,
        xpath,
        pageUrl: url,
        timestamp: Date.now(),
        description
      }
      if (kind === "click") {
        this.recordedSteps.push({ type: "click", ...base })
        return true
      } else if (kind === "fill") {
        this.recordedSteps.push({ type: "fill", ...base, value })
        return true
      } else if (kind === "select") {
        this.recordedSteps.push({ type: "select", ...base, value })
        return true
      }
    }
    return false
  }

  public async getStorageExport(): Promise<StorageExport> {
    const cookies = await new Promise<Browser.cookies.Cookie[]>((resolve) =>
      browser.cookies.getAll({}, resolve)
    )
    const exportCookies: StorageExportCookie[] = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expirationDate ?? -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: (() => {
        const s = c.sameSite
        if (s === "no_restriction") return "None"
        if (s === "lax") return "Lax"
        if (s === "strict") return "Strict"
        return "Lax"
      })() as StorageExportCookie["sameSite"]
    }))

    let origins: StorageExportOrigin[] = []
    const activeTab = await getActiveTab()
    if (activeTab?.id && activeTab.url?.startsWith("http")) {
      try {
        const resp = await browser.tabs.sendMessage(activeTab.id, {
          action: "storage:getLocalStorage"
        })
        origins = resp?.origins ?? []
      } catch {
        // Content script may not be loaded (e.g. chrome://, extension pages)
      }
    }

    return { cookies: exportCookies, origins }
  }

  //getters and setters
  getSetupUrl(): string {
    return this.SETUP_SESSION_URL
  }

  getSessionInitialized(): boolean {
    return this.sessionInitialized
  }
  setSessionInitialized(initialized: boolean): void {
    this.sessionInitialized = initialized
  }

  getGlobalSessionId(): string {
    return this.globalSessionId
  }
  setGlobalSessionId(id: string) {
    this.globalSessionId = id
  }

  // Getter: retrieve a single entry
  getPendingDocConfirmation(key: string): DocConfirmation | undefined {
    return this.pendingDocConfirmations.get(key)
  }
  // Getter: retrieve all entries
  getAllPendingDocConfirmations(): IterableIterator<[string, DocConfirmation]> {
    return this.pendingDocConfirmations.entries()
  }
  // Setter: add or update an entry
  setPendingDocConfirmation(key: string, value: DocConfirmation): void {
    this.pendingDocConfirmations.set(key, value)
  }
  // Setter: partially update an existing entry
  updatePendingDocConfirmation(
    key: string,
    partial: Partial<DocConfirmation>
  ): void {
    const existing = this.pendingDocConfirmations.get(key)
    if (existing) {
      this.pendingDocConfirmations.set(key, { ...existing, ...partial })
    }
  }
  // Deleter: remove an entry
  deletePendingDocConfirmation(key: string): boolean {
    return this.pendingDocConfirmations.delete(key)
  }
  // Utility: check if an entry exists
  hasPendingDocConfirmation(key: string): boolean {
    return this.pendingDocConfirmations.has(key)
  }
  pendingDocConfirmationSize(): number {
    return this.pendingDocConfirmations.size
  }

  getDocUploadCount(): number {
    return this.docUploadCount
  }
  incrementDocUploadCount(): number {
    return this.docUploadCount++
  }
  resetDocUploadCount(): number {
    this.docUploadCount = 0
    return this.docUploadCount
  }

  // Getter: check if a doc has already been detected
  hasAlreadyDetectedDoc(value: string): boolean {
    return this.alreadyDetectedDocs.has(value)
  }
  // Setter: add a detected doc
  addAlreadyDetectedDoc(value: string): void {
    this.alreadyDetectedDocs.add(value)
  }
  // Setter: add multiple detected docs at once
  addManyAlreadyDetectedDocs(values: string[]): void {
    values.forEach((value) => this.alreadyDetectedDocs.add(value))
  }
  // Deleter: remove a detected doc
  deleteAlreadyDetectedDoc(value: string): boolean {
    return this.alreadyDetectedDocs.delete(value)
  }
  // Utility: clear all detected docs
  clearAlreadyDetectedDocs(): void {
    this.alreadyDetectedDocs.clear()
  }
  // Utility: get the count of detected docs
  countAlreadyDetectedDocs(): number {
    return this.alreadyDetectedDocs.size
  }

  getRecordingActive(): boolean {
    return this.recordingActive
  }
  setRecordingActive(value: boolean) {
    this.recordingActive = value
  }
  getRecordingTabId(): number | null {
    return this.recordingTabId
  }
  setRecordingTabId(value: number | null) {
    this.recordingTabId = value
  }
  pushRecordedStep(step: RecordedStep): void {
    this.recordedSteps.push(step)
  }
  popRecordedStep(): RecordedStep | undefined {
    return this.recordedSteps.pop()
  }
  recordedStepsCount(): number {
    return this.recordedSteps.length
  }
  resetRecordedSteps(): void {
    this.recordedSteps = []
  }
  getAllRecordedSteps(): RecordedStep[] {
    return structuredClone(this.recordedSteps)
  }
  getRecordingStartTime(): string {
    return this.recordingStartedAt
  }
  setRecordingStartTime(value: string) {
    this.recordingStartedAt = value
  }
}
