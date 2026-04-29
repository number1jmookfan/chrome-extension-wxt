/**
 * Injects overrides into the page's MAIN world to prevent new tabs/popups.
 * All navigations are redirected to the current tab so users in kiosk mode
 * can rely on the back button.
 *
 * Must be called from the content script.
 */
export function injectKioskPageOverrides() {
  const script = document.createElement("script")
  script.textContent = `(${kioskPageScript.toString()})()`
  document.documentElement.appendChild(script)
  script.remove()
}

function kioskPageScript() {
  // Override window.open to navigate in the same tab
  window.open = function (url?: string | URL) {
    if (url && String(url) !== "about:blank") {
      window.location.href = String(url)
    }
    return null
  }

  // Intercept clicks on links that would open a new tab/window
  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      const anchor = (e.target as Element)?.closest?.(
        "a[target]"
      ) as HTMLAnchorElement | null
      if (!anchor) return

      const target = anchor.getAttribute("target")
      if (target === "_blank" || target === "_new") {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (anchor.href && anchor.href !== "about:blank") {
          window.location.href = anchor.href
        }
      }
    },
    true
  )

  // Rewrite forms that submit to a new tab
  document.addEventListener(
    "submit",
    (e: Event) => {
      const form = e.target as HTMLFormElement | null
      if (!form) return

      const target = form.getAttribute("target")
      if (target === "_blank" || target === "_new") {
        form.setAttribute("target", "_self")
      }
    },
    true
  )
}
