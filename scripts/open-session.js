#!/usr/bin/env node
// Usage: node scripts/open-session.js <url> <user_data_dir> [proxy_url]
// Launches a headed browser for manual login. Stays open until killed.

const { chromium } = require('playwright');

const [,, url, userDataDir, proxyUrl] = process.argv;

if (!url || !userDataDir) {
  console.error('Usage: open-session.js <url> <user_data_dir> [proxy_url]');
  process.exit(1);
}

(async () => {
  const options = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  };

  if (proxyUrl) {
    options.proxy = { server: proxyUrl };
  }

  console.log(`✦ Opening browser → ${url}`);
  if (proxyUrl) console.log(`✦ Using proxy: ${proxyUrl}`);

  const context = await chromium.launchPersistentContext(userDataDir, options);

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    console.error(`✦ Navigation error: ${err.message}`);
  }

  console.log('✦ Browser ready — log in then click Done in the admin panel');

  // Stay alive until killed by the server
  await new Promise(() => {});
})().catch(err => {
  console.error('✦ Session failed:', err.message);
  process.exit(1);
});
