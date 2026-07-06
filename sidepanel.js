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

function renderEndpointList() {
  const container = qs("endpoint-list");
  container.innerHTML = "";
  const entries = Object.entries(state.endpoints)
    .filter(([, entry]) => entry.pattern.toLowerCase().includes(state.filter.toLowerCase()))
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen);

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No endpoints captured yet for this origin.";
    container.appendChild(empty);
    return;
  }

  for (const [key, entry] of entries) {
    container.appendChild(renderCard(key, entry));
  }
}

function renderCard(key, entry) {
  const card = document.createElement("div");
  card.className = "endpoint-card";

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
  meta.textContent = `${entry.hitCount} hits · ${entry.tag}${entry.authWarning ? " · auth-warning" : ""}`;

  summary.appendChild(methodBadge);
  summary.appendChild(pathLabel);
  summary.appendChild(meta);

  const details = document.createElement("div");
  details.className = "endpoint-details";
  details.hidden = true;
  summary.addEventListener("click", () => {
    details.hidden = !details.hidden;
  });

  const latestSample = entry.samples[0];
  details.appendChild(renderSection("Headers", JSON.stringify(latestSample.requestHeaders, null, 2)));
  details.appendChild(renderSection("Request Body", latestSample.requestBody || "(empty)"));
  const responseNote = latestSample.responseTruncated ? "\n[response was truncated]" : "";
  details.appendChild(
    renderSection("Response Body", (latestSample.responseBody || "(empty)") + responseNote)
  );

  card.appendChild(summary);
  card.appendChild(details);
  return card;
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
  });
}

async function init() {
  setupTabs();
  setupSearch();
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
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !state.origin) return;
    if (Object.prototype.hasOwnProperty.call(changes, `endpoints::${state.origin}`)) {
      loadEndpoints();
    }
  });
}

init();
