import { initializeApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"
import { browser, type Browser } from "wxt/browser"

import { initCommChannel } from "./comm"
import { setupKioskBackgroundGuard } from "./kiosk"
import {
  captureFullPage,
  captureVisibleScreen,
  getActiveTab,
  sendDocToServer,
  sendMessagetoActiveTab,
  sendToBrowserDataAPI,
  sendToCaptureAPI,
  sendToPageVisitAPI
} from "./utils"

// main function
export default defineBackground(() => {
  const SETUP_SESSION_URL = import.meta.env.WXT_PUBLIC_SETUP_SESSION_URL
  console.log(SETUP_SESSION_URL)

  let sessionInitialized = false
  let globalSessionId = "no-session-id"
  let globalSendCommMsg: (data: CommDocMessage) => void

  // Recording state for Playwright replay (starts recording by default)
  let recordingActive = true
  let recordingTabId: number | null = null
  let recordedSteps: RecordedStep[] = []
  let recordingStartedAt = ""

  // Document detection state
  const pendingDocConfirmations = new Map<
    string,
    { url: string; filename: string; downloadId?: number; blob?: Blob }
  >()
  let docUploadCount = 0

  browser.storage.local.get(["sessionId"], (result: { sessionId?: string }) => {
    if (result.sessionId) {
      globalSessionId = result.sessionId
      sessionInitialized = true
      remoteLog("init: sessionId from storage", "info", {
        sessionId: globalSessionId
      })
      setupCommChannel(globalSessionId)
    } else {
      remoteLog("sessionId not found in storage", "info")
    }
  })

  const app = initializeApp({
    apiKey: import.meta.env.WXT_PUBLIC_FIREBASE_API_KEY,
    projectId: import.meta.env.WXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: import.meta.env.WXT_PUBLIC_FIREBASE_APP_ID,
    measurementId: import.meta.env.WXT_PUBLIC_FIREBASE_MEASUREMENT_ID
  })
  const db = getFirestore(app)

  function runtimeMessageListener(
    message: any,
    sender: Browser.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ) {
    remoteLog("received content.js/popup.js message: " + message.action)

    if (message.action === "recorder:start") {
      startRecording()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message }))
      return true
    }

    if (message.action === "recorder:stop") {
      recordingActive = false
      recordingTabId = null
      browser.storage.local.set({ recorderActive: false })
      sendMessagetoActiveTab({ action: "recorder:stop" })
      sendResponse({ ok: true })
      return false
    }

    if (message.action === "recorder:getStatus") {
      browser.storage.local.get(["recorderActive"], (result) => {
        sendResponse({ recording: result.recorderActive === true })
      })
      return true
    }

    if (message.action === "recorder:event" && message.payload) {
      const { kind, selector, xpath, url, value, description } = message.payload
      console.log("recorder:event", message.payload)
      if (recordingActive) {
        const base = {
          selector,
          xpath,
          pageUrl: url,
          timestamp: Date.now(),
          description
        }
        if (kind === "click") recordedSteps.push({ type: "click", ...base })
        else if (kind === "fill")
          recordedSteps.push({ type: "fill", ...base, value })
        else if (kind === "select")
          recordedSteps.push({ type: "select", ...base, value })
      }
      sendResponse({ ok: true })
      return false
    }

    if (message.action === "recorder:getRecording") {
      const recording: Recording = {
        steps: [...recordedSteps],
        startedAt: recordingStartedAt,
        metadata: {}
      }
      sendResponse(recording)
      return false
    }

    if (message.action === "storage:getExport") {
      ;(async () => {
        try {
          const exportData = await getStorageExport()
          sendResponse({ ok: true, data: exportData })
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error"
          sendResponse({
            ok: false,
            error: message
          })
        }
      })()
      return true
    }

    if (message.action === "doc:confirm") {
      ;(async () => {
        try {
          const { url, filename } = message.payload
          const pending = pendingDocConfirmations.get(url)
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

          await sendDocToServer(blob, {
            session_id: globalSessionId,
            source_url: url,
            filename: finalFilename
          })

          pendingDocConfirmations.delete(url)
          docUploadCount++

          // Notify content script of success + update badge
          const activeTab = await getActiveTab()
          if (activeTab?.id) {
            try {
              await browser.tabs.sendMessage(activeTab.id, {
                action: "doc:sent"
              })
              await browser.tabs.sendMessage(activeTab.id, {
                action: "doc:updateBadge",
                payload: { count: docUploadCount }
              })
            } catch {
              // Content script may not be available
            }
          }
          sendResponse({ ok: true })
        } catch (error) {
          const errMessage =
            error instanceof Error ? error.message : "Unknown error"
          remoteLog("doc:confirm failed", "error", {
            error: errMessage
          })
          pendingDocConfirmations.delete(message.payload?.url)
          sendResponse({ ok: false, error: errMessage })
        }
      })()
      return true
    }

    if (message.action === "doc:cancel") {
      const { url } = message.payload
      pendingDocConfirmations.delete(url)
      alreadyDetectedDocs.delete(url)
      sendResponse({ ok: true })
      return false
    }

    if (message.action === "doc:captureComplete") {
      globalSendCommMsg({ action: "doc_capture_done" })
      sendResponse({ ok: true })
      return false
    }

    if (message === "content_script:setupSessionInfo()") {
      if (!sessionInitialized && sender.url?.startsWith(SETUP_SESSION_URL)) {
        const redirectUrl =
          new URL(sender.url).searchParams.get("redirectUrl") ||
          "https://www.google.com"
        const sessionId =
          new URL(sender.url).searchParams.get("sid") || "no-sessionId"

        const redirectMsg = { action: "redirect", payload: redirectUrl }
        const setupTabId = sender.tab?.id
        if (setupTabId != null) {
          browser.tabs.sendMessage(setupTabId, redirectMsg).catch(() => {
            sendMessagetoActiveTab(redirectMsg)
          })
        } else {
          sendMessagetoActiveTab(redirectMsg)
        }
        initSession(sessionId)
        setupCommChannel(sessionId)
        globalSendCommMsg({ action: "session_initialized" })
      }
      sendResponse(globalSessionId)
    } else if (message === "content_script:pwd_input_found") {
      globalSendCommMsg({ action: "pwd_input_found" })
    } else if (
      message.action &&
      message.action === "popup:analyzeCurrentTab()"
    ) {
      analyzeCurrentTab(false)
    }
  }

  async function analyzeCurrentTab(fullpage: boolean) {
    remoteLog("init: analyzeCurrentTab", "info", { fullpage })
    const startTime = Date.now()

    const activeTab = await getActiveTab()
    const currentTabUrl = activeTab?.url || "unknown"

    if (recordingActive) {
      recordedSteps.push({
        type: "analyze",
        pageUrl: currentTabUrl,
        fullPage: fullpage,
        timestamp: Date.now()
      })
      const storageExport = await getStorageExport()
      await sendToBrowserDataAPI({
        session_id: globalSessionId,
        rawEvent: JSON.stringify(recordedSteps),
        storageExport
      })
    }

    const screenshotDataUrl = fullpage
      ? await captureFullPage(activeTab?.id || null)
      : await captureVisibleScreen()

    await sendToCaptureAPI({
      session_id: globalSessionId,
      source_url: currentTabUrl,
      image_data_url: screenshotDataUrl as string
    })

    const endTime = Date.now()
    const durationInSeconds = (endTime - startTime) / 1000
    remoteLog("done: analyzeCurrentTab completed", "info", {
      duration: durationInSeconds
    })
  }

  function initSession(sessionId: string) {
    globalSessionId = sessionId
    sessionInitialized = true
    browser.storage.local.set({ sessionId: globalSessionId })
    remoteLog("init: sessionId initialized from content.ts", "info", {
      sessionId: globalSessionId
    })
  }

  function isDocUrl(url: string): boolean {
    if (!url) return false
    try {
      const pathname = new URL(url).pathname
      return pathname.toLowerCase().endsWith(".pdf")
    } catch {
      return false
    }
  }

  function getFilenameFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname
      const parts = pathname.split("/")
      const raw = parts[parts.length - 1] || "document.pdf"
      return decodeURIComponent(raw)
    } catch {
      return "document.pdf"
    }
  }

  const alreadyDetectedDocs = new Set<string>()

  async function tabsOnUpdatedListener(
    tabId: number,
    changeInfo: TabChangeInfo,
    tab: Browser.tabs.Tab
  ) {
    if (changeInfo?.url !== undefined) {
      await sendToPageVisitAPI({
        tab_id: tabId,
        url: changeInfo?.url,
        session_id: globalSessionId,
        visited_at: Date.now()
      })
      if (recordingActive && tabId === recordingTabId) {
        recordGoto(changeInfo.url)
      }
    }
    if (recordingActive && changeInfo?.status === "complete") {
      try {
        await browser.tabs.sendMessage(tabId, { action: "recorder:start" })
        if (recordingTabId === null) {
          recordingTabId = tabId
          recordGoto(tab?.url ?? "", "Start recording")
        }
      } catch {
        // Tab might not have content script (e.g. chrome://)
      }
    }

    // Document detection: when a tab finishes loading
    if (changeInfo?.status === "complete" && tab?.url?.startsWith("http")) {
      if (alreadyDetectedDocs.has(tab.url)) return

      let isDoc = isDocUrl(tab.url)

      // If URL doesn't end in .pdf, check the actual content type
      if (!isDoc) {
        // Try 1: inject script to check document.contentType
        try {
          const [result] = await browser.scripting.executeScript({
            target: { tabId },
            func: () => document.contentType
          })
          isDoc = result?.result === "application/pdf"
        } catch {
          // Can't inject (e.g. Chrome PDF viewer blocks scripts)
        }

        // Try 2: HEAD request to check Content-Type header
        if (!isDoc) {
          try {
            const resp = await fetch(tab.url, {
              headers: new Headers({
                "ngrok-skip-browser-warning": "69420"
              }),
              method: "HEAD",
              credentials: "include"
            })
            const ct = resp.headers.get("content-type") || ""
            isDoc = ct.includes("application/pdf")
          } catch {
            // Fetch failed
          }
        }
      }

      if (isDoc) {
        alreadyDetectedDocs.add(tab.url)
        let filename = isDocUrl(tab.url)
          ? getFilenameFromUrl(tab.url)
          : "document.pdf"

        // Try to get a better filename from Content-Disposition header
        if (filename === "document.pdf") {
          try {
            const resp = await fetch(tab.url, {
              headers: new Headers({
                "ngrok-skip-browser-warning": "69420"
              }),
              method: "HEAD",
              credentials: "include"
            })
            const cd = resp.headers.get("content-disposition") || ""
            const m = cd.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/i)
            if (m) filename = decodeURIComponent(m[1].replace(/"/g, ""))
          } catch {
            // Keep default
          }
        }

        pendingDocConfirmations.set(tab.url, { url: tab.url, filename })

        // Show modal on the user's active tab, not the document tab
        await showDocModalInAnyTab(tab.url, filename)
      }
    }
  }

  async function injectDocModal(tabId: number, url: string, filename: string) {
    remoteLog("INJECTDOCMODAL", "info")
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        func: (docUrl: string, docFilename: string) => {
          const MODAL_ID = "__inklink_doc_modal__"
          if (document.getElementById(MODAL_ID)) return

          // Inject Outfit font
          if (!document.getElementById("__inklink_font__")) {
            const link = document.createElement("link")
            link.id = "__inklink_font__"
            link.rel = "stylesheet"
            link.href =
              "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap"
            document.head.appendChild(link)
            const kf = document.createElement("style")
            kf.textContent =
              "@keyframes __inklink_spin__{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"
            document.head.appendChild(kf)
          }

          const SVG_DOC = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2Z" fill="#E8EDF3" stroke="#64748B" stroke-width="1.2"/><path d="M14 2V8H20" fill="#CBD5E1" stroke="#64748B" stroke-width="1.2" stroke-linejoin="round"/><rect x="7" y="13" width="10" height="2" rx="0.5" fill="#94A3B8"/><rect x="7" y="17" width="6" height="2" rx="0.5" fill="#94A3B8"/></svg>`
          const SVG_UPLOAD = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 8L12 3L7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 3V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
          const SVG_SPINNER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="animation:__inklink_spin__ 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" opacity="0.25"/><path d="M12 2C6.5 2 2 6.5 2 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`
          const SVG_CHECK = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#ECFDF5" stroke="#16A34A" stroke-width="1.5"/><path d="M8 12.5L10.5 15L16 9.5" stroke="#16A34A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

          const backdrop = document.createElement("div")
          backdrop.id = MODAL_ID
          backdrop.style.cssText =
            "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,0.45);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:'Outfit',sans-serif;"

          const card = document.createElement("div")
          card.style.cssText =
            "background:#fff;border-radius:16px;padding:32px;max-width:400px;width:90%;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25),0 0 0 1px rgba(0,0,0,0.05);text-align:center;"

          card.innerHTML = `
          <div style="margin-bottom:20px;display:flex;justify-content:center;">${SVG_DOC}</div>
          <div style="font-size:17px;font-weight:600;color:#0f172a;margin-bottom:4px;letter-spacing:-0.01em;">Document Detected</div>
          <div style="font-size:13px;font-weight:400;color:#94a3b8;margin-bottom:16px;letter-spacing:0.01em;text-transform:uppercase;">InkLink</div>
          <div style="font-size:13px;color:#475569;margin-bottom:24px;word-break:break-all;background:#f8fafc;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;font-family:'Outfit',monospace;font-weight:500;text-align:left;display:flex;align-items:center;gap:8px;"><span style="width:8px;height:8px;border-radius:50%;background:#ef4444;flex-shrink:0;display:inline-block;"></span>${docFilename}</div>
          <div style="font-size:14px;color:#64748b;margin-bottom:24px;font-weight:400;line-height:1.5;">Would you like to send this document for evaluation?</div>
          <div style="display:flex;gap:10px;">
            <button id="__inklink_yes__" style="flex:1;padding:11px 20px;border-radius:10px;font-size:13px;font-weight:600;font-family:'Outfit',sans-serif;cursor:pointer;border:none;background:#dc2626;color:#fff;display:flex;align-items:center;justify-content:center;gap:8px;transition:all 0.15s ease;">${SVG_UPLOAD} Send</button>
            <button id="__inklink_no__" style="flex:1;padding:11px 20px;border-radius:10px;font-size:13px;font-weight:600;font-family:'Outfit',sans-serif;cursor:pointer;border:1px solid #e2e8f0;background:#fff;color:#64748b;transition:all 0.15s ease;">Skip</button>
          </div>`

          backdrop.appendChild(card)
          document.body.appendChild(backdrop)

          document.getElementById("__inklink_yes__")!.onclick = () => {
            const btn = document.getElementById(
              "__inklink_yes__"
            ) as HTMLButtonElement
            const noBtn = document.getElementById(
              "__inklink_no__"
            ) as HTMLButtonElement
            btn.disabled = true
            noBtn.disabled = true
            btn.innerHTML = `${SVG_SPINNER} Sending`
            btn.style.opacity = "0.7"
            btn.style.cursor = "default"
            noBtn.style.opacity = "0.4"
            noBtn.style.cursor = "default"
            browser.runtime.sendMessage({
              action: "doc:confirm",
              payload: { url: docUrl, filename: docFilename }
            })
          }

          document.getElementById("__inklink_no__")!.onclick = () => {
            browser.runtime.sendMessage({
              action: "doc:cancel",
              payload: { url: docUrl }
            })
            document.getElementById(MODAL_ID)?.remove()
          }

          browser.runtime.onMessage.addListener((msg) => {
            if (msg.action === "doc:sent") {
              const c = backdrop.querySelector("div") as HTMLElement
              c.style.cssText =
                "background:#fff;border-radius:16px;padding:36px 32px;max-width:400px;width:90%;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25),0 0 0 1px rgba(0,0,0,0.05);text-align:center;"
              c.innerHTML = `
              <div style="margin-bottom:16px;display:flex;justify-content:center;">${SVG_CHECK}</div>
              <div style="font-size:15px;font-weight:600;color:#0f172a;margin-bottom:4px;">Sent for evaluation</div>
              <div style="font-size:13px;font-weight:400;color:#94a3b8;">This document has been submitted successfully.</div>`
              setTimeout(
                () => document.getElementById(MODAL_ID)?.remove(),
                2000
              )
            }
          })
        },
        args: [url, filename]
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      remoteLog("injectDocModal failed", "error", {
        error: message
      })
    }
  }

  function setupCommChannel(sessionId: string) {
    remoteLog("init: comm channel setup", "info", { sessionId })
    const commChannel = initCommChannel(
      db,
      sessionId,
      (doc: CommDocMessage) => {
        if (doc.action === "capture_req") {
          analyzeCurrentTab(false)
        }
        if (doc.action === "full_page_capture_req") {
          analyzeCurrentTab(true)
        }
      }
    )
    if (commChannel) {
      globalSendCommMsg = commChannel.sendCommMsg
    } else {
      throw new Error("failed to initialize comm channel - fatal")
    }
  }

  function recordGoto(pageUrl: string, description?: string) {
    if (!pageUrl?.startsWith("http")) return
    recordedSteps.push({
      type: "goto",
      pageUrl,
      timestamp: Date.now(),
      ...(description && { description })
    })
  }

  function startRecording() {
    recordingActive = true
    browser.storage.local.set({ recorderActive: true })
    recordedSteps = []
    docUploadCount = 0
    recordingStartedAt = new Date().toISOString()
    return getActiveTab()
      .then((tab) => {
        if (tab?.id) recordingTabId = tab.id
        recordGoto(tab?.url ?? "", "Start recording")
        return sendMessagetoActiveTab({ action: "recorder:start" })
      })
      .catch((error) => {
        remoteLog("recorder:start failed", "error", { error: error?.message })
      })
  }

  async function getStorageExport(): Promise<StorageExport> {
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

  // chrome sets persist = false by default hence we don't need to explicitly remove listeners
  // chrome.action.onClicked.addListener(analyzeCurrentTab)
  browser.tabs.onUpdated.addListener(tabsOnUpdatedListener)
  browser.tabs.onRemoved.addListener((closedTabId) => {
    if (closedTabId === recordingTabId) recordingTabId = null
  })
  browser.runtime.onMessage.addListener(runtimeMessageListener)

  // Re-show pending doc modal when the user switches tabs
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    if (pendingDocConfirmations.size === 0) return

    // Get the first pending confirmation (most recent)
    const [url, pending] = [...pendingDocConfirmations.entries()].pop()!
    remoteLog("ACTIVATING DOC MODAL - BACKGROUND.TS")
    try {
      await browser.tabs.sendMessage(activeInfo.tabId, {
        action: "doc:showConfirmation",
        payload: { url, filename: pending.filename }
      })
    } catch {
      try {
        remoteLog("INJECTING DOC MODAL")
        await injectDocModal(activeInfo.tabId, url, pending.filename)
      } catch {
        // Tab may not support injection (e.g. browser://)
      }
    }
  })

  // Document download detection — never pauses downloads, sends doc independently on confirm
  browser.downloads.onCreated.addListener(async (downloadItem) => {
    const isDoc =
      downloadItem.mime === "application/pdf" ||
      downloadItem.filename?.toLowerCase().endsWith(".pdf") ||
      downloadItem.url?.toLowerCase().includes(".pdf")

    if (!isDoc || !downloadItem.url) return
    if (downloadItem.url.startsWith("blob:")) return

    // Extract filename: prefer the download item's filename, fall back to URL
    const rawFilename = downloadItem.filename
      ? downloadItem.filename.split("/").pop()?.split("\\").pop()
      : null
    const filename =
      rawFilename && rawFilename.length > 0
        ? decodeURIComponent(rawFilename)
        : getFilenameFromUrl(downloadItem.finalUrl || downloadItem.url)

    const docUrl = downloadItem.finalUrl || downloadItem.url

    const pending: {
      url: string
      filename: string
      downloadId?: number
      blob?: Blob
    } = {
      url: docUrl,
      filename,
      downloadId: downloadItem.id
    }
    pendingDocConfirmations.set(docUrl, pending)

    // Fetch the doc blob immediately while the token/session is still valid
    fetch(docUrl, { credentials: "include" })
      .then((resp) => resp.blob())
      .then((blob) => {
        // Only store if still pending (user hasn't cancelled)
        if (pendingDocConfirmations.has(docUrl)) {
          pending.blob = blob
          remoteLog("Doc blob pre-fetched", "info", {
            filename,
            size: blob.size
          })
        }
      })
      .catch((error) => {
        remoteLog("Doc pre-fetch failed (will retry on confirm)", "warn", {
          error: error?.message
        })
      })

    // Don't pause — let the download proceed normally
    // Try to show confirmation modal in any available tab
    await showDocModalInAnyTab(docUrl, filename)
  })

  // Watch for filename changes — downloads often get their real name after creation
  browser.downloads.onChanged.addListener(async (delta) => {
    if (!delta.filename) return
    const newName = delta.filename.current?.split("/").pop()?.split("\\").pop()
    if (!newName) return

    // Update any pending confirmation with the real filename
    for (const [url, pending] of pendingDocConfirmations) {
      if (pending.downloadId === delta.id) {
        const decoded = decodeURIComponent(newName)
        pending.filename = decoded

        // Push the updated filename to the modal live
        const activeTab = await getActiveTab()
        if (activeTab?.id) {
          try {
            await browser.tabs.sendMessage(activeTab.id, {
              action: "doc:updateFilename",
              payload: { url, filename: decoded }
            })
          } catch {
            // Modal may not be showing
          }
        }
      }
    }
  })

  async function showDocModalInAnyTab(docUrl: string, filename: string) {
    // Try active tab first
    const activeTab = await getActiveTab()
    if (activeTab?.id) {
      try {
        await browser.tabs.sendMessage(activeTab.id, {
          action: "doc:showConfirmation",
          payload: { url: docUrl, filename }
        })
        return
      } catch {
        // Content script not available in active tab
      }

      // Try injecting directly
      try {
        await injectDocModal(activeTab.id, docUrl, filename)
        return
      } catch {
        // Injection failed too
      }
    }

    // Last resort: find any tab with an http(s) page
    const tabs = await browser.tabs.query({ currentWindow: true })
    for (const tab of tabs) {
      if (!tab.id || !tab.url?.startsWith("http")) continue
      try {
        await browser.tabs.sendMessage(tab.id, {
          action: "doc:showConfirmation",
          payload: { url: docUrl, filename }
        })
        return
      } catch {
        continue
      }
    }

    remoteLog("Could not show doc modal in any tab", "warn", {
      url: docUrl,
      filename
    })
    pendingDocConfirmations.delete(docUrl)
  }

  setupKioskBackgroundGuard(SETUP_SESSION_URL)

  // refer to https://stackoverflow.com/a/66618269
  const keepAlive = () => setInterval(browser.runtime.getPlatformInfo, 20e3)
  browser.runtime.onStartup.addListener(keepAlive)
  keepAlive()

  // Start recording by default when the extension loads
  startRecording()
})
