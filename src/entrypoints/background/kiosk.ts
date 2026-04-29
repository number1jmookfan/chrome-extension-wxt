import { getActiveTab } from "./utils"

/**
 * Background-script guard that catches new tabs/popups created by any means
 * (middle-click, JS in iframes, etc.) and redirects navigation to the
 * original kiosk tab.
 *
 * Must be called from the background service worker.
 *
 * @param setupSessionUrlPrefix — If set, new tabs/popups that load this URL are kept
 *   and become the kiosk tab instead of being merged away. Avoids breaking session setup.
 */
export function setupKioskBackgroundGuard(setupSessionUrlPrefix?: string) {
  let kioskTabId: number | null = null

  // tabId → windowId (if the tab lives inside a popup window we need to close)
  const pendingTabs = new Map<number, number | undefined>()

  const PENDING_TIMEOUT_MS = 15_000

  function isSessionSetupUrl(url: string | undefined): boolean {
    return (
      typeof setupSessionUrlPrefix === "string" &&
      setupSessionUrlPrefix.length > 0 &&
      !!url &&
      url.startsWith(setupSessionUrlPrefix)
    )
  }

  function adoptKioskTab(tabId: number) {
    kioskTabId = tabId
    console.log("[kiosk] adopted kioskTabId:", tabId)
  }

  getActiveTab().then((tab) => {
    if (tab?.id) {
      kioskTabId = tab.id
      console.log("[kiosk] seeded kioskTabId:", kioskTabId)
    }
  })

  async function findTargetTab(excludeTabId: number): Promise<number | null> {
    if (kioskTabId && kioskTabId !== excludeTabId) return kioskTabId
    const allTabs = await browser.tabs.query({})
    const other = allTabs.find(
      (t) => t.id !== excludeTabId && t.url?.startsWith("http")
    )
    return other?.id ?? null
  }

  async function redirectAndClose(
    tabId: number,
    url: string,
    windowId?: number
  ) {
    const targetTabId = await findTargetTab(tabId)
    if (!targetTabId) {
      console.warn("[kiosk] no target tab found, cannot redirect", url)
      return
    }

    // Close the popup window (which also closes its tab) or just the tab
    try {
      if (windowId) await browser.windows.remove(windowId)
      else await browser.tabs.remove(tabId)
    } catch {
      /* already gone */
    }

    try {
      await browser.tabs.update(targetTabId, { url, active: true })
      kioskTabId = targetTabId
      console.log("[kiosk] redirected to", url, "in tab", targetTabId)
    } catch (error) {
      console.error("[kiosk] tabs.update failed", error)
      const message = error instanceof Error ? error.message : "Unknown error"
      remoteLog("kiosk: failed to redirect tab", "error", {
        error: message
      })
    }
  }

  function isUsableUrl(url: string | undefined): url is string {
    return (
      !!url && url !== "" && url !== "about:blank" && url !== "chrome://newtab/"
    )
  }

  function trackPending(tabId: number, windowId?: number) {
    pendingTabs.set(tabId, windowId)
    // Safety net: clean up if the URL never materialises
    setTimeout(async () => {
      if (!pendingTabs.has(tabId)) return
      const wid = pendingTabs.get(tabId)
      pendingTabs.delete(tabId)
      console.log("[kiosk] pending timeout, closing tab", tabId)
      try {
        if (wid) await browser.windows.remove(wid)
        else await browser.tabs.remove(tabId)
      } catch {
        /* already gone */
      }
    }, PENDING_TIMEOUT_MS)
  }

  // --- listeners ---

  browser.tabs.onCreated.addListener((newTab) => {
    if (!newTab.id) return
    const url = newTab.pendingUrl || newTab.url
    console.log("[kiosk] tabs.onCreated", { id: newTab.id, url, kioskTabId })

    if (isUsableUrl(url)) {
      if (isSessionSetupUrl(url)) {
        adoptKioskTab(newTab.id)
        return
      }
      redirectAndClose(newTab.id, url)
    } else {
      // URL not yet known (empty or about:blank).
      // Keep the tab alive so a form POST / JS navigation can target it.
      trackPending(newTab.id)
    }
  })

  // When Chrome finally assigns a real URL to a pending tab, redirect.
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!pendingTabs.has(tabId)) return

    const url = changeInfo.url || tab.pendingUrl || tab.url
    console.log("[kiosk] tabs.onUpdated (pending)", { tabId, url })

    if (isUsableUrl(url)) {
      if (isSessionSetupUrl(url)) {
        pendingTabs.delete(tabId)
        adoptKioskTab(tabId)
        return
      }
      const windowId = pendingTabs.get(tabId)
      pendingTabs.delete(tabId)
      redirectAndClose(tabId, url, windowId)
    }
  })

  browser.tabs.onRemoved.addListener((tabId) => {
    pendingTabs.delete(tabId)
  })

  // For popup windows: associate the window ID with the pending tab
  // so we can close the whole window later. Do NOT close immediately —
  // the page may still need to POST a form into this popup.
  browser.windows.onCreated.addListener(async (newWindow) => {
    if (newWindow.type !== "popup" && newWindow.type !== "normal") return

    const newWinTabs = await browser.tabs.query({ windowId: newWindow.id })
    const firstTab = newWinTabs[0]
    if (!firstTab?.id) return

    const url = firstTab.pendingUrl || firstTab.url
    console.log("[kiosk] windows.onCreated", {
      windowId: newWindow.id,
      type: newWindow.type,
      tabId: firstTab.id,
      url,
      kioskTabId
    })

    if (isUsableUrl(url)) {
      if (isSessionSetupUrl(url)) {
        adoptKioskTab(firstTab.id)
        return
      }
      redirectAndClose(firstTab.id, url, newWindow.id)
    } else {
      // Keep the popup alive; tag the tab with its window ID
      // so onUpdated can close the whole window when the URL arrives.
      trackPending(firstTab.id, newWindow.id)
    }
  })

  console.log("[kiosk] background guard initialized")
}
