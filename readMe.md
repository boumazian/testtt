
# 🚀 ReaLift SDK — Auto QA Runner

An autonomous Playwright-based QA automation framework built to perform end-to-end audit sweeps on Shopify storefronts. It automatically verifies the integration, rendering, and proper scope of the **ReaLift 3D Foot Scan SDK** across all product pages (PDPs).

---

## 🛠️ Key Features

* **Automated Catalog Discovery:** Fetches the full product list dynamically from Shopify storefronts.
* **Smart Classification:** Intelligently categorizes products into **Footwear** (positive scope) and **Non-Footwear** (negative scope).
* **Shadow DOM Verification:** Validates that `<realift-button>` renders correctly inside its Shadow Root.
* **False-Positive Prevention:** Re-verifies flagged failures in a clean context to rule out network flakiness.
* **Automated Reporting:** Generates execution CSVs, a clean Markdown summary, and ready-to-use Jira markup.

---

## 📦 Requirements

* **Node.js** (v18 or higher recommended)

---

## ⚡ Setup & Installation

Clone this repository to your local machine, then install the required dependencies and Playwright browser binaries:

```bash
npm install
npx playwright install chromium



1. Headless Mode (Standard Run)
Runs the test suite silently in the background:
node auto-qa-runner.mjs "https://your-shopify-preview-link.shopifypreview.com"



2. Headed Mode (Visual Inspection)
Launches a visible Chromium window so you can watch the audit in real-time:
node auto-qa-runner.mjs "https://your-shopify-preview-link.shopifypreview.com" --headed



Track Test Progress

nohup node auto-qa-runner.mjs "https://mpnt2j1w4hdz2k2b-20780321.shopifypreview.com" --settle 25000 --settle-negative 10000 --limit 50 > /home/fadouabo/test-qa/fresh-test.log 2>&1 &


tail -f /home/fadouabo/test-qa/fresh-test.log
