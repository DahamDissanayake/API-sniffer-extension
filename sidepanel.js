const state = {
  origin: null,
  endpoints: {},
  filter: "",
};

function qs(id) {
  return document.getElementById(id);
}

async function getActiveTabOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  try {
    return new URL(tab.url).origin;
  } catch (e) {
    return null;
  }
}

async function loadEndpoints() {
  if (!state.origin) return;
  const response = await chrome.runtime.sendMessage({ type: "getEndpoints", origin: state.origin });
  state.endpoints = (response && response.data) || {};
  renderEndpointList();
}

// Cards are updated in place rather than being torn down and rebuilt on every
// render. A busy site can produce a storage change (and thus a re-render) every
// few hundred milliseconds; rebuilding the DOM each time would reset scroll
// position and collapse any card the user just expanded to read, making it
// impossible to actually inspect a fast-moving endpoint. Reusing existing card
// elements keeps `details.hidden` (expanded/collapsed) and any open replay form
// untouched across updates, and only refreshes the text that can change.
function renderEndpointList() {
  const container = qs("endpoint-list");
  const entries = Object.entries(state.endpoints)
    .filter(([, entry]) => entry.pattern.toLowerCase().includes(state.filter.toLowerCase()))
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen);

  if (entries.length === 0) {
    container.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No endpoints captured yet for this origin.";
    container.appendChild(empty);
    return;
  }

  if (container.querySelector(".empty-state")) {
    container.innerHTML = "";
  }

  const existingCards = new Map();
  for (const child of Array.from(container.children)) {
    if (child.dataset.key) existingCards.set(child.dataset.key, child);
  }

  for (const [key, entry] of entries) {
    let card = existingCards.get(key);
    if (card) {
      existingCards.delete(key);
      updateCard(card, entry);
    } else {
      card = renderCard(key, entry);
    }
    // appendChild on a node that's already a child of `container` just moves
    // it to the end (re-sorting), it does not recreate or reset the node.
    container.appendChild(card);
  }

  for (const stale of existingCards.values()) {
    stale.remove();
  }
}

function cssSafe(key) {
  return key.replace(/[^a-zA-Z0-9]/g, "_");
}

function renderCard(key, entry) {
  const card = document.createElement("div");
  card.className = "endpoint-card";
  card.dataset.key = key;
  card._entry = entry;

  const summary = document.createElement("div");
  summary.className = "endpoint-summary";

  const methodBadge = document.createElement("span");
  methodBadge.className = `method-badge method-${entry.method.toLowerCase()}`;
  methodBadge.textContent = entry.method;

  const pathLabel = document.createElement("span");
  pathLabel.className = "endpoint-path";
  pathLabel.textContent = entry.pattern;

  const meta = document.createElement("span");
  meta.className = "endpoint-meta";

  summary.appendChild(methodBadge);
  summary.appendChild(pathLabel);
  summary.appendChild(meta);

  const details = document.createElement("div");
  details.className = "endpoint-details";
  details.hidden = true;
  summary.addEventListener("click", () => {
    details.hidden = !details.hidden;
  });

  const headersSection = renderSection("Headers", "");
  const requestBodySection = renderSection("Request Body", "");
  const responseBodySection = renderSection("Response Body", "");
  details.appendChild(headersSection);
  details.appendChild(requestBodySection);
  details.appendChild(responseBodySection);

  const actions = document.createElement("div");
  actions.className = "endpoint-actions";

  const replayButton = document.createElement("button");
  replayButton.textContent = "Replay";
  replayButton.addEventListener("click", () => openReplayForm(key, card._entry));

  const curlButton = document.createElement("button");
  curlButton.textContent = "Copy as curl";
  curlButton.addEventListener("click", () => {
    const currentEntry = card._entry;
    const latestSample = currentEntry.samples[0];
    const cmd = curlBuilder.buildCurlCommand({
      method: currentEntry.method,
      url: latestSample.url.startsWith("http") ? latestSample.url : currentEntry.origin + latestSample.url,
      headers: latestSample.requestHeaders,
      body: latestSample.requestBody,
    });
    navigator.clipboard.writeText(cmd);
  });

  actions.appendChild(replayButton);
  actions.appendChild(curlButton);
  details.appendChild(actions);

  const replayContainer = document.createElement("div");
  replayContainer.className = "replay-container";
  replayContainer.id = `replay-${cssSafe(key)}`;
  details.appendChild(replayContainer);

  card.appendChild(summary);
  card.appendChild(details);

  card._refs = { meta, headersSection, requestBodySection, responseBodySection };
  updateCard(card, entry);
  return card;
}

function updateCard(card, entry) {
  card._entry = entry;
  const { meta, headersSection, requestBodySection, responseBodySection } = card._refs;

  meta.textContent = `${entry.hitCount} hits · ${entry.tag}${entry.authWarning ? " · auth-warning" : ""}`;

  const latestSample = entry.samples[0];
  headersSection.querySelector("pre").textContent = JSON.stringify(latestSample.requestHeaders, null, 2);
  requestBodySection.querySelector("pre").textContent = latestSample.requestBody || "(empty)";
  const responseNote = latestSample.responseTruncated ? "\n[response was truncated]" : "";
  responseBodySection.querySelector("pre").textContent = (latestSample.responseBody || "(empty)") + responseNote;
}

function renderSection(label, content) {
  const section = document.createElement("div");
  section.className = "endpoint-section";
  const heading = document.createElement("h4");
  heading.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = content;
  section.appendChild(heading);
  section.appendChild(pre);
  return section;
}

function openReplayForm(key, entry) {
  const container = qs(`replay-${cssSafe(key)}`);
  container.innerHTML = "";
  const latestSample = entry.samples[0];

  const urlInput = document.createElement("input");
  urlInput.className = "replay-url";
  urlInput.value = latestSample.url.startsWith("http") ? latestSample.url : entry.origin + latestSample.url;

  const headersInput = document.createElement("textarea");
  headersInput.className = "replay-headers";
  headersInput.value = JSON.stringify(latestSample.requestHeaders || {}, null, 2);

  const bodyInput = document.createElement("textarea");
  bodyInput.className = "replay-body";
  bodyInput.value = latestSample.requestBody || "";

  const sendButton = document.createElement("button");
  sendButton.textContent = "Send";

  const responseBox = document.createElement("pre");
  responseBox.className = "replay-response";

  sendButton.addEventListener("click", async () => {
    let headers;
    try {
      headers = JSON.parse(headersInput.value || "{}");
    } catch (e) {
      responseBox.textContent = "Invalid headers JSON";
      return;
    }
    const request = { method: entry.method, url: urlInput.value, headers, body: bodyInput.value || undefined };
    responseBox.textContent = "Sending...";

    // If a prior click already found no open tab, skip straight to the cookie-less
    // fallback instead of re-trying "replay" (which would just fail with "no-tab"
    // again as long as the tab stays closed, and re-trigger the warning forever).
    if (sendButton.dataset.forceCookieless === "true") {
      const fallback = await chrome.runtime.sendMessage({ type: "replayCookieless", request });
      renderReplayResult(responseBox, fallback);
      return;
    }

    const result = await chrome.runtime.sendMessage({ type: "replay", origin: entry.origin, request });

    if (!result.ok && result.reason === "no-tab") {
      responseBox.textContent =
        "No open tab for this origin. Open the site to replay with its session, or click Send again to replay cookie-less.";
      sendButton.dataset.forceCookieless = "true";
      return;
    }

    renderReplayResult(responseBox, result);
  });

  container.appendChild(urlInput);
  container.appendChild(headersInput);
  container.appendChild(bodyInput);
  container.appendChild(sendButton);
  container.appendChild(responseBox);
}

function renderReplayResult(responseBox, result) {
  if (!result.ok) {
    responseBox.textContent = `Error: ${result.reason}${result.message ? " - " + result.message : ""}`;
    return;
  }
  const cookieNote = result.cookieless ? "[replayed without cookies]\n" : "";
  responseBox.textContent = `${cookieNote}Status: ${result.status}\nHeaders: ${JSON.stringify(
    result.headers,
    null,
    2
  )}\n\nBody:\n${result.body}`;
}

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ type: "getSettings" });
  qs("retention-days").value = response.settings.retentionDays;
  qs("throttle-ms").value = response.settings.throttleWindowMs;
}

function setupSettingsActions() {
  qs("save-settings").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "setSettings",
      settings: {
        retentionDays: Number(qs("retention-days").value) || 30,
        throttleWindowMs: Number(qs("throttle-ms").value) || 30000,
      },
    });
  });

  qs("clear-domain").addEventListener("click", async () => {
    if (!state.origin) return;
    if (!confirm(`Clear all captured data for ${state.origin}?`)) return;
    await chrome.runtime.sendMessage({ type: "clearDomain", origin: state.origin });
    await loadEndpoints();
  });

  qs("clear-all").addEventListener("click", async () => {
    if (!confirm("Clear ALL captured data for every domain?")) return;
    await chrome.runtime.sendMessage({ type: "clearAll" });
    await loadEndpoints();
  });
}

function setupSearch() {
  qs("search-input").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderEndpointList();
  });
}

function setupTabs() {
  qs("tab-endpoints").addEventListener("click", () => {
    qs("tab-endpoints").classList.add("active");
    qs("tab-settings").classList.remove("active");
    qs("view-endpoints").hidden = false;
    qs("view-settings").hidden = true;
  });
  qs("tab-settings").addEventListener("click", () => {
    qs("tab-settings").classList.add("active");
    qs("tab-endpoints").classList.remove("active");
    qs("view-settings").hidden = false;
    qs("view-endpoints").hidden = true;
    loadSettings();
  });
}

async function init() {
  setupTabs();
  setupSearch();
  setupSettingsActions();
  state.origin = await getActiveTabOrigin();
  await loadEndpoints();

  chrome.tabs.onActivated.addListener(async () => {
    state.origin = await getActiveTabOrigin();
    await loadEndpoints();
  });
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.active) {
      state.origin = await getActiveTabOrigin();
      await loadEndpoints();
    }
  });
  // Keep the list "live" while the panel stays open on the same tab: background.js
  // writes captures to chrome.storage.local as they happen, so react to changes on
  // the current origin's key instead of only refreshing on tab switch/navigation.
  // Debounced because a busy site can fire storage changes many times a second;
  // reloading on every single one would re-sort the list out from under the user
  // repeatedly instead of once they've paused.
  let reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !state.origin) return;
    if (Object.prototype.hasOwnProperty.call(changes, `endpoints::${state.origin}`)) {
      if (reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        loadEndpoints();
      }, 400);
    }
  });
}

init();
