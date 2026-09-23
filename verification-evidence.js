'use strict';

/**
 * Multi-signal evidence collection for the RunPilot Stagehand runner's verification cascade
 * (verifyStepExpected() in runpilot-stagehand.js). Mirrors the Java-side VerificationEvidence
 * used by the legacy keyword engine: pure evidence collection, never decides pass/fail itself,
 * and fails closed (returns an empty/inert bundle, never throws) whenever a signal can't be read.
 */

const ALERT_ROLES = ['alert', 'status', 'alertdialog'];

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
 * getByRole() query API — querying each role directly rather than snapshotting the whole
 * subtree as text and parsing it. This is more robust (no text-format parsing that could drift
 * across Playwright versions) and faster than the earlier ariaSnapshot()-based implementation,
 * while returning the exact same shape (array of "role" or "role: name" strings) so every
 * caller in this file is unaffected. Catches implicit-role cases the existing [role="alert"]
 * CSS-attribute selectors elsewhere in this file miss. Never throws.
 */
async function captureAccessibilityAlerts(page) {
  const alerts = [];
  for (const role of ALERT_ROLES) {
    try {
      const locator = page.getByRole(role);
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        let name = '';
        try {
          name = String((await locator.nth(i).textContent()) || '').trim();
        } catch (_) { /* this node's name couldn't be read — still record the role hit */ }
        alerts.push(role + (name ? ': ' + name : ''));
      }
    } catch (_) {
      // This role query failed in this context — degrade to no alerts for this role, never throw.
    }
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

/**
 * Compact, structured (JSON-serializable) view of an evidence bundle — the same information
 * summarize() renders as a human-readable line, shaped for machine parsing / future cross-run
 * analytics instead. Callers append `JSON.stringify(toStructured(evidence))` alongside the
 * existing summarize() text on the same rlog() line, so today's log format stays backward
 * compatible while becoming additionally queryable.
 */
function toStructured(evidence) {
  if (!evidence) return null;
  return {
    alerts: hasAlertRegion(evidence) ? evidence.alerts.slice() : [],
    consoleErrorCount: evidence.network.consoleErrors.length,
    failedResponseCount: evidence.network.failedResponses.length,
  };
}

module.exports = {
  captureNetworkEvidence,
  captureAccessibilityAlerts,
  captureEvidence,
  hasAlertRegion,
  hasNewFailureSignal,
  alertCleared,
  summarize,
  toStructured,
};
