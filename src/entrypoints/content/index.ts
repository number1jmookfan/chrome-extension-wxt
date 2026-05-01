import { injectKioskPageOverrides } from "./kiosk"
import { startRecording, stopRecording } from "./recorder"

import "@/assets/tailwind.css"

// Extend Window interface to include our custom property
declare global {
  interface Window {
    screenshotExtensionInjected?: boolean
  }
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main(ctx) {
    remoteLog("content script init", "info")
    injectKioskPageOverrides()
    let foundPasswordInputs = false

    // Use MutationObserver to detect dynamically added password fields
    const observer = new MutationObserver(findPasswordInputs)
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        observer.observe(document.body, { childList: true, subtree: true })
      },
      { once: true }
    )

    function findPasswordInputs() {
      if (foundPasswordInputs) return

      const passwordInputs = document.querySelectorAll('input[type="password"]')
      if (passwordInputs.length > 0) {
        foundPasswordInputs = true
        browser.runtime.sendMessage("content_script:pwd_input_found")
      }
    }

    function setupSessionInfo() {
      browser.runtime.sendMessage(
        "content_script:setupSessionInfo()",
        (response) => {
          remoteLog(
            "content_script:setupSessionInfo() called. service_worker response with:",
            "info",
            response
          )

          if (browser.runtime.lastError) {
            remoteLog(
              "received chrome.runtime.lastError:",
              "error",
              browser.runtime.lastError as Record<string, unknown>
            )
          } else if (response.error) {
            remoteLog("received response.error:", "error", {
              error: response.error?.message
            })
          }
        }
      )
    }

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      remoteLog("received redirection message", "info")
      if (message.action === "redirect") {
        window.location.href = message.payload
      }
    })

    setTimeout(setupSessionInfo, 500)

    if (!window.screenshotExtensionInjected) {
      window.screenshotExtensionInjected = true

      let hiddenElements: HTMLElement[] = []
      let originalStyles = new Map()

      browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "waitForPageLoad") {
          const waitAndRespond = () => {
            setTimeout(() => {
              sendResponse({ loaded: true })
            }, 1000)
          }

          if (document.readyState === "complete") {
            waitAndRespond()
          } else {
            window.addEventListener("load", waitAndRespond)
          }
          return true
        }

        if (request.action === "hideFixedElements") {
          hiddenElements = []
          originalStyles.clear()

          const selectors = [
            '*[style*="position: fixed"]',
            '*[style*="position:fixed"]',
            '*[style*="position: sticky"]',
            '*[style*="position:sticky"]'
          ]

          const allElements = document.querySelectorAll("*")
          allElements.forEach((el) => {
            const computed = window.getComputedStyle(el)
            if (
              computed.position === "fixed" ||
              computed.position === "sticky"
            ) {
              const htmlEl = el as HTMLElement
              originalStyles.set(htmlEl, htmlEl.style.visibility)
              htmlEl.style.visibility = "hidden"
              hiddenElements.push(htmlEl)
            }
          })

          sendResponse({ hidden: hiddenElements.length })
          return false
        }

        if (request.action === "restoreFixedElements") {
          hiddenElements.forEach((el) => {
            const original = originalStyles.get(el)
            if (original !== undefined) {
              el.style.visibility = original
            } else {
              el.style.removeProperty("visibility")
            }
          })
          hiddenElements = []
          originalStyles.clear()
          sendResponse({ restored: true })
          return false
        }

        if (request.action === "getPageDimensions") {
          const body = document.body
          const html = document.documentElement

          const pageHeight = Math.max(
            body.scrollHeight,
            body.offsetHeight,
            html.clientHeight,
            html.scrollHeight,
            html.offsetHeight
          )

          const pageWidth = Math.max(
            body.scrollWidth,
            body.offsetWidth,
            html.clientWidth,
            html.scrollWidth,
            html.offsetWidth
          )

          sendResponse({
            pageHeight: pageHeight,
            pageWidth: pageWidth,
            viewportHeight: window.innerHeight,
            viewportWidth: window.innerWidth
          })
          return false
        }

        if (request.action === "scrollTo") {
          window.scrollTo(0, request.position)
          sendResponse({ success: true })
          return false
        }

        if (request.action === "recorder:start") {
          startRecording()
          sendResponse({ ok: true })
          return false
        }

        if (request.action === "recorder:stop") {
          stopRecording()
          sendResponse({ ok: true })
          return false
        }

        if (request.action === "doc:showConfirmation") {
          showDocConfirmationModal(
            request.payload.filename,
            request.payload.url
          )
          sendResponse({ ok: true })
          return false
        }

        if (request.action === "doc:sent") {
          updateDocModalToSuccess()
          sendResponse({ ok: true })
          return false
        }

        if (request.action === "doc:updateFilename") {
          updateDocModalFilename(request.payload.filename)
          sendResponse({ ok: true })
          return false
        }

        if (request.action === "doc:updateBadge") {
          showPersistentDocBadge(request.payload?.count ?? 1)
          sendResponse({ ok: true })
          return false
        }

        if (request.action === "storage:getLocalStorage") {
          const items: { name: string; value: string }[] = []
          try {
            for (let i = 0; i < window.localStorage.length; i++) {
              const name = window.localStorage.key(i)
              if (name) {
                items.push({
                  name,
                  value: window.localStorage.getItem(name) ?? ""
                })
              }
            }
          } catch {
            // localStorage may be inaccessible (e.g. in private/incognito)
          }
          sendResponse({
            origins: [{ origin: window.location.origin, localStorage: items }]
          })
          return false
        }
      })
    }

    // --- Document Confirmation Modal ---

    const MODAL_ID = "__inklink_doc_modal__"
    const FONT_ID = "__inklink_font__"

    const SVG_DOC_ICON = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2Z" fill="#E8EDF3" stroke="#64748B" stroke-width="1.2"/><path d="M14 2V8H20" fill="#CBD5E1" stroke="#64748B" stroke-width="1.2" stroke-linejoin="round"/><rect x="7" y="13" width="10" height="2" rx="0.5" fill="#94A3B8"/><rect x="7" y="17" width="6" height="2" rx="0.5" fill="#94A3B8"/></svg>`

    const SVG_CHECK_ICON = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#ECFDF5" stroke="#16A34A" stroke-width="1.5"/><path d="M8 12.5L10.5 15L16 9.5" stroke="#16A34A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

    const SVG_UPLOAD_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 8L12 3L7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 3V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

    const SVG_SPINNER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="animation:__inklink_spin__ 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" opacity="0.25"/><path d="M12 2C6.5 2 2 6.5 2 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`

    function injectFont() {
      if (document.getElementById(FONT_ID)) return
      const link = document.createElement("link")
      link.id = FONT_ID
      link.rel = "stylesheet"
      link.href =
        "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap"
      document.head.appendChild(link)

      const keyframes = document.createElement("style")
      keyframes.textContent =
        "@keyframes __inklink_spin__{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"
      document.head.appendChild(keyframes)
    }

    function updateDocModalFilename(newFilename: string) {
      const label = document.getElementById("__inklink_doc_filename__")
      if (label) {
        // Keep the red dot, replace the text node
        const textNode = Array.from(label.childNodes).find(
          (n) => n.nodeType === Node.TEXT_NODE
        )
        if (textNode) {
          textNode.textContent = newFilename
        }
      }
    }

    function removeDocModal() {
      const existing = document.getElementById(MODAL_ID)
      if (existing) existing.remove()
    }

    // --- Persistent Document Badge ---

    const BADGE_ID = "__inklink_doc_badge__"

    function showPersistentDocBadge(count: number) {
      injectFont()

      let badge = document.getElementById(BADGE_ID) as HTMLElement | null

      if (badge) {
        const countEl = badge.querySelector("[data-inklink-count]")
        if (countEl)
          countEl.textContent = `${count} Document${count !== 1 ? "s" : ""} captured`
        return
      }

      badge = document.createElement("div")
      badge.id = BADGE_ID
      Object.assign(badge.style, {
        position: "fixed",
        bottom: "24px",
        right: "24px",
        zIndex: "2147483646",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        background: "#ffffff",
        borderRadius: "12px",
        padding: "12px 16px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.05)",
        fontFamily: "'Outfit', sans-serif",
        fontSize: "13px",
        fontWeight: "500",
        color: "#0f172a",
        transition: "opacity 0.2s ease"
      })

      const dot = document.createElement("span")
      Object.assign(dot.style, {
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: "#16a34a",
        flexShrink: "0",
        display: "inline-block"
      })

      const label = document.createElement("span")
      label.setAttribute("data-inklink-count", "")
      label.textContent = `${count} Document${count !== 1 ? "s" : ""} captured`

      const doneBtn = document.createElement("button")
      Object.assign(doneBtn.style, {
        padding: "6px 14px",
        borderRadius: "8px",
        fontSize: "12px",
        fontWeight: "600",
        fontFamily: "'Outfit', sans-serif",
        cursor: "pointer",
        border: "none",
        background: "#dc2626",
        color: "#ffffff",
        transition: "background 0.15s ease"
      })
      doneBtn.textContent = "Done Capturing"
      doneBtn.onmouseenter = () => (doneBtn.style.background = "#b91c1c")
      doneBtn.onmouseleave = () => (doneBtn.style.background = "#dc2626")
      doneBtn.onclick = () => {
        browser.runtime.sendMessage({ action: "doc:captureComplete" })
        badge?.remove()
      }

      badge.appendChild(dot)
      badge.appendChild(label)
      badge.appendChild(doneBtn)
      document.body.appendChild(badge)
    }

    function showDocConfirmationModal(filename: string, url: string) {
      removeDocModal()
      injectFont()

      const backdrop = document.createElement("div")
      backdrop.id = MODAL_ID
      Object.assign(backdrop.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        background: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        zIndex: "2147483647",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Outfit', sans-serif"
      })

      const card = document.createElement("div")
      Object.assign(card.style, {
        background: "#ffffff",
        borderRadius: "16px",
        padding: "32px",
        maxWidth: "400px",
        width: "90%",
        boxShadow:
          "0 25px 50px -12px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.05)",
        textAlign: "center"
      })

      const iconWrap = document.createElement("div")
      Object.assign(iconWrap.style, {
        marginBottom: "20px",
        display: "flex",
        justifyContent: "center"
      })
      iconWrap.innerHTML = SVG_DOC_ICON

      const title = document.createElement("div")
      Object.assign(title.style, {
        fontSize: "17px",
        fontWeight: "600",
        color: "#0f172a",
        marginBottom: "4px",
        letterSpacing: "-0.01em"
      })
      title.textContent = "Document Detected"

      const subtitle = document.createElement("div")
      Object.assign(subtitle.style, {
        fontSize: "13px",
        fontWeight: "400",
        color: "#94a3b8",
        marginBottom: "16px",
        letterSpacing: "0.01em",
        textTransform: "uppercase" as const
      })
      subtitle.textContent = "InkLink"

      const fileLabel = document.createElement("div")
      fileLabel.id = "__inklink_doc_filename__"
      Object.assign(fileLabel.style, {
        fontSize: "13px",
        color: "#475569",
        marginBottom: "24px",
        wordBreak: "break-all",
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        padding: "10px 14px",
        borderRadius: "8px",
        fontFamily: "'Outfit', monospace",
        fontWeight: "500",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: "8px"
      })
      const fileDot = document.createElement("span")
      Object.assign(fileDot.style, {
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: "#ef4444",
        flexShrink: "0",
        display: "inline-block"
      })
      fileLabel.appendChild(fileDot)
      fileLabel.appendChild(document.createTextNode(filename))

      const question = document.createElement("div")
      Object.assign(question.style, {
        fontSize: "14px",
        color: "#64748b",
        marginBottom: "24px",
        fontWeight: "400",
        lineHeight: "1.5"
      })
      question.textContent =
        "Would you like to send this document for evaluation?"

      const btnRow = document.createElement("div")
      Object.assign(btnRow.style, {
        display: "flex",
        gap: "10px"
      })

      const yesBtn = document.createElement("button")
      Object.assign(yesBtn.style, {
        flex: "1",
        padding: "11px 20px",
        borderRadius: "10px",
        fontSize: "13px",
        fontWeight: "600",
        fontFamily: "'Outfit', sans-serif",
        cursor: "pointer",
        border: "none",
        background: "#dc2626",
        color: "#ffffff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        transition: "all 0.15s ease"
      })
      yesBtn.innerHTML = `${SVG_UPLOAD_ICON} Send`
      yesBtn.onmouseenter = () => (yesBtn.style.background = "#b91c1c")
      yesBtn.onmouseleave = () => (yesBtn.style.background = "#dc2626")
      yesBtn.onclick = () => {
        yesBtn.disabled = true
        noBtn.disabled = true
        yesBtn.innerHTML = `${SVG_SPINNER} Sending`
        yesBtn.style.opacity = "0.7"
        yesBtn.style.cursor = "default"
        noBtn.style.opacity = "0.4"
        noBtn.style.cursor = "default"
        browser.runtime.sendMessage({
          action: "doc:confirm",
          payload: { url, filename }
        })
      }

      const noBtn = document.createElement("button")
      Object.assign(noBtn.style, {
        flex: "1",
        padding: "11px 20px",
        borderRadius: "10px",
        fontSize: "13px",
        fontWeight: "600",
        fontFamily: "'Outfit', sans-serif",
        cursor: "pointer",
        border: "1px solid #e2e8f0",
        background: "#ffffff",
        color: "#64748b",
        transition: "all 0.15s ease"
      })
      noBtn.textContent = "Skip"
      noBtn.onmouseenter = () => (noBtn.style.background = "#f8fafc")
      noBtn.onmouseleave = () => (noBtn.style.background = "#ffffff")
      noBtn.onclick = () => {
        browser.runtime.sendMessage({
          action: "doc:cancel",
          payload: { url }
        })
        removeDocModal()
      }

      btnRow.appendChild(yesBtn)
      btnRow.appendChild(noBtn)
      card.appendChild(iconWrap)
      card.appendChild(title)
      card.appendChild(subtitle)
      card.appendChild(fileLabel)
      card.appendChild(question)
      card.appendChild(btnRow)
      backdrop.appendChild(card)
      document.body.appendChild(backdrop)
    }

    function updateDocModalToSuccess() {
      const backdrop = document.getElementById(MODAL_ID)
      if (!backdrop) return

      const card = backdrop.querySelector("div") as HTMLElement
      if (!card) return

      card.innerHTML = ""
      Object.assign(card.style, {
        background: "#ffffff",
        borderRadius: "16px",
        padding: "36px 32px",
        maxWidth: "400px",
        width: "90%",
        boxShadow:
          "0 25px 50px -12px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.05)",
        textAlign: "center"
      })

      const iconWrap = document.createElement("div")
      Object.assign(iconWrap.style, {
        marginBottom: "16px",
        display: "flex",
        justifyContent: "center"
      })
      iconWrap.innerHTML = SVG_CHECK_ICON

      const msg = document.createElement("div")
      Object.assign(msg.style, {
        fontSize: "15px",
        fontWeight: "600",
        color: "#0f172a",
        marginBottom: "4px"
      })
      msg.textContent = "Sent for evaluation"

      const sub = document.createElement("div")
      Object.assign(sub.style, {
        fontSize: "13px",
        fontWeight: "400",
        color: "#94a3b8"
      })
      sub.textContent = "This document has been submitted successfully."

      card.appendChild(iconWrap)
      card.appendChild(msg)
      card.appendChild(sub)

      setTimeout(removeDocModal, 2000)
    }
  }
})
