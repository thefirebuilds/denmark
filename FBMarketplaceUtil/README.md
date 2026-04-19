# FB Marketplace Utility

This folder is a semi-custom, ad hoc Google Chrome extension for pulling Facebook Marketplace vehicle listings into the local Denmark app. It is built for this repo and this workflow, not as a polished public extension.

The extension does not store Facebook credentials. It uses the current Chrome profile and whatever Facebook session is already active in that browser. In practice, that means you sign into Facebook normally, open Marketplace in Chrome, and the extension reads pages you are already allowed to view.

## What It Does

- Adds listing-page controls on `facebook.com/marketplace/item/...`.
- Scrapes visible Marketplace search result cards when you click the extension icon.
- Enriches individual listing detail pages and posts the extracted data to Denmark.
- Talks to the local Denmark API at:
  - `http://localhost:5000`
  - `http://127.0.0.1:5000`
  - `http://localhost:3001`
  - `http://127.0.0.1:3001`

## Install In Chrome

1. Start the Denmark backend locally so the Marketplace API routes are available.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder: `FBMarketplaceUtil`.
6. Pin **Marketplace Exporter** if you want quick access from the toolbar.

If you edit files in this folder, return to `chrome://extensions` and click the extension's reload button before testing again.

## Configure Credentials / Session

There are no extension-specific credentials to configure.

Use the Chrome profile that is currently signed into the Facebook account you want to use. If Marketplace shows a login screen, checkpoint, blocked page, or a different account than expected, fix that in Chrome first. The extension will only see what that active browser session can see.

For Denmark itself, configure the normal app/backend `.env` files. The extension only needs the local API reachable on one of the localhost ports listed above.

## Basic Usage

### Search Results

1. Open a Facebook Marketplace vehicle search page in Chrome.
2. Click the **Marketplace Exporter** extension icon.
3. The extension scrolls the visible results, extracts listing cards, and posts them to `/api/marketplace/ingest`.

### Listing Details

1. Open a listing detail page like `https://www.facebook.com/marketplace/item/...`.
2. Use **Enrich -> DB** to scrape the detail page and post it to `/api/marketplace/enrich`.
3. Use **Ignore (hide)** when a listing should be hidden from the local Marketplace panel.

The Denmark Marketplace panel can also ask the extension to enrich visible listings. That path opens listing tabs in the same signed-in Chrome profile and closes them after processing.

## Safety And Bot Warning

Use this like an assisted browser tool, not a bot.

Do not run it headless. Do not use it to bypass Facebook login, rate limits, access controls, checkpoints, or Marketplace restrictions. Do not crank up unattended automation, parallel tab storms, or scrape accounts/pages you should not access. Facebook can and does restrict accounts for suspicious automation.

Keep usage human-paced:

- Run it from a normal visible Chrome window.
- Stay signed in with your own account.
- Enrich small batches.
- Stop if Facebook shows warnings, checkpoints, degraded pages, or unusual behavior.
- Treat extracted listing data as operational leads, not guaranteed facts.

This utility exists to reduce manual copy/paste into the local app. It is not meant for bulk harvesting or adversarial automation.
