//activate recorder service:
// import { createProxyService } from "@webext-core/proxy-service"
// const recorderService = createProxyService(RECORDER_SERVICE_KEY)

/**
 * Records user interactions (click, fill, select) and produces a JSON trace
 * that can be replayed with Playwright.
 */

/** Build a stable CSS selector for an element (Playwright can use this). */
export function getStableSelector(el: Element): string | null {
  if (!el || !el.isConnected) return null

  const doc = el.ownerDocument
  if (!doc || doc !== document) return null

  // Prefer unique id (avoid dynamic ids)
  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
    const byId = doc.querySelectorAll(`#${CSS.escape(el.id)}`)
    if (byId.length === 1) return `#${CSS.escape(el.id)}`
  }

  // Prefer data-testid (common in testable apps)
  const testId = el.getAttribute("data-testid")
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`

  // Prefer name on inputs (unique per form)
  const tag = el.tagName.toLowerCase()
  if (tag === "input" || tag === "textarea") {
    const name = (el as HTMLInputElement).name
    if (name) {
      const form = el.closest("form")
      const scope = form || doc
      const byName = scope.querySelectorAll(
        `${tag}[name="${CSS.escape(name)}"]`
      )
      if (byName.length === 1) return `${tag}[name="${CSS.escape(name)}"]`
    }
  }

  // Fallback: generate a path from root that is likely stable
  const path: string[] = []
  let current: Element | null = el
  while (current && current !== doc.body) {
    let part = current.tagName.toLowerCase()
    if (current.id && /^[a-zA-Z][\w-]*$/.test(current.id)) {
      part += `#${CSS.escape(current.id)}`
      path.unshift(part)
      break
    }
    const tag = current.tagName
    const siblingSameTag = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (c) => c.tagName === tag
        )
      : []
    if (siblingSameTag.length > 1) {
      const index = siblingSameTag.indexOf(current) + 1
      part += `:nth-of-type(${index})`
    }
    path.unshift(part)
    current = current.parentElement
  }
  const selector = path.join(" > ")
  return selector || null
}

/** Build an XPath for the element (e.g. for replay or debugging). */
function getXPath(el: Element): string {
  if (!el || !el.ownerDocument || el.ownerDocument !== document) return ""
  const parts: string[] = []
  let current: Element | null = el
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (!parent) {
      parts.unshift(`/${tag}`)
      break
    }
    const tagName = current.tagName
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === tagName
    )
    const index = siblings.indexOf(current) + 1
    parts.unshift(`${tag}[${index}]`)
    current = parent
  }
  return parts.length ? "/" + parts.join("/") : ""
}

/** Human-readable description for a clickable (button, link, etc.): label, text, aria-label, etc. */
function getClickDescription(el: Element): string {
  const elAsHtml = el as HTMLElement
  const ariaLabel = el.getAttribute("aria-label")
  if (ariaLabel?.trim()) return ariaLabel.trim()
  const title = el.getAttribute("title")
  if (title?.trim()) return title.trim()
  if (el.tagName === "INPUT" || el.tagName === "BUTTON") {
    const value = (el as HTMLInputElement).value
    if (value?.trim()) return value.trim()
  }
  if (el.tagName === "A") {
    const href = (el as HTMLAnchorElement).getAttribute("href")
    const text = elAsHtml.innerText?.trim()
    if (text) return text
    if (href) return href
  }
  const text = elAsHtml.innerText?.trim()
  if (text) return text.slice(0, 80)
  const name = (el as HTMLInputElement).name
  if (name) return name
  return ""
}

/** Human-readable description for an input/textarea: label, placeholder, aria-label, name. */
function getFillDescription(el: Element): string {
  const ariaLabel = el.getAttribute("aria-label")
  if (ariaLabel?.trim()) return ariaLabel.trim()
  const placeholder = (el as HTMLInputElement).placeholder
  if (placeholder?.trim()) return placeholder.trim()
  const id = el.id
  if (id) {
    const label = el.ownerDocument.querySelector(
      `label[for="${CSS.escape(id)}"]`
    )
    const labelText = label?.textContent?.trim()
    if (labelText) return labelText
  }
  const inLabel = el.closest("label")
  if (inLabel) {
    const labelText = inLabel.textContent?.trim()
    if (labelText) return labelText
  }
  const name = (el as HTMLInputElement).name
  if (name) return name
  const title = el.getAttribute("title")
  if (title?.trim()) return title.trim()
  return ""
}

/** Human-readable description for a select: label, aria-label, name, or selected option text. */
function getSelectDescription(el: Element): string {
  const select = el as HTMLSelectElement
  const ariaLabel = el.getAttribute("aria-label")
  if (ariaLabel?.trim()) return ariaLabel.trim()
  const id = el.id
  if (id) {
    const label = el.ownerDocument.querySelector(
      `label[for="${CSS.escape(id)}"]`
    )
    const labelText = label?.textContent?.trim()
    if (labelText) return labelText
  }
  const inLabel = el.closest("label")
  if (inLabel) {
    const labelText = inLabel.textContent?.trim()
    if (labelText) return labelText
  }
  const name = select.name
  if (name) return name
  const option = select.options[select.selectedIndex]
  if (option?.text?.trim()) return option.text.trim()
  return ""
}

/** Returns true if this input must never have its value recorded (password-like). */
function isPasswordLikeInput(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (tag !== "input") return false
  const input = el as HTMLInputElement
  const type = (input.type || "text").toLowerCase()
  if (type === "password") return true
  const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase()
  if (
    autocomplete === "current-password" ||
    autocomplete === "new-password" ||
    autocomplete.includes("password")
  )
    return true
  const lower = (s: string) => (s || "").toLowerCase()
  const name = lower(input.name)
  const id = lower(input.id)
  const passwordLikeTokens = [
    "password",
    "pwd",
    "passwd",
    "secret",
    "passphrase"
  ]
  for (const token of passwordLikeTokens) {
    if (name.includes(token) || id.includes(token)) return true
  }
  return false
}

/** Returns the element that should be recorded for a click: the target or nearest actionable ancestor. */
function getActionableClickElement(el: Element | null): Element | null {
  let current: Element | null = el
  while (current && current !== document.body) {
    const tag = current.tagName.toLowerCase()
    const role = (current.getAttribute("role") || "").toLowerCase()
    if (tag === "a" || tag === "area") return current
    if (tag === "button") return current
    if (tag === "summary") return current
    if (tag === "input") {
      const type = ((current as HTMLInputElement).type || "text").toLowerCase()
      if (["submit", "button", "image", "reset"].includes(type)) return current
    }
    const interactiveRoles = [
      "button",
      "link",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "checkbox",
      "radio",
      "switch"
    ]
    if (role && interactiveRoles.includes(role)) return current
    current = current.parentElement
  }
  return null
}

let recording = false
let listenersAttached = false

function getUrl(): string {
  return window.location.href
}

function sendEvent(ev: RecorderEvent) {
  browser.runtime.sendMessage({ action: "recorder:event", payload: ev })
}

function onCaptureClick(e: MouseEvent) {
  if (!recording) return
  const target = e.target as Element
  console.log("onCaptureClick", target)
  const actionable = getActionableClickElement(target)
  if (!actionable) return
  const selector = getStableSelector(actionable)
  if (!selector) return
  const description = getClickDescription(actionable)
  const xpath = getXPath(actionable)
  console.log("onCaptureClick", selector, xpath, description)
  // recorderService.recorderEvent({
  //   kind: "click",
  //   selector,
  //   xpath,
  //   url: getUrl(),
  //   description: description || undefined
  // })
  sendEvent({
    kind: "click",
    selector,
    xpath,
    url: getUrl(),
    description: description || undefined
  })
}

/** Fill: record only on blur or Enter (not every keystroke). Debounce to avoid duplicate when both fire. */
const FILL_DEBOUNCE_MS = 400
const lastFillBySelector: Record<string, number> = {}

function recordFillIfNew(
  selector: string,
  xpath: string,
  value: string,
  description?: string
) {
  const now = Date.now()
  const last = lastFillBySelector[selector]
  if (last != null && now - last < FILL_DEBOUNCE_MS) return
  lastFillBySelector[selector] = now
  sendEvent({
    kind: "fill",
    selector,
    xpath,
    value,
    url: getUrl(),
    description: description || undefined
  })
}

function onCaptureFillBlur(e: FocusEvent) {
  if (!recording) return
  const target = e.target as HTMLElement
  const tag = target?.tagName?.toLowerCase()
  if (tag !== "input" && tag !== "textarea") return
  const input = target as HTMLInputElement
  const type = (input.type || "text").toLowerCase()
  if (type === "checkbox" || type === "radio") return
  const selector = getStableSelector(target)
  if (!selector) return
  const value = isPasswordLikeInput(target) ? "REDACTED" : (input.value ?? "")
  recordFillIfNew(selector, getXPath(target), value, getFillDescription(target))
}

function onCaptureFillEnter(e: KeyboardEvent) {
  if (!recording || e.key !== "Enter") return
  const target = e.target as HTMLElement
  const tag = target?.tagName?.toLowerCase()
  if (tag !== "input" && tag !== "textarea") return
  const input = target as HTMLInputElement
  const type = (input.type || "text").toLowerCase()
  if (type === "checkbox" || type === "radio") return
  const selector = getStableSelector(target)
  if (!selector) return
  const value = isPasswordLikeInput(target) ? "REDACTED" : (input.value ?? "")
  recordFillIfNew(selector, getXPath(target), value, getFillDescription(target))
}

function onCaptureSelectChange(e: Event) {
  if (!recording) return
  const target = e.target as HTMLElement
  if (target.tagName.toLowerCase() !== "select") return
  const selector = getStableSelector(target)
  if (!selector) return
  const select = target as HTMLSelectElement
  const option = select.options[select.selectedIndex]
  const value = option?.value ?? option?.text ?? ""
  const description = getSelectDescription(target)
  const xpath = getXPath(target)
  sendEvent({
    kind: "select",
    selector,
    xpath,
    value,
    url: getUrl(),
    description: description || undefined
  })
}

function onCaptureInputChange(e: Event) {
  if (!recording) return
  const target = e.target as HTMLElement
  const tag = target.tagName.toLowerCase()
  if (tag !== "input") return
  const input = target as HTMLInputElement
  const type = (input.type || "text").toLowerCase()
  if (type !== "checkbox" && type !== "radio") return
  const selector = getStableSelector(target)
  if (selector) {
    const description = getClickDescription(target)
    const xpath = getXPath(target)
    sendEvent({
      kind: "click",
      selector,
      xpath,
      url: getUrl(),
      description: description || undefined
    })
  }
}

function attachListeners() {
  if (listenersAttached) return
  document.addEventListener("click", onCaptureClick, true)
  document.addEventListener("blur", onCaptureFillBlur, true)
  document.addEventListener("keydown", onCaptureFillEnter, true)
  document.addEventListener("change", onCaptureSelectChange, true)
  document.addEventListener("change", onCaptureInputChange, true)
  listenersAttached = true
}

function detachListeners() {
  if (!listenersAttached) return
  document.removeEventListener("click", onCaptureClick, true)
  document.removeEventListener("blur", onCaptureFillBlur, true)
  document.removeEventListener("keydown", onCaptureFillEnter, true)
  document.removeEventListener("change", onCaptureSelectChange, true)
  document.removeEventListener("change", onCaptureInputChange, true)
  listenersAttached = false
}

export function startRecording() {
  recording = true
  attachListeners()
}

export function stopRecording() {
  recording = false
  detachListeners()
}

export function isRecording(): boolean {
  return recording
}
