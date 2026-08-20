// Amazon2Agent — service worker
// Orchestrates full-page scrapes: opens the product page in a background tab,
// asks the content script there to scrape the rendered DOM (after lazy-load
// settling), stores the result, and closes the tab. One page at a time, with
// a polite gap between pages.

const STORAGE_KEY = "amx_data";
const SCRAPE_GAP_MS = 1500;
const SCRAPE_TIMEOUT_MS = 35000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Items live inside projects ({ projects: [{ id, name, items }], selectedId },
// written by content.js). The same product may sit in several projects — a
// scrape result is applied to every copy.
async function updateItemScrape(asin, scrape) {
  const data = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!data || !Array.isArray(data.projects)) return; // cleared while scraping
  let touched = false;
  for (const project of data.projects) {
    const item = (project.items || []).find((i) => i.asin === asin);
    if (item) {
      item.scrape = scrape;
      if (scrape.regions && scrape.regions.title) {
        item.title = scrape.regions.title;
      }
      touched = true;
    }
  }
  if (touched) await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

// ---------------------------------------------------------------------------
// Scrape queue
// ---------------------------------------------------------------------------

const queue = [];
let running = false;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "amx-scrape" && msg.asin && msg.origin) {
    if (!queue.some((j) => j.asin === msg.asin)) {
      queue.push({ asin: msg.asin, origin: msg.origin });
    }
    if (!running) processQueue();
    sendResponse({ ok: true });
  }
});

async function processQueue() {
  running = true;
  while (queue.length) {
    const job = queue.shift();
    let scrape;
    try {
      scrape = await scrapeInBackgroundTab(job);
    } catch (err) {
      scrape = {
        status: "failed",
        reason: String((err && err.message) || err),
        fetchedAt: new Date().toISOString(),
      };
    }
    await updateItemScrape(job.asin, scrape);
    if (queue.length) await sleep(SCRAPE_GAP_MS);
  }
  running = false;
}

// ---------------------------------------------------------------------------
// Background-tab scraping
// ---------------------------------------------------------------------------

function scrapeInBackgroundTab({ asin, origin }) {
  return new Promise((resolve, reject) => {
    // The #amx-scrape marker tells the content script in that tab to run in
    // scrape mode (no floating UI, no capture handlers).
    const url = `${origin}/dp/${asin}#amx-scrape`;

    chrome.tabs.create({ url, active: false }).then((tab) => {
      let done = false;

      const finish = (ok, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.remove(tab.id).catch(() => {});
        ok ? resolve(value) : reject(value);
      };

      const timer = setTimeout(
        () => finish(false, new Error("timed out loading product page")),
        SCRAPE_TIMEOUT_MS
      );

      function onUpdated(tabId, info) {
        if (tabId !== tab.id || info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // Small grace period for the content script to attach, then ask it
        // to settle lazy-loaded sections and scrape.
        setTimeout(async () => {
          try {
            const res = await chrome.tabs.sendMessage(tab.id, { type: "amx-scrape-self" });
            if (res && res.status) finish(true, res);
            else finish(false, new Error("no scrape result from page"));
          } catch (err) {
            finish(false, err);
          }
        }, 500);
      }

      chrome.tabs.onUpdated.addListener(onUpdated);
    }, reject);
  });
}
