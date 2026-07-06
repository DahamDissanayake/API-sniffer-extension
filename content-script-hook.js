(function hookFetch() {
  const originalFetch = window.fetch;

  window.fetch = async function patchedFetch(input, init) {
    const startTime = Date.now();
    const method = (init && init.method) || (typeof input !== "string" && input && input.method) || "GET";
    const url = typeof input === "string" ? input : input.url;

    const requestHeaders = {};
    if (init && init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        requestHeaders[key] = value;
      });
    }
    const requestBody = init && typeof init.body === "string" ? init.body : undefined;

    const response = await originalFetch.call(this, input, init);

    const cloned = response.clone();
    let responseBody;
    try {
      responseBody = await cloned.text();
    } catch (e) {
      responseBody = undefined;
    }
    const responseHeaders = {};
    cloned.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

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

    return response;
  };
})();

(function hookXHR() {
  const XHRProto = XMLHttpRequest.prototype;
  const originalOpen = XHRProto.open;
  const originalSend = XHRProto.send;
  const originalSetRequestHeader = XHRProto.setRequestHeader;

  XHRProto.open = function patchedOpen(method, url, ...rest) {
    this.__apiSniffer = { method: method.toUpperCase(), url, requestHeaders: {}, startTime: Date.now() };
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
        window.postMessage(
          {
            source: "api-sniffer-hook",
            payload: {
              method: this.__apiSniffer.method,
              url: this.__apiSniffer.url,
              requestHeaders: this.__apiSniffer.requestHeaders,
              requestBody: this.__apiSniffer.requestBody,
              responseHeaders,
              responseBody: typeof this.responseText === "string" ? this.responseText : undefined,
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
