// Trust note: this only filters on message shape (same-window + a matching `source`
// tag), not authenticity. Because content-script-hook.js runs in the page's own MAIN
// world (not a privileged context), any script on the page could post a
// same-shaped message and have it relayed indistinguishably from a genuine capture.
// Accepted for a personal, local-only tool — see README's "Chrome API limitations".
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "api-sniffer-hook") return;
  chrome.runtime.sendMessage({ type: "capture", payload: event.data.payload }).catch(() => {
    // Extension context may be invalidated (e.g. reloaded) mid-page-life; safe to ignore.
  });
});
