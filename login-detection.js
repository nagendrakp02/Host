'use strict';

/**
 * App-agnostic, DOM-evidence-based login/fill-state detection shared by the RunPilot Stagehand
 * runner. Extracted into its own module (rather than living inline in runpilot-stagehand.js) so
 * it can be unit-tested directly instead of only exercised as part of a full test-case run.
 */

/**
 * Strongest, app-agnostic evidence that an unauthenticated login form is currently on screen:
 * a visible password field plus a visible Login/Sign-in control. Reads both text content AND
 * the `value` attribute so `<input type="submit" value="Login">`-style buttons (no innerText/
 * textContent of their own — e.g. saucedemo's actual login button) are recognized, not just
 * `<button>Login</button>`-style markup. Fails closed (false = "can't prove it either way").
 */
async function hasVisibleLoginForm(page) {
  try {
    return await page.evaluate(() => {
      const pwd = document.querySelector('input[type="password"]');
      const pwdVisible = !!(pwd && pwd.offsetHeight > 0
        && window.getComputedStyle(pwd).display !== 'none'
        && window.getComputedStyle(pwd).visibility !== 'hidden');
      const clickables = Array.from(document.querySelectorAll(
        'button, a, [role="button"], [type="submit"], [type="button"]'
      ));
      const loginBtn = clickables.some((el) => {
        const t = ((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '') + '').trim();
        return /^(login|sign in|sign-in|log in)$/i.test(t) && el.offsetHeight > 0;
      });
      return pwdVisible && loginBtn;
    });
  } catch (_) {
    return false;
  }
}

/**
 * True when `intendedValue` is present as the value of some visible, non-hidden input/textarea
 * on the page (password fields are checked for non-empty rather than exact match, since some
 * apps mask/transform the raw value). Used as a defense-in-depth check that a typed value
 * actually landed in the DOM, independent of a step's `expected`-text wording. Returns null
 * (not false) on error — callers should treat null as "couldn't check", not "value missing".
 */
async function fieldHasValue(page, intendedValue) {
  try {
    return await page.evaluate((val) => {
      const els = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea'));
      return els.some((el) => {
        if (el.type === 'password') return !!(el.value && el.value.length);
        const v = String(el.value || '').trim();
        const want = String(val).trim();
        return !!v && (v === want || v.includes(want.slice(0, 24)) || want.includes(v.slice(0, 24)));
      });
    }, intendedValue);
  } catch (_) {
    return null;
  }
}

module.exports = { hasVisibleLoginForm, fieldHasValue };
