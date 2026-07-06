window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "api-sniffer-hook") return;
  chrome.runtime.sendMessage({ type: "capture", payload: event.data.payload }).catch(() => {
    // Extension context may be invalidated (e.g. reloaded) mid-page-life; safe to ignore.
  });
});
