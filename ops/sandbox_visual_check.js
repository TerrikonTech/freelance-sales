'use strict';

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer-core');

async function main() {
  const publicBase = process.env.PUBLIC_URL || 'https://vds.31-77-76-226.sslip.io:80/sales';
  const screenshotDir = process.env.SCREENSHOT_DIR || '/tmp';
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const user = (await db.query('SELECT id,email FROM users ORDER BY created_at LIMIT 1')).rows[0];
  await db.end();
  if (!user) throw new Error('Admin user is missing');
  const token = jwt.sign(
    { sub: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '15m', issuer: 'freelance-sales-v2' },
  );
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setCookie({ name: 'fs_session', value: token, url: publicBase, httpOnly: true, secure: true, sameSite: 'Strict' });
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(`${publicBase}/?page=sandbox`, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForSelector('.sandboxPage', { timeout: 30_000 });
    await page.waitForFunction(() => document.body.innerText.includes('13 из 13'), { timeout: 30_000 });
    const desktop = await page.evaluate(() => ({
      title: document.querySelector('.sandboxPage h1')?.textContent,
      progress: document.querySelector('.sandboxProgress b')?.textContent,
      lock: document.querySelector('.sandboxLock')?.textContent,
      reportTitle: document.querySelector('.sandboxReport h2')?.textContent,
      protocolSteps: document.querySelectorAll('.sandboxProtocolList article').length,
      flMessages: document.querySelectorAll('.sandboxThread article').length,
      documents: document.querySelectorAll('.sandboxDocuments details').length,
      designs: document.querySelectorAll('.sandboxDesigns img').length,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    await page.screenshot({ path: `${screenshotDir}/freelance-sandbox-desktop.png`, fullPage: true });

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.reload({ waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForSelector('.sandboxPage', { timeout: 30_000 });
    await page.waitForFunction(() => document.body.innerText.includes('13 из 13'), { timeout: 30_000 });
    const mobile = await page.evaluate(() => ({
      progress: document.querySelector('.sandboxProgress b')?.textContent,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      navItems: document.querySelectorAll('nav button').length,
      protocolSteps: document.querySelectorAll('.sandboxProtocolList article').length,
      documents: document.querySelectorAll('.sandboxDocuments details').length,
      layout: Object.fromEntries(['html','body','.shell','main','.sandboxPage','.sandboxRuns','.sandboxWorkspace','.sandboxActivityLog'].map((selector) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return [selector, element ? { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), overflowX: getComputedStyle(element).overflowX } : null];
      })),
      overflowElements: Array.from(document.querySelectorAll('body *')).map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, className: element.className, left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: element.scrollWidth };
      }).filter((item) => item.right > window.innerWidth + 1 || item.left < -1).slice(0, 12),
    }));
    await page.screenshot({ path: `${screenshotDir}/freelance-sandbox-mobile.png`, fullPage: true });
    if (desktop.overflow || mobile.overflow || errors.length || desktop.protocolSteps !== 13 || mobile.protocolSteps !== 13 || desktop.designs < 2 || desktop.documents < 3) {
      throw new Error(JSON.stringify({ desktop, mobile, errors }));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, desktop, mobile, errors }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
