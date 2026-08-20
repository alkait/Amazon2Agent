# Amazon2Agent

**Turn Amazon product pages into agent-ready context — collect, scrape, and copy as Markdown for your AI chat.**

Comparing products with an AI assistant usually means pasting one messy page
dump after another: navigation junk, half the specs missing, and a context
window full of noise. Amazon2Agent fixes that. Collect the products you're
considering while you browse, and get back a compact, clean Markdown brief —
titles, prices, specs, bullets, ratings, and review excerpts — ready to paste
into Claude, ChatGPT, or any assistant.

## Why you'll want it

- **Collect without breaking your flow.** Hold **Alt** (**Option ⌥** on Mac)
  and click any product link — from search results, listings, or
  recommendations. No new tabs, no copy-paste, no leaving the page.
- **Organize by decision, not by tab chaos.** Group products into projects like
  *"Standing desk research"* or *"Gifts"*. Every project keeps its own list,
  synced across all your Amazon tabs.
- **Get the whole page, not a link.** Each product's full page is fetched and
  distilled in the background — price, availability, seller info, variants,
  feature bullets, specs, description, and top reviews — trimmed to a few
  thousand relevant tokens instead of a raw page dump.
- **One click to your AI chat.** **Copy all** exports the whole project as
  clean Markdown. Paste it into your assistant and ask: *"Which of these fits
  me best?"*
- **Private by design.** Everything lives in your browser's local storage. No
  accounts, no servers, no tracking.

## What the export looks like

```markdown
# Standing desk research — Amazon products (2) — exported 2026-08-20

## 1. Sony WH-1000XM5 Wireless Noise Canceling Headphones
- asin: B09XS7JWHH · https://www.amazon.com/dp/B09XS7JWHH
[price] $328.00 ...
[availability] In Stock
[bullets] 30-hr battery • Industry-leading noise cancellation • ...
[details] Weight 250g | Bluetooth 5.2 | ...
[rating] 4.7 out of 5 stars 41,203 ratings
[reviews] top review excerpts...
```

## Getting started

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder
4. Visit Amazon, open the **🛒 pill** (bottom-right), create a project
5. **Alt+Click** product links to collect — then **Copy all** and paste into
   your AI chat

Works on all major Amazon marketplaces (.com, .co.uk, .de, .fr, .co.jp, .in,
.ae, .sa, and more).
