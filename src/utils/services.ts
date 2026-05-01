export class RecorderService {
  // Recording state for Playwright replay (starts recording by default)
  private recordingActive = true
  private recordedSteps: RecordedStep[] = []

  async recorderEvent(payload: RecorderEventPayload): Promise<boolean> {
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
}

// Come back to this later - too much intertwined with background right now to flesh out the class, but it's definitely possible to bring everything here

// export class DocServices {
//   // Document detection state
//   private pendingDocConfirmations = new Map<
//     string,
//     { url: string; filename: string; downloadId?: number; blob?: Blob }
//   >()
//   private docUploadCount = 0
//   private DOC_UPLOAD_API_URL = import.meta.env.WXT_PUBLIC_DOC_UPLOAD_API_URL

//   async docConfirm(payload: DocConfirmPayload) {
//     try {
//       const { url, filename } = payload
//       const pending = this.pendingDocConfirmations.get(url)
//       const finalFilename = pending?.filename || filename || "document.pdf"

//       // Use pre-fetched blob if available, otherwise fetch now
//       let blob = pending?.blob
//       if (!blob) {
//         remoteLog("No pre-fetched blob, fetching now", "info", { url })
//         const response = await fetch(url, {
//           headers: new Headers({
//             "ngrok-skip-browser-warning": "69420"
//           }),
//           credentials: "include"
//         })
//         blob = await response.blob()
//       }

//       await this.sendDocToServer(blob, {
//         session_id: globalSessionId,
//         source_url: url,
//         filename: finalFilename
//       })

//       this.pendingDocConfirmations.delete(url)
//       this.docUploadCount++

//       // Notify content script of success + update badge
//       const activeTab = await getActiveTab()
//       if (activeTab?.id) {
//         try {
//           await browser.tabs.sendMessage(activeTab.id, {
//             action: "doc:sent"
//           })
//           await browser.tabs.sendMessage(activeTab.id, {
//             action: "doc:updateBadge",
//             payload: { count: docUploadCount }
//           })
//         } catch {
//           // Content script may not be available
//         }
//       }
//     } catch (error) {
//       const errMessage =
//         error instanceof Error ? error.message : "Unknown error"
//       remoteLog("doc:confirm failed", "error", {
//         error: errMessage
//       })
//       pendingDocConfirmations.delete(message.payload?.url)
//       sendResponse({ ok: false, error: errMessage })
//     }
//   }

//   private async sendDocToServer(docBlob: Blob, metadata: DocUploadApiReq) {
//     const DOC_UPLOAD_API_URL = import.meta.env.WXT_PUBLIC_DOC_UPLOAD_API_URL
//     if (!DOC_UPLOAD_API_URL) {
//       remoteLog("DOC_UPLOAD_API_URL not configured", "warn")
//       return { error: "Doc upload URL not configured" }
//     }
//     try {
//       const formData = new FormData()
//       formData.append("doc", docBlob, metadata.filename)
//       formData.append("session_id", metadata.session_id)
//       formData.append("source_url", metadata.source_url)
//       formData.append("filename", metadata.filename)

//       const resp = await fetch(DOC_UPLOAD_API_URL, {
//         headers: new Headers({
//           "ngrok-skip-browser-warning": "69420"
//         }),
//         method: "POST",
//         body: formData
//       })
//       const result = await resp.json()
//       remoteLog("Doc sent to server", "info", { filename: metadata.filename })
//       return result
//     } catch (error) {
//       const message = error instanceof Error ? error.message : "Unknown error"
//       remoteLog("sendDocToServer failed", "error", {
//         error: message
//       })
//       return { error: message }
//     }
//   }
// }
