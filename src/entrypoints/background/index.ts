import { BackgroundServices } from "@/utils/bg-service/bg-service"
import { BACKGROUND_SERVICE_KEY } from "@/utils/proxy-service-keys"
import { registerService } from "@webext-core/proxy-service"
import { browser, type Browser } from "wxt/browser"

import { setupKioskBackgroundGuard } from "./kiosk"
import {
  getActiveTab,
  getFilenameFromUrl,
  isDocUrl,
  sendMessagetoActiveTab,
  sendToPageVisitAPI
} from "./utils"

// main function
export default defineBackground(() => {
  const bgServices = new BackgroundServices()
  registerService(BACKGROUND_SERVICE_KEY, bgServices)

  function runtimeMessageListener(
    message: any,
    sender: Browser.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ) {
    remoteLog("received content.js/popup.js message: " + message.action)

    //popup
    if (message.action === "recorder:start") {
      startRecording()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message }))
      return true
    }

    //popup
    if (message.action === "recorder:stop") {
      bgServices.setRecordingActive(false)
      bgServices.setRecordingTabId(null)
      browser.storage.local.set({ recorderActive: false })
      sendMessagetoActiveTab({ action: "recorder:stop" })
      sendResponse({ ok: true })
      return false
    }

    //popup
    if (message.action === "recorder:getStatus") {
      browser.storage.local.get(["recorderActive"], (result) => {
        sendResponse({ recording: result.recorderActive === true })
      })
      return true
    }

    //popup
    if (message.action === "recorder:getRecording") {
      const recording: Recording = {
        steps: bgServices.getAllRecordedSteps(),
        startedAt: bgServices.getRecordingStartTime(),
        metadata: {}
      }
      sendResponse(recording)
      return false
    }

    //popup
    if (message.action === "storage:getExport") {
      ;(async () => {
        try {
          const exportData = await bgServices.getStorageExport()
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
  }

  async function tabsOnUpdatedListener(
    tabId: number,
    changeInfo: TabChangeInfo,
    tab: Browser.tabs.Tab
  ) {
    if (changeInfo?.url !== undefined) {
      await sendToPageVisitAPI({
        tab_id: tabId,
        url: changeInfo?.url,
        session_id: bgServices.getGlobalSessionId(),
        visited_at: Date.now()
      })
      if (
        bgServices.getRecordingActive() &&
        tabId === bgServices.getRecordingTabId()
      ) {
        recordGoto(changeInfo.url)
      }
    }
    if (bgServices.getRecordingActive() && changeInfo?.status === "complete") {
      try {
        await browser.tabs.sendMessage(tabId, { action: "recorder:start" })
        if (bgServices.getRecordingTabId() === null) {
          bgServices.setRecordingTabId(tabId)
          recordGoto(tab?.url ?? "", "Start recording")
        }
      } catch {
        // Tab might not have content script (e.g. chrome://)
      }
    }

    // Document detection: when a tab finishes loading
    if (changeInfo?.status === "complete" && tab?.url?.startsWith("http")) {
      if (bgServices.hasAlreadyDetectedDoc(tab.url)) return

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
        bgServices.addAlreadyDetectedDoc(tab.url)
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

        bgServices.setPendingDocConfirmation(tab.url, {
          url: tab.url,
          filename
        })

        // Show modal on the user's active tab, not the document tab
        await showDocModalInAnyTab(tab.url, filename)
      }
    }
  }

  async function injectDocModal(tabId: number, url: string, filename: string) {
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

  function recordGoto(pageUrl: string, description?: string) {
    if (!pageUrl?.startsWith("http")) return
    bgServices.pushRecordedStep({
      type: "goto",
      pageUrl,
      timestamp: Date.now(),
      ...(description && { description })
    })
  }

  function startRecording() {
    bgServices.setRecordingActive(true)
    browser.storage.local.set({ recorderActive: true })
    bgServices.resetRecordedSteps()
    bgServices.resetDocUploadCount()
    bgServices.setRecordingStartTime(new Date().toISOString())
    return getActiveTab()
      .then((tab) => {
        if (tab?.id) bgServices.setRecordingTabId(tab.id)
        recordGoto(tab?.url ?? "", "Start recording")
        return sendMessagetoActiveTab({ action: "recorder:start" })
      })
      .catch((error) => {
        remoteLog("recorder:start failed", "error", { error: error?.message })
      })
  }

  // chrome sets persist = false by default hence we don't need to explicitly remove listeners
  // chrome.action.onClicked.addListener(analyzeCurrentTab)
  browser.tabs.onUpdated.addListener(tabsOnUpdatedListener)
  browser.tabs.onRemoved.addListener((closedTabId) => {
    if (closedTabId === bgServices.getRecordingTabId())
      bgServices.setRecordingTabId(null)
  })
  browser.runtime.onMessage.addListener(runtimeMessageListener)

  // Re-show pending doc modal when the user switches tabs
  browser.tabs.onActivated.addListener(async (activeInfo) => {
    if (bgServices.pendingDocConfirmationSize() === 0) return

    // Get the first pending confirmation (most recent)
    const [url, pending] = [
      ...bgServices.getAllPendingDocConfirmations()
    ].pop()!

    try {
      await browser.tabs.sendMessage(activeInfo.tabId, {
        action: "doc:showConfirmation",
        payload: { url, filename: pending.filename }
      })
    } catch {
      try {
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
    bgServices.setPendingDocConfirmation(docUrl, pending)

    // Fetch the doc blob immediately while the token/session is still valid
    fetch(docUrl, { credentials: "include" })
      .then((resp) => resp.blob())
      .then((blob) => {
        // Only store if still pending (user hasn't cancelled)
        if (bgServices.hasPendingDocConfirmation(docUrl)) {
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
    for (const [url, pending] of [
      ...bgServices.getAllPendingDocConfirmations()
    ]) {
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
    bgServices.deletePendingDocConfirmation(docUrl)
  }

  setupKioskBackgroundGuard(bgServices.getSetupUrl())

  // refer to https://stackoverflow.com/a/66618269
  const keepAlive = () => setInterval(browser.runtime.getPlatformInfo, 20e3)
  browser.runtime.onStartup.addListener(keepAlive)
  keepAlive()

  // Start recording by default when the extension loads
  startRecording()
})
