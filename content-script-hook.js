(function hookFetch() {
  const originalFetch = window.fetch;

  window.fetch = async function patchedFetch(input, init) {
    const startTime = Date.now();
    const method = (init && init.method) || (typeof input !== "string" && input && input.method) || "GET";
    // Resolve against the page's own location: a plain string `input` is very often
    // relative (fetch('/api/foo')), and capturing it as-is would let background.js
    // resolve it against the extension's own origin instead of the page's — silently
    // misattributing the endpoint to the wrong domain. Request/URL objects already
    // carry an absolute URL, so this is a no-op for them.
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, location.href).href;

    const requestHeaders = {};
    if (init && init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        requestHeaders[key] = value;
      });
    }
    const requestBody = init && typeof init.body === "string" ? init.body : undefined;

    const response = await originalFetch.call(this, input, init);

    // Read headers synchronously and the body asynchronously, without awaiting the
    // body before returning `response` to the page. Native fetch() resolves as soon
    // as headers arrive, independent of body consumption — awaiting cloned.text()
    // here would hang the page's own fetch() promise forever on a long-lived/streamed
    // response (SSE-over-fetch, chunked NDJSON, etc), which breaks "passive" capture.
    const cloned = response.clone();
    const responseHeaders = {};
    cloned.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    cloned
      .text()
      .then((responseBody) => {
        window.postMessage(
          {
            source: "api-sniffer-hook",
            payload: {
              method: method.toUpperCase(),
              url,
              requestHeaders,
              requestBody,
              responseHeaders,
              responseBody,
              status: response.status,
              timestamp: startTime,
            },
          },
          "*"
        );
      })
      .catch(() => {
        // Body unreadable or never completes (e.g. an infinite stream) — nothing to capture.
      });

    return response;
  };
})();

(function hookXHR() {
  const XHRProto = XMLHttpRequest.prototype;
  const originalOpen = XHRProto.open;
  const originalSend = XHRProto.send;
  const originalSetRequestHeader = XHRProto.setRequestHeader;

  XHRProto.open = function patchedOpen(method, url, ...rest) {
    // Same relative-URL concern as the fetch hook above: xhr.open('GET', '/api/foo')
    // is common and must resolve against the page's own location, not the extension's.
    const absoluteUrl = new URL(url, location.href).href;
    this.__apiSniffer = { method: method.toUpperCase(), url: absoluteUrl, requestHeaders: {}, startTime: Date.now() };
    return originalOpen.call(this, method, url, ...rest);
  };

  XHRProto.setRequestHeader = function patchedSetRequestHeader(name, value) {
    if (this.__apiSniffer) {
      this.__apiSniffer.requestHeaders[name] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XHRProto.send = function patchedSend(body) {
    if (this.__apiSniffer) {
      this.__apiSniffer.requestBody = typeof body === "string" ? body : undefined;
      this.addEventListener("loadend", () => {
        const responseHeaders = headerUtils.parseRawHeaderString(this.getAllResponseHeaders());
        // Reading .responseText throws InvalidStateError when responseType is anything
        // other than "" or "text" (a common case: responseType = "json"). Branch on
        // responseType instead of relying on a typeof check after the throw already happened.
        let responseBody;
        if (this.responseType === "" || this.responseType === "text") {
          responseBody = typeof this.responseText === "string" ? this.responseText : undefined;
        } else if (this.responseType === "json") {
          responseBody = this.response !== null && this.response !== undefined ? JSON.stringify(this.response) : undefined;
        } else {
          responseBody = undefined; // arraybuffer/blob/document: not safely capturable as text
        }
        window.postMessage(
          {
            source: "api-sniffer-hook",
            payload: {
              method: this.__apiSniffer.method,
              url: this.__apiSniffer.url,
              requestHeaders: this.__apiSniffer.requestHeaders,
              requestBody: this.__apiSniffer.requestBody,
              responseHeaders,
              responseBody,
              status: this.status,
              timestamp: this.__apiSniffer.startTime,
            },
          },
          "*"
        );
      });
    }
    return originalSend.call(this, body);
  };
})();
