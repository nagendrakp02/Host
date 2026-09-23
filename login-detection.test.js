'use strict';

/**
 * Permanent regression suite for lib/login-detection.js. `hasVisibleLoginForm`'s CASE 1 below
 * is the exact regression test for the real, confirmed bug found this session: saucedemo's
 * actual login button is `<input type="submit" value="Login">`, whose visible label lives in
 * the `value` attribute, not innerText/textContent — the original detection code read neither
 * `.value` nor that markup pattern, so it never recognized a real login form was on screen and
 * silently skipped filling the credential fields.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { hasVisibleLoginForm, fieldHasValue } = require('../lib/login-detection.js');

describe('login-detection.js', () => {
  let browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  describe('hasVisibleLoginForm', () => {
    it('detects a saucedemo-style <input type=submit value=Login> login form (regression case)', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(
          '<html><body>'
          + '<input type="password" id="password">'
          + '<input type="submit" value="Login" id="login-button">'
          + '</body></html>'
        );
        assert.strictEqual(await hasVisibleLoginForm(page), true);
      } finally {
        await page.close();
      }
    });

    it('detects a classic <button>Login</button> login form', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<html><body><input type="password"><button>Login</button></body></html>');
        assert.strictEqual(await hasVisibleLoginForm(page), true);
      } finally {
        await page.close();
      }
    });

    it('returns false when no password field is present (already-authenticated page)', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<html><body><h1>Welcome</h1><button>Logout</button></body></html>');
        assert.strictEqual(await hasVisibleLoginForm(page), false);
      } finally {
        await page.close();
      }
    });
  });

  describe('fieldHasValue', () => {
    it('returns true when the intended value is present in a field', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<html><body><input id="user-name" type="text" value="standard_user"></body></html>');
        assert.strictEqual(await fieldHasValue(page, 'standard_user'), true);
      } finally {
        await page.close();
      }
    });

    it('returns false when the field is empty (regression case for the credential-skip bug)', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<html><body><input id="user-name" type="text" value=""></body></html>');
        assert.strictEqual(await fieldHasValue(page, 'standard_user'), false);
      } finally {
        await page.close();
      }
    });

    it('treats a non-empty password field as a match without comparing the raw value', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<html><body><input id="password" type="password" value="secret_sauce"></body></html>');
        assert.strictEqual(await fieldHasValue(page, 'secret_sauce'), true);
      } finally {
        await page.close();
      }
    });
  });
});
