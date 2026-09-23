'use strict';

/**
 * Permanent regression suite for lib/verification-evidence.js, replacing the ad hoc manual
 * smoke tests used during development with a repeatable one anyone can run via `npm test`.
 * Uses Node's built-in test runner (node:test) — no new dependency, and the project already
 * requires Node >=18 (see package.json engines), which guarantees it's available.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const ev = require('../lib/verification-evidence.js');

describe('verification-evidence.js', () => {
  let browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it('captureAccessibilityAlerts detects an explicit role=alert region', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body><div role="alert">Something went wrong</div><button>OK</button></body></html>');
      const alerts = await ev.captureAccessibilityAlerts(page);
      assert.ok(alerts.some((a) => a.startsWith('alert')), 'expected an alert-role entry, got: ' + JSON.stringify(alerts));
    } finally {
      await page.close();
    }
  });

  it('captureAccessibilityAlerts returns an empty array when no alert is present', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body><h1>All good</h1></body></html>');
      const alerts = await ev.captureAccessibilityAlerts(page);
      assert.deepStrictEqual(alerts, []);
    } finally {
      await page.close();
    }
  });

  it('hasAlertRegion / alertCleared / hasNewFailureSignal reflect before/after transitions', () => {
    const withAlert = { network: { consoleErrors: [], failedResponses: [] }, alerts: ['alert: Something went wrong'] };
    const withoutAlert = { network: { consoleErrors: [], failedResponses: [] }, alerts: [] };

    assert.strictEqual(ev.hasAlertRegion(withAlert), true);
    assert.strictEqual(ev.hasAlertRegion(withoutAlert), false);
    assert.strictEqual(ev.alertCleared(withAlert, withoutAlert), true);
    assert.strictEqual(ev.alertCleared(withoutAlert, withAlert), false);
    // alert appearing where there was none before = a new failure signal
    assert.strictEqual(ev.hasNewFailureSignal(withoutAlert, withAlert), true);
    // alert disappearing is not itself a "new failure signal"
    assert.strictEqual(ev.hasNewFailureSignal(withAlert, withoutAlert), false);
  });

  it('captureNetworkEvidence captures a console error', async () => {
    const page = await browser.newPage();
    try {
      ev.captureNetworkEvidence(page); // registers listeners once for this page
      await page.setContent('<html><body></body></html>');
      await page.evaluate(() => console.error('synthetic test error'));
      await page.waitForTimeout(150);
      const bundle = ev.captureNetworkEvidence(page);
      assert.strictEqual(bundle.consoleErrors.length, 1);
      assert.ok(bundle.consoleErrors[0].includes('synthetic test error'));
    } finally {
      await page.close();
    }
  });

  it('captureNetworkEvidence captures a real non-2xx HTTP response', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/bad.json') { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><script>fetch("/bad.json").catch(()=>{});</script><h1>ok</h1></body></html>');
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const page = await browser.newPage();
    try {
      ev.captureNetworkEvidence(page);
      await page.goto('http://127.0.0.1:' + port + '/');
      await page.waitForTimeout(300);
      const bundle = ev.captureNetworkEvidence(page);
      assert.strictEqual(bundle.failedResponses.length, 1);
      assert.ok(bundle.failedResponses[0].startsWith('404'));
    } finally {
      await page.close();
      server.close();
    }
  });

  it('toStructured() produces a JSON-serializable, summarize()-consistent shape', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body><div role="alert">Epic sadface</div></body></html>');
      const evidence = await ev.captureEvidence(page);
      const structured = ev.toStructured(evidence);
      assert.ok(Array.isArray(structured.alerts) && structured.alerts.length === 1);
      assert.strictEqual(typeof structured.consoleErrorCount, 'number');
      assert.strictEqual(typeof structured.failedResponseCount, 'number');
      assert.doesNotThrow(() => JSON.stringify(structured));
    } finally {
      await page.close();
    }
  });
});
