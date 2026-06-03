const PAGE_VISIT_API_URL = import.meta.env.WXT_PUBLIC_PAGE_VISIT_API_URL
const CAPTURE_API_URL = import.meta.env.WXT_PUBLIC_CAPTURE_API_URL
const DOC_UPLOAD_API_URL = import.meta.env.WXT_PUBLIC_DOC_UPLOAD_API_URL

export async function getActiveTabUrl(): Promise<string> {
  const activeTab = await getActiveTab()
  return activeTab?.url ? activeTab.url : "unknown"
}

export async function sendMessagetoActiveTab(message: unknown) {
  remoteLog("sendMessagetoActiveTab", "info", { message })
  const activeTab = await getActiveTab()
  if (activeTab?.id) {
    try {
      remoteLog("active tab id: " + activeTab.id + " , Message: " + message)
      await browser.tabs.sendMessage(activeTab.id, message)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      remoteLog("Error sending message to active tab", "error", {
        error: message
      })
    }
  } else {
    remoteLog("No active tabs found", "warn")
  }
}

export async function getActiveTab(): Promise<Browser.tabs.Tab | null> {
  const activeTabs = await browser.tabs.query({
    active: true,
    currentWindow: true
  })
  if (activeTabs.length > 0) {
    const sortedTabs = activeTabs.sort(
      (a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
    )
    return sortedTabs[0]
  }
  return null
}

export async function sendToPageVisitAPI(data: PageVisitApiReq) {
  if (!data) {
    return { error: "No browse data provided" }
  }
  try {
    await fetch(PAGE_VISIT_API_URL, {
      headers: new Headers({
        "ngrok-skip-browser-warning": "69420"
      }),
      method: "POST",
      body: JSON.stringify(data)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    remoteLog("sendToPageVisitAPI failed", "error", {
      error: message
    })
  }
}

export async function captureVisibleScreen() {
  const screenshotDataUrl = await browser.tabs.captureVisibleTab({
    format: "png",
    quality: 80
  })
  return screenshotDataUrl
}

export async function sendToCaptureAPI({
  session_id,
  source_url,
  image_data_url
}: CaptureApiReq) {
  if (!image_data_url) {
    return { error: "No screenshot payload provided" }
  }

  try {
    const req: CaptureApiReq = {
      session_id,
      source_url,
      image_data_url
    }

    // TODO check 404 response
    await fetch(CAPTURE_API_URL, {
      headers: new Headers({
        "ngrok-skip-browser-warning": "69420"
      }),
      method: "POST",
      body: JSON.stringify(req)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    remoteLog(`error in ${CAPTURE_API_URL}`, "error", {
      error: message
    })
  }
}

// ======
export async function captureFullPage(tabId: number | null) {
  try {
    if (!tabId) {
      throw new Error("tabId is null")
    }
    await browser.tabs.sendMessage(tabId, { action: "waitForPageLoad" })

    await browser.tabs.sendMessage(tabId, { action: "hideFixedElements" })

    const dimensions = await browser.tabs.sendMessage(tabId, {
      action: "getPageDimensions"
    })

    const screenshots = []
    const viewportHeight = dimensions.viewportHeight
    const pageHeight = dimensions.pageHeight
    const pageWidth = dimensions.pageWidth
    const dpr = dimensions.devicePixelRatio || 1

    let currentPosition = 0

    while (currentPosition < pageHeight) {
      await browser.tabs.sendMessage(tabId, {
        action: "scrollTo",
        position: currentPosition
      })

      await new Promise((resolve) => setTimeout(resolve, 400))

      const screenshot = await browser.tabs.captureVisibleTab({
        format: "png"
      })
      screenshots.push({
        data: screenshot,
        position: currentPosition,
        height: Math.min(viewportHeight, pageHeight - currentPosition)
      })

      await new Promise((resolve) => setTimeout(resolve, 500))

      currentPosition += viewportHeight
    }

    await browser.tabs.sendMessage(tabId, { action: "scrollTo", position: 0 })

    await browser.tabs.sendMessage(tabId, { action: "restoreFixedElements" })

    const fullCanvas = await stitchScreenshots(
      screenshots,
      pageWidth * dpr,
      pageHeight * dpr,
      dpr
    )

    return fullCanvas
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    remoteLog("Error in captureFullPage", "error", {
      error: message
    })
    try {
      if (!tabId) {
        throw new Error("tabId is null")
      }
      await browser.tabs.sendMessage(tabId, { action: "restoreFixedElements" })
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error"
      remoteLog("error in restoreFixedElements", "error", {
        error: message
      })
    }
    throw error
  }
}

export async function sendDocToServer(
  docBlob: Blob,
  metadata: DocUploadApiReq
) {
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

async function stitchScreenshots(
  screenshots: { data: string; position: number; height: number }[],
  canvasWidth: number,
  canvasHeight: number,
  dpr: number
) {
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight)
  const ctx = canvas.getContext("2d")!

  for (const screenshot of screenshots) {
    const response = await fetch(screenshot.data, {
      headers: new Headers({
        "ngrok-skip-browser-warning": "69420"
      })
    })
    const blob = await response.blob()
    const imageBitmap = await createImageBitmap(blob)

    const destY = screenshot.position * dpr
    const destHeight = screenshot.height * dpr

    ctx.drawImage(imageBitmap, 0, destY, canvasWidth, destHeight)

    imageBitmap.close()
  }

  const blob = await canvas.convertToBlob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export function isDocUrl(url: string): boolean {
  if (!url) return false
  try {
    const pathname = new URL(url).pathname
    return pathname.toLowerCase().endsWith(".pdf")
  } catch {
    return false
  }
}

export function getFilenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const parts = pathname.split("/")
    const raw = parts[parts.length - 1] || "document.pdf"
    return decodeURIComponent(raw)
  } catch {
    return "document.pdf"
  }
}
