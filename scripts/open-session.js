#!/usr/bin/env node
// Usage: node scripts/open-session.js <url> <user_data_dir> [proxy_url]
// Launches a headed browser for manual login. Stays open until killed.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const [,, url, userDataDir, proxyUrl] = process.argv;

if (!url || !userDataDir) {
  console.error('Usage: open-session.js <url> <user_data_dir> [proxy_url]');
  process.exit(1);
}

// Remove stale Chromium lock files — use unlinkSync directly because
// SingletonLock is a symlink and fs.existsSync returns false for broken symlinks
['SingletonLock', 'SingletonCookie', 'SingletonSocket'].forEach(f => {
  try { fs.unlinkSync(path.join(userDataDir, f)); console.log(`✦ Removed stale ${f}`); }
  catch (e) { if (e.code !== 'ENOENT') console.log(`✦ Note: could not remove ${f}: ${e.code}`); }
});

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
    // Playwright needs credentials separated — parse user:pass@host:port or http://user:pass@host:port
    let proxyStr = proxyUrl;
    if (!proxyStr.includes('://')) proxyStr = 'http://' + proxyStr;
    try {
      const parsed = new URL(proxyStr);
      options.proxy = { server: `${parsed.protocol}//${parsed.host}` };
      if (parsed.username) options.proxy.username = decodeURIComponent(parsed.username);
      if (parsed.password) options.proxy.password = decodeURIComponent(parsed.password);
      console.log(`✦ Proxy: ${parsed.host} (credentials set)`);
    } catch {
      // Fallback: pass as-is
      options.proxy = { server: proxyUrl };
    }
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
