import "@/assets/tailwind.css"

import { injectKioskPageOverrides } from "./kiosk"
import { startRecording, stopRecording } from "./recorder"

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
          remoteLog("SHOWING DOC CONFIRMATION MODAL")
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

    const SVG_SPINNER = `<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" opacity="0.25"/><path d="M12 2C6.5 2 2 6.5 2 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`

    function injectFont() {
      if (document.getElementById(FONT_ID)) return
      const link = document.createElement("link")
      link.id = FONT_ID
      link.rel = "stylesheet"
      link.href =
        "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap"
      document.head.appendChild(link)
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
      badge.className =
        "fixed bottom-6 right-6 z-[2147483646] flex items-center gap-3 rounded-xl border border-black/5 bg-white px-4 py-3 font-['Outfit',sans-serif] text-[13px] font-medium text-slate-900 shadow-[0_4px_24px_rgba(0,0,0,0.12)] transition-opacity duration-200 ease-out"

      const dot = document.createElement("span")
      dot.className = "inline-block size-2 shrink-0 rounded-full bg-green-600"

      const label = document.createElement("span")
      label.setAttribute("data-inklink-count", "")
      label.textContent = `${count} Document${count !== 1 ? "s" : ""} captured`

      const doneBtn = document.createElement("button")
      doneBtn.className =
        "cursor-pointer rounded-lg border-0 bg-red-600 px-3.5 py-1.5 font-['Outfit',sans-serif] text-xs font-semibold text-white transition-colors duration-150 hover:bg-red-700"
      doneBtn.textContent = "Done Capturing"
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
      backdrop.className =
        "fixed inset-0 z-[2147483647] flex items-center justify-center bg-slate-900/45 font-['Outfit',sans-serif] backdrop-blur-sm"

      const card = document.createElement("div")
      card.className =
        "w-[90%] max-w-[400px] rounded-2xl border border-black/5 bg-white p-8 text-center shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25),0_0_0_1px_rgba(0,0,0,0.05)]"

      const iconWrap = document.createElement("div")
      iconWrap.className = "mb-5 flex justify-center"
      iconWrap.innerHTML = SVG_DOC_ICON

      const title = document.createElement("div")
      title.className =
        "mb-1 text-[17px] font-semibold tracking-tight text-slate-900"
      title.textContent = "Document Detected"

      const subtitle = document.createElement("div")
      subtitle.className =
        "mb-4 text-[13px] font-normal uppercase tracking-wide text-slate-400"
      subtitle.textContent = "InkLink"

      const fileLabel = document.createElement("div")
      fileLabel.id = "__inklink_doc_filename__"
      fileLabel.className =
        "mb-6 flex items-center gap-2 break-all rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-left font-['Outfit',monospace] text-[13px] font-medium text-slate-600"
      const fileDot = document.createElement("span")
      fileDot.className = "inline-block size-2 shrink-0 rounded-full bg-red-500"
      fileLabel.appendChild(fileDot)
      fileLabel.appendChild(document.createTextNode(filename))

      const question = document.createElement("div")
      question.className =
        "mb-6 text-sm font-normal leading-normal text-slate-500"
      question.textContent =
        "Would you like to send this document for evaluation?"

      const btnRow = document.createElement("div")
      btnRow.className = "flex gap-2.5"

      const yesBtn = document.createElement("button")
      yesBtn.className =
        "flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-[10px] border-0 bg-red-600 px-5 py-[11px] font-['Outfit',sans-serif] text-[13px] font-semibold text-white transition-all duration-150 hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-70"
      yesBtn.innerHTML = `${SVG_UPLOAD_ICON} Send`

      const noBtn = document.createElement("button")
      noBtn.className =
        "flex-1 cursor-pointer rounded-[10px] border border-slate-200 bg-white px-5 py-[11px] font-['Outfit',sans-serif] text-[13px] font-semibold text-slate-500 transition-all duration-150 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
      noBtn.textContent = "Skip"

      yesBtn.onclick = () => {
        yesBtn.disabled = true
        noBtn.disabled = true
        yesBtn.innerHTML = `${SVG_SPINNER} Sending`
        browser.runtime.sendMessage({
          action: "doc:confirm",
          payload: { url, filename }
        })
      }

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
      card.className =
        "w-[90%] max-w-[400px] rounded-2xl border border-black/5 bg-white px-8 py-9 text-center shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25),0_0_0_1px_rgba(0,0,0,0.05)]"

      const iconWrap = document.createElement("div")
      iconWrap.className = "mb-4 flex justify-center"
      iconWrap.innerHTML = SVG_CHECK_ICON

      const msg = document.createElement("div")
      msg.className = "mb-1 text-[15px] font-semibold text-slate-900"
      msg.textContent = "Sent for evaluation"

      const sub = document.createElement("div")
      sub.className = "text-[13px] font-normal text-slate-400"
      sub.textContent = "This document has been submitted successfully."

      card.appendChild(iconWrap)
      card.appendChild(msg)
      card.appendChild(sub)

      setTimeout(removeDocModal, 2000)
    }
  }
})
