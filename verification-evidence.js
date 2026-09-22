'use strict';

/**
 * Multi-signal evidence collection for the RunPilot Stagehand runner's verification cascade
 * (verifyStepExpected() in runpilot-stagehand.js). Mirrors the Java-side VerificationEvidence
 * used by the legacy keyword engine: pure evidence collection, never decides pass/fail itself,
 * and fails closed (returns an empty/inert bundle, never throws) whenever a signal can't be read.
 */

const ALERT_LINE = /^(alert|status|alertdialog)\s*(?:"([^"]*)")?/i;

// One listener-state entry per page, so page.on() is registered exactly once per page instance
// even though captureNetworkEvidence() may be called many times during a run.
const listenerState = new WeakMap();

function ensureNetworkListeners(page) {
  if (!page || listenerState.has(page)) return;
  const state = { consoleErrors: [], failedResponses: [] };
  listenerState.set(page, state);
  try {
    page.on('console', (msg) => {
      try {
        if (msg.type() === 'error') {
          state.consoleErrors.push(String(msg.text() || '').slice(0, 300));
          if (state.consoleErrors.length > 5) state.consoleErrors.shift();
        }
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* page may not support console events in this context */ }
  try {
    page.on('response', (resp) => {
      try {
        const status = resp.status();
        if (status >= 400) {
          state.failedResponses.push(status + ' ' + resp.url().slice(0, 200));
          if (state.failedResponses.length > 5) state.failedResponses.shift();
        }
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* ignore */ }
}

/**
 * Registers (once) console/network listeners on this page and returns a snapshot of the
 * rolling recent-error buffers. Never throws.
 */
function captureNetworkEvidence(page) {
  try {
    ensureNetworkListeners(page);
    const state = listenerState.get(page) || { consoleErrors: [], failedResponses: [] };
    return {
      consoleErrors: state.consoleErrors.slice(),
      failedResponses: state.failedResponses.slice(),
    };
  } catch (_) {
    return { consoleErrors: [], failedResponses: [] };
  }
}

/**
 * Captures accessibility-tree alert/status/alertdialog regions via Playwright's public
 * ariaSnapshot() API — the same approach used by playwright-mcp-runtime/lib/snapshot.js and
 * the Java-side AccessibilityMatcher. Catches implicit-role cases the existing [role="alert"]
 * CSS-attribute selectors elsewhere in this file miss. Never throws.
 */
async function captureAccessibilityAlerts(page) {
  const alerts = [];
  try {
    const yaml = await page.locator('body').ariaSnapshot();
    for (const rawLine of String(yaml || '').split('\n')) {
      let line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('-')) line = line.slice(1).trim();
      const m = ALERT_LINE.exec(line);
      if (m) {
        const role = m[1].toLowerCase();
        const name = m[2];
        alerts.push(role + (name ? ': ' + name : ''));
      }
    }
  } catch (_) {
    // Accessibility tree unavailable in this context — degrade to no alerts, never throw.
  }
  return alerts;
}

/** Captures the full evidence bundle (network + accessibility) in one call. Never throws. */
async function captureEvidence(page) {
  const network = captureNetworkEvidence(page);
  const alerts = await captureAccessibilityAlerts(page);
  return { network, alerts };
}

function hasAlertRegion(evidence) {
  return !!(evidence && evidence.alerts && evidence.alerts.length > 0);
}

/** True when new console errors, new failed responses, or a new alert region appeared. */
function hasNewFailureSignal(before, after) {
  if (!before || !after) return false;
  const newConsoleErrors = after.network.consoleErrors.length > before.network.consoleErrors.length;
  const newFailedResponses = after.network.failedResponses.length > before.network.failedResponses.length;
  const newAlert = !hasAlertRegion(before) && hasAlertRegion(after);
  return newConsoleErrors || newFailedResponses || newAlert;
}

/** True when an alert region that was present before is gone now, with no new failure signal. */
function alertCleared(before, after) {
  return !!(before && after && hasAlertRegion(before) && !hasAlertRegion(after));
}

/** Compact, human-readable summary line for rlog(). */
function summarize(evidence) {
  if (!evidence) return 'none';
  const parts = ['alerts=' + (hasAlertRegion(evidence) ? evidence.alerts.join(' | ') : 'none')];
  if (evidence.network.consoleErrors.length) {
    parts.push('consoleErrors=' + evidence.network.consoleErrors.length);
  }
  if (evidence.network.failedResponses.length) {
    parts.push('failedResponses=[' + evidence.network.failedResponses.join(', ') + ']');
  }
  return parts.join('; ');
}

module.exports = {
  captureNetworkEvidence,
  captureAccessibilityAlerts,
  captureEvidence,
  hasAlertRegion,
  hasNewFailureSignal,
  alertCleared,
  summarize,
};
