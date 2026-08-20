// Amazon2Agent — content script
// Feature 1: Alt+Click a product link to add it to the selected project's
// list, shown in a floating bar. Products are organized into user-created
// projects (create / rename / delete / select). Each item's product page is
// then opened in a hidden background tab (by background.js), fully rendered,
// scrolled to trigger lazy-loaded sections, and scraped using "scoped strip":
// selectors only crop stable page regions, never parse fields; each region is
// reduced to plain text. Export as agent-friendly Markdown ("Copy all").
//
// This same script also runs inside the hidden scrape tabs (marked with
// #amx-scrape in the URL) — there it only answers scrape requests and renders
// no UI.

(() => {
  "use strict";

  const STORAGE_KEY = "amx_data";
  const LEGACY_KEY = "amx_items"; // pre-projects flat list, migrated on first load
  const IS_SCRAPE_TAB = location.hash.includes("amx-scrape");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Scoped-strip scraping
  //
  // Selectors are used ONLY to find region boundaries (stable, top-level Amazon
  // container ids), never to parse individual fields. Region content is
  // stripped to plain text so layout changes inside a region can't break us.
  // ---------------------------------------------------------------------------

  const REGIONS = [
    { key: "title", sel: ["#productTitle", "#title"], cap: 300 },
    { key: "breadcrumb", sel: ["#wayfinding-breadcrumbs_feature_div", "#wayfinding-breadcrumbs_container"], cap: 200 },
    { key: "price", sel: ["#apex_desktop", "#corePriceDisplay_desktop_feature_div", "#corePrice_feature_div"], cap: 500 },
    { key: "availability", sel: ["#availability"], cap: 200 },
    // Buybox / right column: condition (New/Renewed grade), sold by / fulfilled
    // by, delivery & returns, "other sellers" summary.
    { key: "buybox", sel: ["#rightCol", "#desktop_buybox", "#buybox"], cap: 1000 },
    { key: "variants", sel: ["#twister_feature_div", "#twister"], cap: 800 },
    { key: "overview", sel: ["#productOverview_feature_div"], cap: 1500 },
    { key: "bullets", sel: ["#feature-bullets", "#featurebullets_feature_div"], cap: 2500 },
    { key: "details", sel: ["#prodDetails", "#detailBullets_feature_div", "#productDetails_feature_div", "#technicalSpecifications_feature_div"], cap: 4000 },
    { key: "description", sel: ["#productDescription"], cap: 3000 },
    { key: "aplus", sel: ["#aplus_feature_div", "#aplus"], cap: 3000 },
    { key: "importantInfo", sel: ["#importantInformation"], cap: 800 },
    { key: "rating", sel: ["#averageCustomerReviews"], cap: 200 },
    { key: "reviews", sel: ["#cm-cr-dp-review-list", "#cm-cr-review_list", "#reviewsMedley"], cap: 4000 },
  ];

  const UNSCOPED_SEL = ["#centerCol", "#ppd", "#dp-container", "#dp"];
  const UNSCOPED_CAP = 6000;

  // Repeated review-widget chrome that inflates the reviews region and
  // crowds out actual review text. Removed before the cap is applied.
  const BOILERPLATE = [
    /Report\s*Sending feedback\.{3}/gi,
    /Sending feedback\.{3}/gi,
    /Thank you for your feedback\.?/gi,
    /Sorry, we failed to record your vote\. Please try again\.?/gi,
    /Sorry, we failed to report this review\. Please try again\.?/gi,
    /Thanks\. We[’']ll investigate in the next few days\.?/gi,
    /How are ratings calculated\?/gi,
    /Review this product\s*Share your thoughts with other customers\s*Write a customer review/gi,
    /Sorry; we couldn[’']t translate the review/gi,
    /Translate review to English/gi,
    /Translated from \w+ by Amazon/gi,
    /Translated by Amazon/gi,
    /See original/gi,
  ];

  function stripToText(el, cap) {
    const clone = el.cloneNode(true);
    // aria-hidden covers Amazon's visual-only duplicates (e.g. split price
    // spans); the accessible text (.a-offscreen) stays. CSS-hidden nodes carry
    // internal template data (e.g. BuyingOptionData blobs), never product facts.
    clone
      .querySelectorAll(
        'script, style, noscript, template, [aria-hidden="true"], [hidden], ' +
        '.aok-hidden, .a-hidden, .a-popover-preload, ' +
        '[style*="display:none"], [style*="display: none"], ' +
        '[style*="visibility:hidden"], [style*="visibility: hidden"]'
      )
      .forEach((n) => n.remove());
    let text = clone.textContent.replace(/\s+/g, " ");
    for (const re of BOILERPLATE) text = text.replace(re, " ");
    return text.replace(/\s+/g, " ").trim().slice(0, cap);
  }

  // Breadcrumb links have no text between them — join them explicitly so the
  // category path stays readable ("Computers › Monitors").
  function breadcrumbText(el, cap) {
    const parts = [...el.querySelectorAll("a")]
      .map((a) => a.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return parts.join(" › ").slice(0, cap);
  }

  function extractRegions(doc) {
    const regions = {};
    for (const { key, sel, cap } of REGIONS) {
      for (const s of sel) {
        const el = doc.querySelector(s);
        if (el) {
          const text = key === "breadcrumb" ? breadcrumbText(el, cap) : stripToText(el, cap);
          if (text) {
            regions[key] = text;
            break;
          }
        }
      }
    }
    return regions;
  }

  function looksLikeBotCheck(doc) {
    return (
      /robot check|captcha/i.test(doc.title || "") ||
      !!doc.querySelector('form[action*="validateCaptcha"]')
    );
  }

  function scrapeDocument(doc) {
    if (looksLikeBotCheck(doc)) {
      return { status: "failed", reason: "bot-check page returned", fetchedAt: new Date().toISOString() };
    }
    const regions = extractRegions(doc);
    // "Good enough" = we found real product content, not just chrome.
    if (regions.title || regions.bullets || regions.details) {
      return { status: "ok", regions, fetchedAt: new Date().toISOString() };
    }
    // Graceful degradation: no regions matched — include the main content
    // area as unscoped text rather than dropping data.
    for (const s of UNSCOPED_SEL) {
      const el = doc.querySelector(s);
      if (el) {
        const text = stripToText(el, UNSCOPED_CAP);
        if (text) {
          return {
            status: "partial",
            regions: { ...regions, unscoped: text },
            fetchedAt: new Date().toISOString(),
          };
        }
      }
    }
    return { status: "failed", reason: "no product regions found", fetchedAt: new Date().toISOString() };
  }

  // Newer Amazon layouts collapse "Product information" (and similar
  // sections) into accordions whose content is hidden or unrendered until
  // expanded — click the expander toggles so the spec values are actually in
  // the DOM. Only runs in hidden scrape tabs, never on the user's own page.
  async function expandCollapsedSections() {
    const toggles = document.querySelectorAll(
      '[data-action="a-expander-toggle"], .a-expander-header[aria-expanded="false"]'
    );
    let clicked = 0;
    for (const el of toggles) {
      if (clicked >= 25) break; // safety cap
      try {
        el.click();
        clicked++;
      } catch {
        /* ignore */
      }
    }
    if (clicked) await sleep(800);
  }

  // Scroll through the page so lazy-loaded sections (reviews, A+ content,
  // detail widgets) actually render, expand collapsed accordions, then scrape.
  async function settleAndScrape() {
    const h = () => document.body ? document.body.scrollHeight : 0;
    for (const frac of [0.35, 0.7, 1]) {
      window.scrollTo(0, h() * frac);
      await sleep(700);
    }
    window.scrollTo(0, h()); // height may have grown as sections loaded
    await sleep(900);
    await expandCollapsedSections();
    window.scrollTo(0, 0);
    await sleep(300);
    return scrapeDocument(document);
  }

  // Answer the worker's scrape request in EVERY tab (the worker only ever
  // sends it to tabs it opened itself). Registering unconditionally means
  // scraping still works even if Amazon's scripts strip the #amx-scrape
  // marker from the URL before we read it.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "amx-scrape-self") {
      settleAndScrape().then(sendResponse);
      return true; // async response
    }
  });

  // Scrape tabs render no UI and capture no clicks.
  if (IS_SCRAPE_TAB) return;

  // ---------------------------------------------------------------------------
  // Product link detection
  // ---------------------------------------------------------------------------

  // Matches /dp/ASIN, /gp/product/ASIN, /gp/aw/d/ASIN, /product/ASIN
  // An ASIN is 10 chars, alphanumeric (uppercase in practice).
  const ASIN_PATH_RE = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?]|$)/i;

  function extractAsin(href) {
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return null;
    }
    if (!/(^|\.)amazon\./i.test(url.hostname)) return null;
    const m = url.pathname.match(ASIN_PATH_RE);
    return m ? m[1].toUpperCase() : null;
  }

  function findProductLink(el) {
    const link = el && el.closest ? el.closest("a[href]") : null;
    if (!link) return null;
    const asin = extractAsin(link.getAttribute("href"));
    return asin ? { link, asin } : null;
  }

  // ---------------------------------------------------------------------------
  // Title extraction (used for the list row; the scrape brings the real title)
  // ---------------------------------------------------------------------------

  function cleanText(s) {
    return (s || "").replace(/\s+/g, " ").trim().slice(0, 250);
  }

  function extractTitle(link, asin) {
    let t = cleanText(link.getAttribute("aria-label") || link.title);
    if (t) return t;

    t = cleanText(link.textContent);
    if (t && t.length > 5 && !/^[\d.,$€£¥\s%()-]+$/.test(t)) return t;

    const img = link.querySelector("img[alt]");
    if (img) {
      t = cleanText(img.getAttribute("alt"));
      if (t && t.length > 5) return t;
    }

    const card = link.closest(`[data-asin="${asin}"]`) || link.closest("[data-asin]");
    if (card) {
      const h = card.querySelector("h2, h5, .a-size-base-plus, .a-size-medium");
      t = cleanText(h && h.textContent);
      if (t) return t;
    }

    const pageAsin = extractAsin(location.href);
    if (pageAsin === asin) {
      const pt = document.getElementById("productTitle");
      t = cleanText(pt ? pt.textContent : document.title);
      if (t) return t;
    }

    return "(untitled product)";
  }

  function canonicalUrl(asin) {
    return `${location.origin}/dp/${asin}`;
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  // Shape: { projects: [{ id, name, createdAt, items: [...] }], selectedId }
  // Items live inside their project; the same product may exist in several
  // projects, so scrape results are applied to every copy.

  function makeProject(name) {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name,
      createdAt: new Date().toISOString(),
      items: [],
    };
  }

  async function getData() {
    const raw = await chrome.storage.local.get([STORAGE_KEY, LEGACY_KEY]);
    let data = raw[STORAGE_KEY];
    if (data && Array.isArray(data.projects)) return data;
    // First run, or upgrade from the pre-projects version: move the legacy
    // flat item list into a starter project so nothing is lost.
    data = { projects: [], selectedId: null };
    const legacy = raw[LEGACY_KEY];
    if (Array.isArray(legacy) && legacy.length) {
      const project = makeProject("My products");
      project.items = legacy;
      data.projects.push(project);
      data.selectedId = project.id;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
    await chrome.storage.local.remove(LEGACY_KEY);
    return data;
  }

  async function setData(data) {
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  }

  function selectedProject(data) {
    return data.projects.find((p) => p.id === data.selectedId) || null;
  }

  async function addItem(item) {
    const data = await getData();
    const project = selectedProject(data);
    if (!project) return { added: false, noProject: true };
    const existing = project.items.find((i) => i.asin === item.asin);
    if (existing) return { added: false, existing };
    project.items.push(item);
    await setData(data);
    return { added: true };
  }

  async function removeItem(asin) {
    const data = await getData();
    const project = selectedProject(data);
    if (!project) return;
    project.items = project.items.filter((i) => i.asin !== asin);
    await setData(data);
  }

  async function updateItemScrape(asin, scrape) {
    const data = await getData();
    let touched = false;
    for (const project of data.projects) {
      const item = project.items.find((i) => i.asin === asin);
      if (item) {
        item.scrape = scrape;
        if (scrape.regions && scrape.regions.title) {
          item.title = scrape.regions.title;
        }
        touched = true;
      }
    }
    if (touched) await setData(data);
  }

  // Ask the service worker to load the product page in a hidden background
  // tab and scrape the fully rendered DOM. If we're already ON that product's
  // page, scrape the live DOM directly — it's already rendered.
  // The worker must acknowledge; if it can't be reached the item is marked
  // failed (retryable) instead of being stranded in pending.
  async function requestScrape(asin) {
    if (extractAsin(location.href) === asin) {
      await updateItemScrape(asin, scrapeDocument(document));
      return;
    }
    try {
      const ack = await chrome.runtime.sendMessage({ type: "amx-scrape", asin, origin: location.origin });
      if (!ack || !ack.ok) throw new Error("no acknowledgement");
    } catch (err) {
      await updateItemScrape(asin, {
        status: "failed",
        reason: `could not reach background scraper (${String((err && err.message) || err)})`,
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  async function markPendingAndScrape(asin) {
    await updateItemScrape(asin, { status: "pending", requestedAt: new Date().toISOString() });
    await requestScrape(asin);
  }

  // ---------------------------------------------------------------------------
  // Alt-key state + cursor feedback
  // ---------------------------------------------------------------------------

  const ALT_CLASS = "amx-alt-down";
  const NO_PROJECT_CLASS = "amx-no-project";

  // Kept in sync by renderAll(); drives cursor + tooltip feedback below.
  let hasSelectedProject = false;

  // Floating "Select a project first" tooltip shown on Alt-hover when no
  // project is selected (the copy cursor would otherwise promise an add).
  const altTip = document.createElement("div");
  altTip.textContent = "Select a project first";
  altTip.style.cssText =
    "position:fixed;z-index:2147483647;display:none;pointer-events:none;" +
    "background:#131921;color:#fff;border-left:3px solid #cc0c39;" +
    "padding:6px 10px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.3);" +
    "font:12px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;";
  document.documentElement.appendChild(altTip);

  function showAltTip(x, y) {
    altTip.style.left = Math.min(x + 14, window.innerWidth - 180) + "px";
    altTip.style.top = Math.min(y + 18, window.innerHeight - 40) + "px";
    altTip.style.display = "block";
  }

  function hideAltTip() {
    altTip.style.display = "none";
  }

  function setAltState(down) {
    document.documentElement.classList.toggle(ALT_CLASS, down);
    if (!down) hideAltTip();
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt") setAltState(true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt") setAltState(false);
  });
  // If focus leaves the page while Alt is held, keyup never fires — reset.
  window.addEventListener("blur", () => setAltState(false));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setAltState(false);
  });

  // Tag product links as the mouse moves over them so CSS can style them.
  document.addEventListener(
    "mouseover",
    (e) => {
      setAltState(e.altKey);
      const hit = findProductLink(e.target);
      if (hit && !hit.link.hasAttribute("data-amx-product")) {
        hit.link.setAttribute("data-amx-product", hit.asin);
      }
      if (hit && e.altKey && !hasSelectedProject) {
        showAltTip(e.clientX, e.clientY);
      } else {
        hideAltTip();
      }
    },
    true
  );

  const pageStyle = document.createElement("style");
  pageStyle.textContent = `
    html.${ALT_CLASS} a[data-amx-product],
    html.${ALT_CLASS} a[data-amx-product] * {
      cursor: copy !important;
    }
    html.${ALT_CLASS} a[data-amx-product]:hover {
      outline: 2px solid #ff9900 !important;
      outline-offset: 1px;
      border-radius: 2px;
    }
    html.${ALT_CLASS}.${NO_PROJECT_CLASS} a[data-amx-product],
    html.${ALT_CLASS}.${NO_PROJECT_CLASS} a[data-amx-product] * {
      cursor: not-allowed !important;
    }
    html.${ALT_CLASS}.${NO_PROJECT_CLASS} a[data-amx-product]:hover {
      outline-color: #cc0c39 !important;
    }
  `;
  document.documentElement.appendChild(pageStyle);

  // ---------------------------------------------------------------------------
  // Alt+Click capture
  // ---------------------------------------------------------------------------

  document.addEventListener(
    "click",
    async (e) => {
      if (!e.altKey || e.button !== 0) return;
      const hit = findProductLink(e.target);
      if (!hit) return;

      // Don't navigate, don't download (Alt+click default), don't let Amazon's
      // own handlers run.
      e.preventDefault();
      e.stopImmediatePropagation();

      const item = {
        asin: hit.asin,
        title: extractTitle(hit.link, hit.asin),
        url: canonicalUrl(hit.asin),
        addedAt: new Date().toISOString(),
        scrape: { status: "pending", requestedAt: new Date().toISOString() },
      };

      const { added, existing, noProject } = await addItem(item);
      if (noProject) {
        toast("Select a project first");
        panel.classList.add("open"); // opens on the projects screen
        return;
      }
      if (added) {
        toast(`Added: ${item.title}`);
        requestScrape(hit.asin);
      } else if (existing.scrape && existing.scrape.status !== "ok") {
        toast("Already in list — retrying scrape");
        markPendingAndScrape(hit.asin);
      } else {
        toast("Already in list");
      }
      flashLink(hit.link);
    },
    true
  );

  function flashLink(link) {
    link.style.transition = "background-color 0.15s";
    const prev = link.style.backgroundColor;
    link.style.backgroundColor = "rgba(255,153,0,0.35)";
    setTimeout(() => (link.style.backgroundColor = prev), 350);
  }

  // ---------------------------------------------------------------------------
  // Markdown export (agent-friendly)
  // ---------------------------------------------------------------------------

  const EXPORT_REGION_ORDER = [
    "breadcrumb", "price", "availability", "buybox", "variants", "overview",
    "bullets", "details", "description", "aplus", "importantInfo", "rating",
    "reviews", "unscoped",
  ];

  function itemMarkdownLines(item) {
    const lines = [`- asin: ${item.asin} · ${item.url}`];
    const scrape = item.scrape || {};
    if (scrape.status === "ok" || scrape.status === "partial") {
      for (const key of EXPORT_REGION_ORDER) {
        const text = scrape.regions && scrape.regions[key];
        if (text) lines.push(`[${key}] ${text}`);
      }
      if (scrape.status === "partial") {
        lines.push(`[note] page structure not recognized — unscoped text included above`);
      }
    } else if (scrape.status === "pending") {
      lines.push(`[note] page scrape still in progress — only link metadata available`);
    } else {
      lines.push(`[note] page scrape failed (${scrape.reason || "unknown"}) — only link metadata available`);
    }
    return lines;
  }

  function buildMarkdown(items, projectName) {
    const lines = [
      `# ${projectName} — Amazon products (${items.length}) — exported ${new Date().toISOString().slice(0, 10)}`,
      "",
    ];
    items.forEach((item, idx) => {
      lines.push(`## ${idx + 1}. ${item.title}`, ...itemMarkdownLines(item), "");
    });
    return lines.join("\n");
  }

  function buildItemMarkdown(item) {
    return [`# ${item.title}`, ...itemMarkdownLines(item)].join("\n");
  }

  // ---------------------------------------------------------------------------
  // Floating bar UI (shadow DOM so Amazon CSS can't interfere)
  // ---------------------------------------------------------------------------

  const host = document.createElement("div");
  host.id = "amx-host";
  host.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483647;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
      .pill {
        display: flex; align-items: center; gap: 8px;
        background: #131921; color: #fff;
        border: 1px solid #ff9900; border-radius: 999px;
        padding: 8px 14px; cursor: pointer; user-select: none;
        font-size: 13px; box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      }
      .pill:hover { background: #232f3e; }
      .count {
        background: #ff9900; color: #131921; font-weight: 700;
        border-radius: 999px; min-width: 20px; height: 20px;
        display: inline-flex; align-items: center; justify-content: center;
        padding: 0 6px; font-size: 12px;
      }
      .panel {
        display: none; flex-direction: column;
        position: absolute; bottom: 44px; right: 0;
        width: 360px; max-height: 440px;
        background: #fff; color: #111;
        border: 1px solid #d5d9d9; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25); overflow: hidden;
      }
      .panel.open { display: flex; }
      .panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; background: #131921; color: #fff; font-size: 13px; font-weight: 600;
      }
      .panel-header .actions { display: flex; gap: 6px; }
      button {
        border: none; border-radius: 6px; padding: 4px 10px;
        font-size: 12px; cursor: pointer;
      }
      .btn-copy { background: #ff9900; color: #131921; font-weight: 700; }
      .btn-copy:hover { background: #ffb84d; }
      .btn-alt { background: #37475a; color: #fff; }
      .btn-alt:hover { background: #485769; }
      .projects-bar {
        display: flex; align-items: center;
        padding: 6px 8px; background: #f7f8f8; border-bottom: 1px solid #eee;
      }
      .btn-back { background: transparent; color: #007185; font-weight: 600; }
      .btn-back:hover { color: #131921; }
      .projects-view { display: none; flex-direction: column; overflow-y: auto; }
      .projects-view.open { display: flex; }
      .project-row {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 12px;
      }
      .project-row .pname {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; cursor: pointer;
      }
      .project-row .pname:hover { color: #007185; }
      .project-row input {
        flex: 1; min-width: 0; font-size: 12px; padding: 3px 6px;
        border: 1px solid #d5d9d9; border-radius: 4px;
      }
      .project-row .icon { background: transparent; color: #999; font-size: 13px; padding: 0 4px; }
      .project-row .icon:hover { color: #131921; }
      .project-row .icon.danger:hover { color: #cc0c39; }
      .add-row { display: flex; gap: 6px; padding: 8px 12px; }
      .add-row input {
        flex: 1; min-width: 0; font-size: 12px; padding: 4px 6px;
        border: 1px solid #d5d9d9; border-radius: 6px;
      }
      .btn-new {
        flex: 1; background: #fff; border: 1px dashed #aab7b8; color: #565959;
        padding: 6px; border-radius: 6px;
      }
      .btn-new:hover { border-color: #ff9900; color: #131921; }
      .btn-create { background: #ff9900; color: #131921; font-weight: 700; }
      .btn-create:hover { background: #ffb84d; }
      .btn-cancel { background: #37475a; color: #fff; }
      .btn-cancel:hover { background: #485769; }
      .list { overflow-y: auto; padding: 4px 0; }
      .item {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 12px;
      }
      .item:last-child { border-bottom: none; }
      .status { flex: none; width: 16px; text-align: center; font-size: 12px; margin-top: 1px; background: transparent; padding: 0; }
      .status.ok { color: #067d62; }
      .status.pending { color: #767676; cursor: pointer; }
      .status.bad { color: #cc0c39; cursor: pointer; }
      .item .info { flex: 1; min-width: 0; }
      .item .title {
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; line-height: 1.35;
      }
      .item .title a { color: #007185; text-decoration: none; }
      .item .title a:hover { text-decoration: underline; }
      .item .asin { color: #767676; font-size: 11px; margin-top: 2px; }
      .item .remove {
        background: transparent; color: #999; font-size: 14px; padding: 0 4px; line-height: 1;
      }
      .item .remove:hover { color: #cc0c39; }
      .item .copy-one {
        background: transparent; color: #999; font-size: 13px; padding: 0 4px; line-height: 1;
      }
      .item .copy-one:hover { color: #ff9900; }
      .empty { padding: 20px 12px; text-align: center; color: #767676; font-size: 12px; }
      .toast {
        position: absolute; bottom: 44px; right: 0;
        background: #131921; color: #fff; border-left: 3px solid #ff9900;
        padding: 8px 12px; border-radius: 6px; font-size: 12px;
        max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        opacity: 0; transition: opacity 0.2s; pointer-events: none;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      }
      .toast.show { opacity: 1; }
    </style>
    <div class="panel" id="panel">
      <div class="panel-header">
        <span id="panel-title">Projects</span>
        <span class="actions" id="actions">
          <button class="btn-copy" id="copy">Copy all</button>
          <button class="btn-alt" id="clear">Clear all</button>
        </span>
      </div>
      <div class="projects-bar" id="projects-bar">
        <button class="btn-back" id="back">← Projects</button>
      </div>
      <div class="projects-view" id="projects-view"></div>
      <div class="list" id="list"></div>
    </div>
    <div class="pill" id="pill">
      <span>🛒 Amazon2Agent</span>
      <span class="count" id="count">0</span>
    </div>
    <div class="toast" id="toast"></div>
  `;

  const $ = (id) => shadow.getElementById(id);
  const panel = $("panel");

  $("pill").addEventListener("click", () => {
    panel.classList.toggle("open");
  });

  // Selection IS navigation: opening a project's screen selects it; backing
  // out to the projects screen deselects. The screen shown is derived from
  // selectedId in renderAll(), so it stays in sync across tabs.
  $("back").addEventListener("click", async () => {
    const data = await getData();
    data.selectedId = null;
    await setData(data);
  });

  async function copyToClipboard(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch {
      toast("Copy failed — click the page first, then retry");
    }
  }

  $("copy").addEventListener("click", async () => {
    const data = await getData();
    const project = selectedProject(data);
    if (!project) return toast("Select a project first");
    const items = project.items;
    if (!items.length) return toast("Nothing to copy yet");
    const pendingCount = items.filter((i) => i.scrape && i.scrape.status === "pending").length;
    await copyToClipboard(
      buildMarkdown(items, project.name),
      pendingCount
        ? `Copied ${items.length} products (${pendingCount} still scraping)`
        : `Copied ${items.length} product${items.length === 1 ? "" : "s"}`
    );
  });

  // Clearing is destructive — first click arms the button, second click
  // (within 2.5s) actually wipes the selected project's list.
  let clearArmTimer = null;
  $("clear").addEventListener("click", async () => {
    const btn = $("clear");
    if (clearArmTimer === null) {
      const data = await getData();
      if (!selectedProject(data)) return toast("Select a project first");
      btn.textContent = "Sure?";
      clearArmTimer = setTimeout(() => {
        clearArmTimer = null;
        btn.textContent = "Clear all";
      }, 2500);
      return;
    }
    clearTimeout(clearArmTimer);
    clearArmTimer = null;
    btn.textContent = "Clear all";
    const data = await getData();
    const project = selectedProject(data);
    if (!project) return toast("Select a project first");
    project.items = [];
    await setData(data);
    toast(`Cleared: ${project.name}`);
  });

  // -------------------------------------------------------------------------
  // Project management (select / add / rename / delete)
  // -------------------------------------------------------------------------

  // The "New project" button expands in place into input + Create / Cancel.
  let addingProject = false;
  // Last rendered data, so local UI state changes can re-render without
  // another storage round-trip.
  let lastData = { projects: [], selectedId: null };

  async function addProjectFromInput() {
    const input = shadow.getElementById("new-project");
    const name = input ? input.value.trim() : "";
    if (!name) return toast("Give the project a name");
    addingProject = false;
    const data = await getData();
    const project = makeProject(name);
    data.projects.push(project);
    data.selectedId = project.id; // navigate straight into the new project
    await setData(data);
    toast(`Created project: ${name}`);
  }

  function cancelAddProject() {
    addingProject = false;
    renderProjects(lastData);
  }

  function startRename(id) {
    const row = shadow.querySelector(`.project-row[data-project="${CSS.escape(id)}"]`);
    const nameEl = row && row.querySelector(".pname");
    if (!nameEl) return;
    const input = document.createElement("input");
    input.value = nameEl.getAttribute("data-name") || "";
    input.maxLength = 60;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const data = await getData();
      const project = data.projects.find((p) => p.id === id);
      if (name && project && name !== project.name) {
        project.name = name;
        await setData(data); // storage listener re-renders
      } else {
        renderAll(data); // restore the untouched row
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        done = true;
        getData().then(renderAll);
      }
    });
    input.addEventListener("blur", commit);
  }

  // Deleting a project is destructive — same arm/confirm pattern as Clear all.
  const deleteArm = new Map(); // project id -> reset timer

  $("projects-view").addEventListener("click", async (e) => {
    if (e.target.id === "new-project-btn") {
      addingProject = true;
      renderProjects(lastData);
      shadow.getElementById("new-project").focus();
      return;
    }
    if (e.target.id === "add-create") return addProjectFromInput();
    if (e.target.id === "add-cancel") return cancelAddProject();
    const pick = e.target.closest("[data-select]");
    if (pick) {
      const data = await getData();
      data.selectedId = pick.getAttribute("data-select");
      await setData(data);
      return;
    }
    const rename = e.target.closest("[data-rename]");
    if (rename) return startRename(rename.getAttribute("data-rename"));
    const del = e.target.closest("[data-pdelete]");
    if (del) {
      const id = del.getAttribute("data-pdelete");
      if (!deleteArm.has(id)) {
        del.textContent = "Sure?";
        deleteArm.set(
          id,
          setTimeout(() => {
            deleteArm.delete(id);
            del.textContent = "✕";
          }, 2500)
        );
        return;
      }
      clearTimeout(deleteArm.get(id));
      deleteArm.delete(id);
      const data = await getData();
      const project = data.projects.find((p) => p.id === id);
      data.projects = data.projects.filter((p) => p.id !== id);
      if (data.selectedId === id) data.selectedId = null;
      await setData(data);
      toast(project ? `Deleted project: ${project.name}` : "Project deleted");
    }
  });

  $("projects-view").addEventListener("keydown", (e) => {
    if (e.target.id !== "new-project") return;
    e.stopPropagation();
    if (e.key === "Enter") addProjectFromInput();
    if (e.key === "Escape") cancelAddProject();
  });

  $("list").addEventListener("click", async (e) => {
    const retry = e.target.closest("[data-retry]");
    if (retry) {
      e.preventDefault();
      markPendingAndScrape(retry.getAttribute("data-retry"));
      return;
    }
    const copyOne = e.target.closest("[data-copy]");
    if (copyOne) {
      e.preventDefault();
      const data = await getData();
      const project = selectedProject(data);
      const item = project && project.items.find((i) => i.asin === copyOne.getAttribute("data-copy"));
      if (item) await copyToClipboard(buildItemMarkdown(item), `Copied: ${item.title}`);
      return;
    }
    const btn = e.target.closest("[data-remove]");
    if (btn) {
      e.preventDefault();
      await removeItem(btn.getAttribute("data-remove"));
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function statusHtml(item) {
    const s = (item.scrape && item.scrape.status) || "failed";
    if (s === "ok") return `<span class="status ok" title="Scraped">✓</span>`;
    if (s === "pending") {
      // Clickable in case a scrape was interrupted (e.g. browser closed mid-fetch).
      return `<button class="status pending" data-retry="${escapeHtml(item.asin)}" title="Scraping… click to re-run if stuck">⏳</button>`;
    }
    const reason = escapeHtml((item.scrape && item.scrape.reason) || (s === "partial" ? "page structure not recognized" : "scrape failed"));
    return `<button class="status bad" data-retry="${escapeHtml(item.asin)}" title="${reason} — click to retry">↻</button>`;
  }

  function renderProjects(data) {
    const view = $("projects-view");
    // Preserve a half-typed project name (and its focus) across background
    // re-renders, e.g. a scrape finishing while the user types.
    const prevInput = shadow.getElementById("new-project");
    const draft = prevInput ? prevInput.value : "";
    const hadFocus = prevInput && shadow.activeElement === prevInput;
    const rows = data.projects
      .map(
        (p) => `
        <div class="project-row" data-project="${escapeHtml(p.id)}">
          <span class="pname" data-select="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Open project">${escapeHtml(p.name)} (${p.items.length})</span>
          <button class="icon" data-rename="${escapeHtml(p.id)}" title="Rename">✎</button>
          <button class="icon danger" data-pdelete="${escapeHtml(p.id)}" title="Delete project">✕</button>
        </div>`
      )
      .join("");
    const addRow = addingProject
      ? `<div class="add-row">
          <input id="new-project" placeholder="Project name" maxlength="60">
          <button class="btn-create" id="add-create">Create</button>
          <button class="btn-cancel" id="add-cancel">Cancel</button>
        </div>`
      : `<div class="add-row"><button class="btn-new" id="new-project-btn">New project</button></div>`;
    view.innerHTML = `${rows || `<div class="empty">No projects yet</div>`}${addRow}`;
    if (addingProject) {
      const input = shadow.getElementById("new-project");
      input.value = draft;
      if (hadFocus) input.focus();
    }
    deleteArm.forEach((timer) => clearTimeout(timer));
    deleteArm.clear();
  }

  function renderAll(data) {
    lastData = data;
    const project = selectedProject(data);
    hasSelectedProject = !!project;
    document.documentElement.classList.toggle(NO_PROJECT_CLASS, !project);

    // Two screens: the projects screen (nothing selected), or the screen of
    // the selected project (its item list, with a back button).
    $("panel-title").textContent = project ? project.name : "Projects";
    $("actions").style.display = project ? "" : "none";
    $("projects-bar").style.display = project ? "" : "none";
    $("projects-view").classList.toggle("open", !project);
    $("list").style.display = project ? "" : "none";
    renderProjects(data);

    const items = project ? project.items : [];
    $("count").textContent = String(items.length);
    if (!project) return;
    const list = $("list");
    if (!items.length) {
      list.innerHTML = `<div class="empty">Nothing here yet — ⌥ Option/Alt + Click product links to add</div>`;
      return;
    }
    list.innerHTML = items
      .map(
        (i) => `
        <div class="item">
          ${statusHtml(i)}
          <div class="info">
            <div class="title"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a></div>
            <div class="asin">${escapeHtml(i.asin)}</div>
          </div>
          <button class="copy-one" data-copy="${escapeHtml(i.asin)}" title="Copy this item">⧉</button>
          <button class="remove" data-remove="${escapeHtml(i.asin)}" title="Remove">✕</button>
        </div>`
      )
      .join("");
  }

  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  // Keep UI in sync across tabs / after adds and scrape updates.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      renderAll(changes[STORAGE_KEY].newValue || { projects: [], selectedId: null });
    }
  });

  getData().then((data) => {
    renderAll(data);
    // Self-heal: a scrape lost in flight (service worker killed, tab closed
    // mid-load) leaves an item pending forever. Re-request any pending scrape
    // older than 2 minutes, across all projects; the worker's queue dedupes
    // repeat requests.
    const STALE_MS = 2 * 60 * 1000;
    const now = Date.now();
    const requested = new Set();
    for (const project of data.projects) {
      for (const i of project.items) {
        if (
          i.scrape &&
          i.scrape.status === "pending" &&
          (!i.scrape.requestedAt || now - Date.parse(i.scrape.requestedAt) > STALE_MS) &&
          !requested.has(i.asin)
        ) {
          requested.add(i.asin);
          markPendingAndScrape(i.asin);
        }
      }
    }
  });
})();
