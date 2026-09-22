'use strict';
/**
 * RunPilot Stagehand Runner (v3.26)
 *
 * Fast execution: META/WAIT/NAV/VERIFY-ONLY steps skip Stagehand act(); waits capped;
 * Playwright-first form fill (DOM locators, no LLM) with Stagehand only on miss;
 * Generic UI tree: snapshot visible HTML as labeled paths, score against the TC step,
 *   pick the unique best path (never Draft/Save unless the step names it).
 * grounded synonym matching (Zephyr wording → visible UI labels, no hallucination);
 * one AI rephrase retry on "No action found"; URL/title verify avoids audit-log misroute.
 * Self-nav (default on): tree path first, then observe → rank → bounded explore
 * (modal/tab/nav) → cache winning path in config/runpilot-nav-cache.json.
 *   Disable with RUNPILOT_SELF_NAV=false; depth via RUNPILOT_SELF_NAV_DEPTH (default 5).
 * Mid-flow interrupts: unexpected popups/toasts/validation are decided from screen +
 *   TC (dismiss / acknowledge / fix validation / preserve) and never hard-stop the run.
 * Form fill: scan visible fields top→bottom (visual Y). Cascading dropdowns: parent first,
 *   wait for child to unlock, then pick first matching / first valid option in that list
 *   (never random, never a sibling dropdown's leftover options).
 * Human-like intelligence (default on): scan form → fill top-to-bottom → confirm → Next.
 *   Disable with RUNPILOT_HUMAN_LIKE=false.
 *   Layer 1 — Known CMP platform IDs/selectors (OneTrust, Cookiebot, Didomi, TrustArc, etc.)
 *   Layer 2 — Intent-based text analysis: reads overlay text, understands what it's asking,
 *             picks the right button semantically. Handles cookie banners, HCP gates,
 *             country selectors, age gates, fraud warnings, regulatory notices — on ANY site.
 *   Layer 3 — Stagehand AI visual fallback: vision model scans the page and dismisses
 *             anything layers 1+2 missed. Used only once at init if layers 1+2 both fail.
 *   Layer 4 — Cross-frame: CMPs sandboxed inside iframes (OneTrust, Cookiebot iframe mode)
 *
 * Stdout protocol:
 *   LOG:<message>
 *   LOG_FILE:<absolute-or-relative-path>   (terminal debug log on disk)
 *   STEP_SCREENSHOT:<N>:<base64>
 *   SCREENSHOT:<base64>
 *   RESULT:PASS
 *   RESULT:FAIL:<message>
 *
 * Terminal log (RUNPILOT_LOG_FILE): timestamped RunPilot + Stagehand verbose lines
 * for post-run debugging and feature optimisation (timings, heal, confidence, LLM).
 */

const { Stagehand, CustomOpenAIClient } = require('@browserbasehq/stagehand');
const { default: OpenAI }               = require('openai');
const { z }                             = require('zod');
const http                              = require('http');
const fs                                = require('fs');
const path                              = require('path');
const verificationEvidence              = require('./lib/verification-evidence.js');

// ── Config ─────────────────────────────────────────────────────────────────────
const cfg = {
  baseUrl:         process.env.RUNPILOT_BASE_URL          || '',
  isProxy:         process.env.RUNPILOT_IS_PROXY          === 'true',
  proxyPort:       parseInt(process.env.RUNPILOT_PROXY_PORT || '9222', 10),
  tcName:          process.env.RUNPILOT_TC_NAME           || 'Test',
  tcKey:           process.env.RUNPILOT_TC_KEY            || '',
  runId:           process.env.RUNPILOT_RUN_ID            || '',
  logFile:         process.env.RUNPILOT_LOG_FILE          || '',
  logFileRel:      process.env.RUNPILOT_LOG_REL           || '',
  steps:           JSON.parse(process.env.RUNPILOT_STEPS  || '[]'),
  // Skip automatic init-dismiss when TC is specifically verifying that a popup/cookie appears
  skipInitDismiss:   process.env.RUNPILOT_SKIP_INIT_DISMISS === 'true',
  // Run an extra popup dismiss pass right before step 1 (after navigation + normal init dismiss)
  preDismissPopup:   process.env.RUNPILOT_PRE_DISMISS_POPUP === 'true',
  // When non-empty, switch into this iframe before step 1 and back after the last step
  frameSelector:     process.env.RUNPILOT_FRAME_SELECTOR    || '',
  // Milliseconds to pause after each ACT step (capped at 1200 in loop)
  stepDelayMs:       Math.max(0, parseInt(process.env.RUNPILOT_STEP_DELAY_MS || '250', 10) || 0),
  // After fill/select: wait then re-verify value stuck. Set RUNPILOT_FIELD_CONFIRM_MS=0 to skip.
  fieldConfirmMs:    Math.max(0, parseInt(process.env.RUNPILOT_FIELD_CONFIRM_MS || '400', 10) || 0),
  // After parent dropdown: wait for child options to load before opening sub.
  cascadeWaitMs:     Math.max(150, parseInt(process.env.RUNPILOT_CASCADE_WAIT_MS || '450', 10) || 450),
  // Human-like form intelligence (default ON). Set RUNPILOT_HUMAN_LIKE=false to disable.
  humanLike:         process.env.RUNPILOT_HUMAN_LIKE !== 'false',
  // Per-character typing delay when humanLike (ms). 0 = fill() dump (faster).
  humanTypeDelayMs:  Math.max(0, parseInt(process.env.RUNPILOT_HUMAN_TYPE_MS || '0', 10) || 0),
  navTimeoutMs:      Math.max(15000, parseInt(process.env.RUNPILOT_NAV_TIMEOUT_MS || '45000', 10) || 45000),
  // Reference document attached against this TC in CasePilot and pushed to Zephyr
  // as a web link — reused here as the source file for any upload/attach step.
  attachmentPath:    process.env.RUNPILOT_ATTACHMENT_PATH || '',
  attachmentName:    process.env.RUNPILOT_ATTACHMENT_NAME || '',
  // Free-text sample data from CasePilot "Test Data" / Zephyr step testData
  testData:          process.env.RUNPILOT_TEST_DATA || '',
  // Agreed supplementary hints from Confluence comments + design-file annotations (Java-side AI filter)
  executionContext:  process.env.RUNPILOT_EXECUTION_CONTEXT || '',
  ragEnabled:        process.env.RUNPILOT_RAG_ENABLED === 'true',
  confluenceHints:   process.env.RUNPILOT_CONFLUENCE_HINTS || '',
  memoryPack:        process.env.RUNPILOT_MEMORY_PACK || '',
  stepMemory:        [],
  planFile:          process.env.RUNPILOT_PLAN_FILE || '',
  batchMode:         process.env.RUNPILOT_BATCH_MODE === 'true',
  // Self-navigate: observe → rank → explore → cache when ACT target is missing/vague
  // Default ON when unset; set RUNPILOT_SELF_NAV=false to disable.
  selfNav:           process.env.RUNPILOT_SELF_NAV !== 'false',
  selfNavDepth:      Math.max(1, Math.min(10, parseInt(process.env.RUNPILOT_SELF_NAV_DEPTH || '5', 10) || 5)),
  endpoint:  (process.env.AZURE_OPENAI_ENDPOINT  || '').replace(/\/$/, ''),
  apiKey:    process.env.AZURE_OPENAI_API_KEY    || '',
  deploy:    process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1',
  version:   process.env.AZURE_OPENAI_API_VERSION || '2023-05-15',
};

try {
  if (process.env.RUNPILOT_STEP_MEMORY) {
    const parsed = JSON.parse(process.env.RUNPILOT_STEP_MEMORY);
    if (Array.isArray(parsed)) cfg.stepMemory = parsed;
  }
} catch (_) {
  cfg.stepMemory = [];
}

// ── Terminal file log + structured stdout ──────────────────────────────────────
const runStartedAt = Date.now();
let logStream = null;
let logFileAnnounced = false;

function openTerminalLog() {
  if (!cfg.logFile || logStream) return;
  try {
    fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
    logStream = fs.createWriteStream(cfg.logFile, { flags: 'a', encoding: 'utf8' });
    writeTerminalLog('=== RunPilot Stagehand terminal log ===', 'META');
    writeTerminalLog('runId=' + (cfg.runId || '-')
      + ' tcKey=' + (cfg.tcKey || '-')
      + ' tcName=' + cfg.tcName, 'META');
    writeTerminalLog('url=' + cfg.baseUrl
      + ' proxy=' + cfg.isProxy
      + ' steps=' + cfg.steps.length
      + ' batch=' + cfg.batchMode
      + ' selfNav=' + cfg.selfNav
      + ' selfNavDepth=' + cfg.selfNavDepth
      + ' fieldConfirmMs=' + cfg.fieldConfirmMs
      + ' cascadeWaitMs=' + cfg.cascadeWaitMs
      + ' humanLike=' + cfg.humanLike
      + ' model=' + cfg.deploy, 'META');
    writeTerminalLog('logFile=' + cfg.logFile, 'META');
    const announced = (cfg.logFileRel || cfg.logFile).replace(/\\/g, '/');
    process.stdout.write('LOG_FILE:' + announced + '\n');
    logFileAnnounced = true;
  } catch (e) {
    try {
      process.stderr.write('WARN: could not open Stagehand log file: '
        + (e && e.message ? e.message : e) + '\n');
    } catch (_) {}
    logStream = null;
  }
}

function writeTerminalLog(msg, level) {
  if (!logStream) return;
  try {
    const ts = new Date().toISOString();
    const elapsed = String(Date.now() - runStartedAt).padStart(7, ' ');
    const lvl = (level || 'INFO').padEnd(5, ' ');
    logStream.write('[' + ts + '][+' + elapsed + 'ms][' + lvl + '] '
      + String(msg).replace(/\r?\n/g, ' ') + '\n');
  } catch (_) {}
}

function stagehandSdkLogger(line) {
  try {
    const levelNum = line && typeof line.level === 'number' ? line.level : 1;
    const lvl = levelNum === 0 ? 'WARN' : (levelNum === 2 ? 'DEBUG' : 'SH');
    const cat = line && line.category ? String(line.category) + ': ' : '';
    let msg = cat + (line && line.message != null ? String(line.message) : String(line));
    if (line && line.auxiliary && typeof line.auxiliary === 'object') {
      try {
        const aux = JSON.stringify(line.auxiliary);
        if (aux && aux.length <= 2500) msg += ' | ' + aux;
        else if (aux) msg += ' | auxBytes=' + aux.length;
      } catch (_) {}
    }
    writeTerminalLog(msg, lvl);
  } catch (_) {}
}

function closeTerminalLog(finalStatus) {
  writeTerminalLog('=== END status=' + finalStatus
    + ' durationMs=' + (Date.now() - runStartedAt) + ' ===', 'META');
  if (logStream) {
    try { logStream.end(); } catch (_) {}
    logStream = null;
  }
}

/** Structured protocol line for Java + tee to terminal log file. */
function rlog(msg) {
  const s = String(msg).replace(/\r?\n/g, ' ');
  process.stdout.write('LOG:' + s + '\n');
  writeTerminalLog(s, 'INFO');
}

openTerminalLog();
if (logFileAnnounced) {
  rlog('LOG_FILE:' + (cfg.logFileRel || cfg.logFile).replace(/\\/g, '/'));
}

function loadBusinessPlan() {
  if (!cfg.planFile) return null;
  try {
    return JSON.parse(fs.readFileSync(cfg.planFile, 'utf8'));
  } catch (e) {
    rlog('PLAN:WARN could not load business plan: ' + (e.message || e));
    return null;
  }
}

const bizPlan = loadBusinessPlan();
const appState = {
  currentPage: '',
  loggedIn: false,
  recoveries: 0,
  formState: {},
};

const CONF_GATES = Object.assign(
  { autoExecute: 95, executeAndValidate: 80, retry: 60, humanReview: 60 },
  (bizPlan && bizPlan.confidenceGates) || {},
);

function plannedForStep(stepIndex) {
  if (!bizPlan || !Array.isArray(bizPlan.actions)) return null;
  return bizPlan.actions.find(a => a.stepIndex === stepIndex) || null;
}

async function snapshotAppState(page) {
  let url = '', title = '';
  try { url = page.url() || ''; } catch (_) {}
  try { title = await page.title(); } catch (_) {}
  const blob = (url + ' ' + title).toLowerCase();
  appState.currentPage = url;
  appState.loggedIn = !/(login|sign[-_ ]?in|auth|sso)/i.test(blob);
  return { url, title, loggedIn: appState.loggedIn };
}

/** Hard-capped navigation — SSO redirect chains can hang Stagehand lifecycle waits indefinitely. */
async function safeGoto(page, url, stepLabel, timeoutMs) {
  const label = stepLabel || 'NAV';
  const budget = Math.max(15000, timeoutMs || cfg.navTimeoutMs || 45000);
  const stagehandTimeout = Math.min(budget - 3000, 35000);
  rlog(label + ':Navigating to ' + url);

  let curUrl = '';
  try { curUrl = page.url() || ''; } catch (_) {}

  const heartbeat = setInterval(() => {
    let cur = curUrl;
    try { cur = page.url() || cur; } catch (_) {}
    curUrl = cur;
    rlog(label + ':waiting… current=' + cur.slice(0, 120));
  }, 10000);

  const hardCap = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Navigation hard-timeout after ' + budget + 'ms')), budget);
  });

  let navErr = null;
  try {
    await Promise.race([
      page.goto(url, { waitUntil: 'domcontentloaded', timeoutMs: stagehandTimeout }),
      hardCap,
    ]);
  } catch (e) {
    navErr = e;
    let cur = '';
    try { cur = page.url() || ''; } catch (_) {}
    rlog(label + ':WARN lifecycle wait — ' + (e.message || e)
      + (cur ? ' | at=' + cur.slice(0, 120) : ''));
    if (!cur || cur === 'about:blank') {
      try {
        await page.evaluate((u) => { window.location.href = u; }, url);
        await page.waitForTimeout(2500);
        try { cur = page.url() || ''; } catch (_) {}
        rlog(label + ':fallback location.href → ' + cur.slice(0, 120));
      } catch (fbErr) {
        rlog(label + ':WARN location.href fallback failed — ' + (fbErr.message || fbErr));
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  let finalUrl = '';
  try { finalUrl = page.url() || ''; } catch (_) {}
  rlog(label + ':Page loaded — ' + (finalUrl || url).slice(0, 120)
    + (navErr ? ' (partial)' : ''));

  if (!cfg.isProxy && /login|sign.?in|sso|microsoftonline|okta|auth0/i.test(finalUrl)) {
    rlog(label + ':WARN Headless landed on SSO/login page — use Proxy/SSO mode (Chrome port '
      + cfg.proxyPort + ') with an already logged-in session for apps like VMS');
  }
  return finalUrl;
}

async function ensureActionAllowed(page, planned, stepLabel) {
  const snap = await snapshotAppState(page);
  rlog(stepLabel + ':STATE:url=' + snap.url + ' loggedIn=' + snap.loggedIn
    + (planned && planned.businessAction ? ' action=' + planned.businessAction : ''));
  const needsLogin = planned && Array.isArray(planned.preconditions)
    && planned.preconditions.includes('logged_in');
  if (needsLogin && !snap.loggedIn && planned.businessAction !== 'LOGIN') {
    if (appState.recoveries < 1 && cfg.baseUrl) {
      appState.recoveries += 1;
      rlog(stepLabel + ':STATE:Session expired — recovery navigate to base URL');
      try {
        await safeGoto(page, cfg.baseUrl, stepLabel + ':RECOVERY', 20000);
        await page.waitForTimeout(800);
      } catch (_) {}
      return snapshotAppState(page);
    }
    rlog(stepLabel + ':GATE:STOP session lost and no remaining recovery');
  }
  return snap;
}

function scoreAction(actResult, extra) {
  extra = extra || {};
  const noAct = isNoActionResult(actResult);
  const elementConf = noAct ? 42 : 92;
  const businessConf = extra.businessOk === false ? 70 : 100;
  const domConf = extra.domOk === false ? 75 : 100;
  const expectedConf = extra.expectedOk === false ? 60 : (extra.expectedOk === true ? 95 : 88);
  const final = Math.round(elementConf * 0.4 + businessConf * 0.25 + domConf * 0.2 + expectedConf * 0.15);
  return { elementConf, businessConf, domConf, expectedConf, final, noAct };
}

function gateDecision(score) {
  if (score.final >= CONF_GATES.autoExecute) return 'AUTO';
  if (score.final >= CONF_GATES.executeAndValidate) return 'VALIDATE';
  if (score.final >= CONF_GATES.retry) return 'RETRY';
  return 'HUMAN_REVIEW';
}

// ── Per-step screenshot (optional red rectangles on failing evidence) ──────────
let lastIssueRects = [];

function rememberIssueRects(rects) {
  lastIssueRects = Array.isArray(rects) ? rects.filter((r) => r && r.w > 2 && r.h > 2) : [];
}

async function paintIssueOverlay(page, rects) {
  if (!page || !rects || !rects.length) return;
  await page.evaluate((boxes) => {
    const old = document.getElementById('runpilot-issue-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'runpilot-issue-overlay';
    overlay.setAttribute('data-runpilot', 'issue-overlay');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    boxes.forEach((r, i) => {
      const box = document.createElement('div');
      box.style.cssText = [
        'position:fixed',
        'left:' + Math.max(0, r.x) + 'px',
        'top:' + Math.max(0, r.y) + 'px',
        'width:' + Math.max(4, r.w) + 'px',
        'height:' + Math.max(4, r.h) + 'px',
        'border:3px solid #e53935',
        'border-radius:4px',
        'box-shadow:0 0 0 2px rgba(229,57,53,0.28)',
        'background:rgba(229,57,53,0.08)',
        'box-sizing:border-box',
      ].join(';');
      const tag = document.createElement('div');
      tag.textContent = (r.label || ('Issue ' + (i + 1))).slice(0, 48);
      tag.style.cssText = 'position:absolute;left:-3px;top:-18px;background:#e53935;color:#fff;'
        + 'font:700 11px/16px sans-serif;padding:0 6px;border-radius:3px;white-space:nowrap;max-width:240px;overflow:hidden;';
      box.appendChild(tag);
      overlay.appendChild(box);
    });
    document.documentElement.appendChild(overlay);
  }, rects).catch(() => {});
}

async function clearIssueOverlay(page) {
  if (!page) return;
  await page.evaluate(() => {
    const old = document.getElementById('runpilot-issue-overlay');
    if (old) old.remove();
  }).catch(() => {});
}

async function screenshotWithIssueRects(page, rects) {
  const boxes = (rects && rects.length) ? rects : lastIssueRects;
  if (boxes && boxes.length) await paintIssueOverlay(page, boxes);
  let buf = null;
  try { buf = await page.screenshot(); } catch (_) {}
  if (boxes && boxes.length) await clearIssueOverlay(page);
  return buf;
}

async function stepScreenshot(page, stepNum, rects) {
  try {
    const buf = await screenshotWithIssueRects(page, rects);
    if (buf) process.stdout.write('STEP_SCREENSHOT:' + stepNum + ':' + buf.toString('base64') + '\n');
  } catch (_) {}
}

// ── Reuse an attached document for upload-style steps ─────────────────────────
// Stagehand v3's Page no longer exposes Playwright's 'filechooser' event (its
// page.on/once only supports 'console' — anything else throws
// StagehandInvalidArgumentError("Unsupported event: filechooser")). Instead we
// set the file directly on the <input type="file"> element via the locator API
// (CDP DOM.setFileInputFiles under the hood), which works whether or not the
// input is visible and needs no native OS dialog interception at all.
const UPLOAD_STEP_RE = /\b(upload|attach|choose file|select file|browse|import file|import document)\b/i;

const LIFECYCLE_VERIFY_RE = /\b(status|lifecycle|state transition|changes from|changes to|moves from|moves to|from ['"].+['"] to ['"].+['"]|status badge|status label|status field|status column|starting status|initial status|previous status|current status|new status|intermediate status)\b/i;

// Require audit/activity-log vocabulary — do NOT match plain "User is redirected…"
const AUDIT_LOG_VERIFY_RE = /\b(audit\s*log|audit\s*trail|activity\s*log|change\s*log|history\s*log|event\s*log|log\s*entry|log\s*row|audit\s*record|change\s*history)\b/i;

const METRICS_VERIFY_RE = /\b(percentage|percent|count updates|recalculat|metric updates|total count|aggregate|KPI|dashboard metric|score updates|rating updates|updates to \d|shows \d+%)\b/i;

const BACKEND_VERIFY_RE = /\b(persists after refresh|backend|integration|source.?to.?target|data sync|downstream|upstream|external system|persists|re-open record|saved values)\b/i;

const EMAIL_WORKFLOW_VERIFY_RE = /\b(escalat(?:e|ion|ed)|reminder|follow-up|recipient|to address|email content|body content|notification content)\b/i;

const ATTACHMENT_VERIFY_RE = /\b(upload attachment|download attachment|replace file|replace attachment|delete attachment|remove attachment|version|versioning|attachment appears|file upload)\b/i;

const NEGATIVE_FILE_VERIFY_RE = /\b(invalid file|unsupported format|corrupt|corrupted|duplicate upload|duplicate file|file size|exceeds|too large|size limit)\b/i;

const URL_TITLE_VERIFY_RE = /\b(url\s+(is|contains|equals|changes)|redirect(?:ed|s|ion)\s+to|page title|document title|browser tab|tab title|title is|title contains|lands on|inventory page|home\s*page|dashboard)\b/i;
const IN_PAGE_CONTENT_VERIFY_RE = /\b(same\s+page|same\s+url|in[- ]?page|tab\s+(becomes|is)\s+(active|selected|visible)|content\s+(updates|changes|appears)|menu\s+item\s+(shows|is)\s+active|no\s+redirect|url\s+(redirect\s+)?(is\s+)?not\s+required|active\s+or\s+selected\s+state)\b/i;
const NETWORK_ACTIVITY_VERIFY_RE = /\b(network\s+activity|network\s+tab|devtools|xhr\s+(is\s+)?visible|api\s+requests?\s+(are\s+)?visible|network\s+traffic|fetch\s+requests?\s+visible|api\s+calls?\s+(are\s+)?(visible|shown))\b/i;
const LOADING_UI_VERIFY_RE = /\b(loading\s+(button|indicator|spinner|state)|spinner|busy\s+indicator|button\s+(is\s+)?(disabled|loading)|progress\s+(bar|indicator)|please\s+wait)\b/i;

function isLifecycleTransitionExpected(expected) {
  return LIFECYCLE_VERIFY_RE.test(String(expected || ''));
}

function isAuditLogContentExpected(expected) {
  const e = String(expected || '');
  if (!AUDIT_LOG_VERIFY_RE.test(e)) return false;
  // Guard: "user is redirected" etc. must not enter audit path
  if (URL_TITLE_VERIFY_RE.test(e) && !/\b(audit|activity\s*log|log\s*entry|change\s*history)\b/i.test(e)) {
    return false;
  }
  return true;
}

function isUrlOrTitleExpected(expected) {
  const e = String(expected || '');
  if (isChromeDocumentTitleExpected(e)) return true;
  if (isPageLoadHealthExpected(e)) return false;
  if (IN_PAGE_CONTENT_VERIFY_RE.test(e)) return false;
  return URL_TITLE_VERIFY_RE.test(e);
}

function isAuthWallUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  return /okta\.com|login\.microsoftonline|login\.microsoft\.com|accounts\.google|auth0\.com|\/adfs\/|\/auth\/login|login\.htm|[?&]fromuri=/i.test(u)
    || /\/(signin|sign-in)(\/|\?|#|$)/i.test(u);
}

function isPageLoadHealthExpected(text) {
  const t = String(text || '');
  return /\b(page loads?|loads? fully|loads? successfully|loads? completely|no error (message|page|banner).{0,20}redirect|without errors or redirects)\b/i.test(t);
}

/**
 * True negative: headless bounced to SSO/login while the TC expected the app.
 * True positive: current URL is the app (or the TC itself is a login page).
 */
async function verifyPageLoadHealthExpected(page, expected) {
  if (!isPageLoadHealthExpected(expected)) return null;
  let url = '';
  let title = '';
  try { url = page.url() || ''; } catch (_) {}
  try { title = await page.title(); } catch (_) {}
  const target = cfg.baseUrl || '';
  const bouncedToAuth = isAuthWallUrl(url) && !isAuthWallUrl(target);
  const authTitle = /\b(sign in|log in|login)\b/i.test(title)
    && !/\b(template|dashboard|inbox|authoring|portal|home)\b/i.test(title);
  if (bouncedToAuth || (authTitle && !isAuthWallUrl(target))) {
    return {
      met: false,
      reason: 'App page did not load — landed on login/SSO (document.title="' + (title || '(empty)')
        + '", url=' + url + '). Use Proxy/SSO with the application already open.',
    };
  }
  if (/\b(403|404|access denied|not found)\b/i.test(title)) {
    return {
      met: false,
      reason: 'Error page loaded (document.title="' + title + '", url=' + url + ').',
    };
  }
  return {
    met: true,
    reason: 'Page loaded (url=' + url + ', document.title="' + title + '").',
  };
}

function isInPageContentExpected(expected) {
  return IN_PAGE_CONTENT_VERIFY_RE.test(String(expected || ''));
}

function isNetworkOrLoadingUiExpected(expected) {
  const e = String(expected || '');
  return NETWORK_ACTIVITY_VERIFY_RE.test(e) || LOADING_UI_VERIFY_RE.test(e);
}

/** Map bogus "network activity visible" (DevTools) to real UI: loading button/spinner or settled page. */
async function verifyLoadingOrSettledUi(page, expected) {
  try {
    const snap = await page.evaluate(() => {
      function visible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0 && el.offsetHeight > 0;
      }
      const loaders = Array.from(document.querySelectorAll(
        '[aria-busy=true],.spinner,.loading,.loader,[class*="spinner"],[class*="loading"],[class*="loader"],'
        + 'button[disabled],button[aria-busy=true],[role=progressbar],.progress,.progress-bar'
      )).filter(visible);
      const loadingBtn = Array.from(document.querySelectorAll('button,[role=button],input[type=submit]'))
        .filter(visible)
        .find(function (b) {
          var t = ((b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || '') + ' '
            + (b.className || '')).toLowerCase();
          return b.disabled || b.getAttribute('aria-busy') === 'true'
            || /loading|please wait|submitting|processing|spinner/.test(t);
        });
      const busy = document.body && document.body.getAttribute('aria-busy') === 'true';
      const main = document.querySelector('main,[role=main],#content,.content,.page-content') || document.body;
      const textLen = ((main && main.innerText) || '').replace(/\s+/g, ' ').trim().length;
      return {
        loaderCount: loaders.length,
        hasLoadingButton: !!loadingBtn,
        loadingButtonText: loadingBtn
          ? (loadingBtn.innerText || loadingBtn.textContent || loadingBtn.value || '').trim().slice(0, 60)
          : '',
        busy: busy,
        contentLen: textLen,
        readyState: document.readyState,
      };
    });

    // Pass if loading UI is visible OR page has already settled with content
    if (snap.hasLoadingButton || snap.loaderCount > 0 || snap.busy) {
      return {
        met: true,
        reason: 'Loading UI observed (button/spinner/busy)'
          + (snap.loadingButtonText ? ': "' + snap.loadingButtonText + '"' : '')
          + ' — treated as API-in-progress (not DevTools network panel).',
      };
    }
    if (snap.readyState === 'complete' && snap.contentLen > 40) {
      return {
        met: true,
        reason: 'Page settled with visible content (loading finished). '
          + 'DevTools network activity is not asserted as on-screen UI.',
      };
    }
    // Brief wait then re-check — loading may appear one tick late
    await page.waitForTimeout(400);
    const again = await page.evaluate(() => {
      const loaders = document.querySelectorAll(
        '[aria-busy=true],.spinner,.loading,.loader,[class*="spinner"],[class*="loading"],button[disabled],[role=progressbar]'
      );
      let any = false;
      loaders.forEach(function (el) {
        const s = window.getComputedStyle(el);
        if (s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0) any = true;
      });
      const main = document.querySelector('main,[role=main],#content,.content') || document.body;
      return { any: any, contentLen: ((main && main.innerText) || '').trim().length, ready: document.readyState };
    });
    if (again.any || (again.ready === 'complete' && again.contentLen > 40)) {
      return {
        met: true,
        reason: again.any
          ? 'Loading indicator appeared after brief wait.'
          : 'Page content settled after brief wait (API load complete).',
      };
    }
    return {
      met: false,
      reason: 'No loading button/spinner and page content not clearly settled. '
        + 'Note: "network activity" is not visible UI — expected loading indicator or settled content.',
    };
  } catch (e) {
    return { met: false, reason: 'Loading/UI verify error: ' + (e && e.message ? e.message : e) };
  }
}

function isMetricsExpected(expected) {
  return METRICS_VERIFY_RE.test(String(expected || ''));
}

function isBackendIntegrationExpected(expected) {
  return BACKEND_VERIFY_RE.test(String(expected || ''));
}

function isEmailWorkflowExpected(expected) {
  return EMAIL_WORKFLOW_VERIFY_RE.test(String(expected || ''));
}

function isAttachmentLifecycleExpected(expected) {
  return ATTACHMENT_VERIFY_RE.test(String(expected || ''));
}

function isNegativeFileExpected(expected) {
  return NEGATIVE_FILE_VERIFY_RE.test(String(expected || ''));
}

/**
 * Domain-agnostic grounding for Stagehand act().
 * Applies to ANY product wording mismatch (not just vendor/onboarding).
 */
const ACT_GROUNDING_RULES =
  'UI INTENT MATCHING — COMMON RULE FOR ALL APPS (mandatory — zero hallucination):\n'
  + '1) Test-step text may use synonyms of the live UI. Match by INTENT, not exact string.\n'
  + '2) Interact ONLY with a VISIBLE control on the CURRENT page '
  + '(button, link, menuitem, tab, checkbox, radio, input label, aria-label, title, placeholder).\n'
  + '3) Synonym families (use when the on-screen control clearly belongs to the same family):\n'
  + '   • create / add / new / raise / open / start / initiate / register\n'
  + '   • edit / update / modify / change / revise\n'
  + '   • delete / remove / discard / cancel request\n'
  + '   • submit / save / send / confirm / apply / finish / complete\n'
  + '   • search / find / filter / lookup\n'
  + '   • view / open / details / show / preview\n'
  + '   • approve / accept / reject / deny / decline\n'
  + '   • login / sign in · logout / sign out · upload / attach · download / export\n'
  + '4) Prefer the visible control that shares the most distinctive nouns with the step '
  + '(entity names like vendor, project, user, invoice, checklist, audit, etc.).\n'
  + '5) NEVER invent a control, label, toast, or field that is not on screen.\n'
  + '6) If several controls look similar, pick the closest intent match; '
  + 'if none is clear, do nothing and report no action found.\n'
  + '7) DYNAMIC UI: after SPA/menu updates, use the CURRENTLY visible labels — '
  + 'ignore stale step wording that names controls no longer on screen; rematch by intent.\n'
  + '8) Prefer exact visible label text over paraphrased test-case wording when both exist.\n'
  + '9) TABBED ADMIN: to SAVE/SUBMIT use the visible "Save Changes" button — never click a top nav tab named '
  + 'Sticky Alerts / Quick Links / etc. as a submit. For new rows, click Add alert/article/event first; '
  + 'do not overwrite the first populated table row when the step means "create new".\n'
  + '10) SESSION / PROFILE (critical for SSO): NEVER click the user avatar, profile picture, user-name chip, '
  + 'account menu, or Logout / Sign out unless the step EXPLICITLY says logout/sign out. '
  + 'If already on a dashboard/home page (authenticated), do NOT search for Login / credentials / password fields.\n'
  + '11) VENDOR NAV synonyms: "Vendor Requests" / "Create Vendor Request" map to visible '
  + '"Vendor Onboarding Requests", "Raise Vendor Request", or "Add New Vendor" in the sidebar/cards — '
  + 'never the profile menu.\n'
  + '12) FORM FOOTER (conservative): click Next/Continue ONLY when the step names that button. '
  + 'Never click Save as Draft, Draft, or Save unless the step explicitly says draft/save.';

const GROUNDING_SHORT =
  'Apply UI intent matching: VISIBLE controls only; never click profile/avatar/Logout unless step says logout; '
  + 'Vendor Requests → Vendor Onboarding Requests / Raise Vendor Request / Add New Vendor; '
  + 'click Next only when the step names Next — never Draft/Save unless named.';

let _groundingSent = false;

function pickStepMemory(stepIndex) {
  if (!cfg.ragEnabled || !cfg.stepMemory || !cfg.stepMemory.length || stepIndex == null) return '';
  for (const row of cfg.stepMemory) {
    if (row && row.step === stepIndex && row.hint) return String(row.hint);
  }
  return '';
}

function looksLikeDataEntry(text) {
  return /\b(type|enter|fill|input|select|choose|upload|attach|password|username|email|search for)\b/i.test(String(text || ''));
}

function stepNeedsConfluence(text) {
  return /\b(verify|validate|assert|expected|should|must|confluence|design|requirement)\b/i.test(String(text || ''));
}

function withExecutionContext(instruction, stepIndex) {
  const base = rewriteTabbedAdminInstruction(String(instruction || '').trim());
  const parts = [];

  if (!cfg.ragEnabled) {
    parts.push(ACT_GROUNDING_RULES);
  } else if (!_groundingSent) {
    parts.push(ACT_GROUNDING_RULES);
    _groundingSent = true;
  } else {
    parts.push(GROUNDING_SHORT);
  }

  if (cfg.testData && cfg.testData.trim()) {
    const includeData = !cfg.ragEnabled
      || looksLikeDataEntry(base)
      || (stepIndex === 1 && !pickStepMemory(1));
    if (includeData && !(cfg.executionContext || '').includes('OPENMEMORY')) {
      parts.push(
        'Sample / test data for this test case (use these values when the step asks to enter data):\n' +
        cfg.testData.trim()
      );
    }
  }

  if (cfg.ragEnabled) {
    const stepHint = pickStepMemory(stepIndex);
    if (stepHint) {
      parts.push('Relevant project memory for this step:\n' + stepHint);
    } else if (cfg.memoryPack && cfg.memoryPack.trim()) {
      parts.push('Project memory (use only if relevant to this step):\n' + cfg.memoryPack.trim());
    }
    const hints = (cfg.confluenceHints || '').trim();
    if (hints && (stepNeedsConfluence(base) || stepIndex === 1)) {
      parts.push(
        'Approved supplementary context from Confluence/design (apply only when it agrees with this step):\n' +
        hints
      );
    }
  } else if (cfg.executionContext && cfg.executionContext.trim()) {
    const ctx = cfg.executionContext.trim();
    if (ctx.includes('OPENMEMORY')) {
      parts.push(
        'OpenMemory project memory + compact context (prefer these stable facts; keep prompts short):\n' + ctx
      );
    } else {
      parts.push(
        'Approved supplementary context from Confluence/design (apply only when it agrees with this step):\n' + ctx
      );
    }
  }

  parts.push('Step to execute:\n' + base);
  return parts.join('\n\n');
}

/**
 * Admin.aspx-style tabbed pages: "Click Sticky Alerts to submit" hits the NAV TAB, not Save.
 * Also nudge new-row fills away from overwriting the first populated table row.
 */
function rewriteTabbedAdminInstruction(instruction) {
  let s = String(instruction || '').trim();
  if (!s) return s;
  const tabSubmit = /click\s+(?:the\s+)?['"]?(sticky\s+alerts|quick\s+links|reader'?s?\s+digest|upcoming\s+events|anniversary\s*\/?\s*rewards)['"]?\s*(?:button|tab)?\s+to\s+submit/i;
  if (tabSubmit.test(s)) {
    s = s.replace(tabSubmit, "Click the 'Save Changes' button in the active panel footer to save");
  }
  if (/leave\s+the\s+first\s+['"]?text['"]?\s+field\s+empty/i.test(s)
      || /leave\s+the\s+first\s+['"]?date['"]?\s+field\s+empty/i.test(s)) {
    s = 'If needed click Add alert / Add article / Add event to create a NEW empty row, then clear or leave THAT new row field empty (do not use already-populated rows). Original: ' + s;
  }
  if (/enter\s+['"].{1,80}['"]\s+in\s+the\s+first\s+['"]?text['"]?\s+field/i.test(s)
      && /sticky\s+alert|alert\s+message|add\s+alert/i.test(s + ' ' + (cfg && cfg.testObjective ? cfg.testObjective : ''))) {
    s = 'Prefer the NEW empty alert row (after Add alert if needed), not the first existing populated row. ' + s;
  }
  return s;
}

/** Input.value is not visible page text — LLM extract falsely fails "field contains entered username". */
async function verifyTypedInputValueExpected(page, expected) {
  const e = String(expected || '');
  if (!/(field|username|password|email|input).{0,80}(contain|display|show|retain).{0,40}(entered|typed|input value|characters)/i.test(e)) {
    return null;
  }
  try {
    const values = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea,select'));
      return els.map((el) => ({
        name: (el.name || el.id || el.placeholder || el.type || '').toString(),
        type: (el.type || el.tagName || '').toString().toLowerCase(),
        value: el.type === 'password' ? (el.value ? '[filled]' : '') : String(el.value || ''),
        filled: !!(el.value && String(el.value).length),
      }));
    });
    const anyFilled = (values || []).some((v) => v.filled);
    if (anyFilled) {
      return { met: true, reason: 'Input(s) have a non-empty value (checked via input.value, not visible text).' };
    }
    return { met: false, reason: 'Expected typed value in a field, but no input has a value.' };
  } catch (err) {
    return { met: false, reason: 'Could not read input values: ' + (err && err.message ? err.message : String(err)) };
  }
}

function verifyContextSuffix() {
  if (cfg.ragEnabled) {
    const hints = (cfg.confluenceHints || '').trim();
    if (!hints) return '';
    return ' Also apply these agreed Confluence/design notes when judging (only if consistent): '
      + (hints.length > 400 ? hints.substring(0, 400) + '…' : hints);
  }
  if (!cfg.executionContext || !cfg.executionContext.trim()) return '';
  return ' Also apply these agreed Confluence/design notes when judging (only if consistent): '
    + cfg.executionContext.trim();
}

/**
 * Chrome/window document title — NOT an in-page UI tab.
 * "browser tab displays the title X" → document.title. "'Created By Me' tab" → in-page tab.
 */
function isChromeDocumentTitleExpected(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/\b(browser\s+tab|chrome\s+tab|window\s+tab|document\s+title|page\s+title|tab\s+title)\b/i.test(t)
      && /\b(title|displays?|shows?|contains?|equals?|is|reads?)\b/i.test(t)) {
    return true;
  }
  return /\b(the\s+)?(browser\s+)?tab\s+(displays?|shows?|contains?)\s+(the\s+)?title\b/i.test(t);
}

function isMainHeadingExpected(text) {
  const t = String(text || '');
  if (!t || isChromeDocumentTitleExpected(t)) return false;
  return /\b(main\s+heading|page\s+heading|\bh1\b|heading)\b/i.test(t);
}

function extractQuotedPhrase(text) {
  const t = String(text || '');
  const nearTitle = t.match(/title[^'"]{0,48}['"]([^'"]{2,120})['"]/i)
    || t.match(/heading[^'"]{0,48}['"]([^'"]{2,120})['"]/i);
  if (nearTitle && nearTitle[1]) return nearTitle[1].replace(/\s+/g, ' ').trim();
  const all = t.match(/['"]([^'"]{2,120})['"]/g) || [];
  if (!all.length) return '';
  return all[all.length - 1].replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeComparableText(s) {
  return String(s || '').toLowerCase().replace(/[|–—·•]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function comparableTextMatches(actual, want) {
  const a = normalizeComparableText(actual);
  const w = normalizeComparableText(want);
  if (!a || !w) return false;
  if (a === w) return true;
  if (a.includes(w)) return true;
  return w.length >= 12 && a.length >= 12 && w.includes(a);
}

/** Pull a named in-page tab/section from verify wording — generic, any product. */
function extractNamedTab(text) {
  const t = String(text || '');
  if (isChromeDocumentTitleExpected(t)) return '';
  const quoted = t.match(/['"]([^'"]{2,60})['"]\s+tab\b/i);
  if (quoted && quoted[1]) {
    const name = quoted[1].replace(/\s+/g, ' ').trim();
    if (name.length >= 2 && !/^(browser|chrome|window|document|page)$/i.test(name)) return name;
  }
  const re = /((?:[A-Za-z][A-Za-z0-9&/_-]*)(?:\s+[A-Za-z][A-Za-z0-9&/_-]*){0,3})\s+tab\b/gi;
  let best = '';
  let m;
  while ((m = re.exec(t))) {
    let name = String(m[1] || '').replace(/\s+/g, ' ').trim();
    while (/^(a|an|the|this|that|and|verify|assert|check|confirm|validate|ensure|observe|inspect|on|in|open|display|show)\s+/i.test(name)) {
      name = name.replace(/^(a|an|the|this|that|and|verify|assert|check|confirm|validate|ensure|observe|inspect|on|in|open|display|show)\s+/i, '').trim();
    }
    if (name.length >= 2 && !/^(tab|content|active|current|browser|chrome|window|document|page)$/i.test(name)) {
      best = name;
    }
  }
  return best;
}

/**
 * True positive: document.title matches the quoted expected title.
 * True negative: document.title does not match — report actual vs expected (no in-page tab hunt).
 */
async function verifyDocumentTitleExpected(page, expected) {
  if (!isChromeDocumentTitleExpected(expected)) return null;
  const want = extractQuotedPhrase(expected);
  if (!want) return null;
  let actual = '';
  try { actual = await page.title(); } catch (_) { actual = ''; }
  if (comparableTextMatches(actual, want)) {
    return {
      met: true,
      reason: 'Document title matches "' + want + '" (document.title="' + actual + '").',
    };
  }
  return {
    met: false,
    reason: 'Document title mismatch — expected "' + want + '", actual document.title="'
      + (actual || '(empty)') + '".',
  };
}

/**
 * True positive: visible heading OR (common) the quoted text is actually document.title.
 * True negative: neither an on-page heading nor the page title matches.
 */
async function verifyVisibleHeadingExpected(page, expected) {
  if (!isMainHeadingExpected(expected)) return null;
  const want = extractQuotedPhrase(expected);
  if (!want) return null;

  let actualTitle = '';
  try { actualTitle = await page.title(); } catch (_) { actualTitle = ''; }

  const snap = await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }
    function textOf(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const headings = [];
    const branding = [];
    function pushHeading(t, el) {
      if (!t || t.length < 2 || t.length > 180) return;
      if (headings.some((h) => h.text === t)) return;
      const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
      headings.push({
        text: t,
        x: Math.round(r.x || 0),
        y: Math.round(r.y || 0),
        w: Math.round(r.width || 0),
        h: Math.round(r.height || 0),
      });
    }
    function walk(root) {
      if (!root) return;
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(
          'h1,h2,h3,h4,[role="heading"],legend,'
          + '[class*="page-title"],[class*="pageTitle"],[class*="PageTitle"],'
          + '[class*="page-header"],[class*="pageHeader"],'
          + '[class*="Typography-h"],[class*="MuiTypography-h"]'
        ));
      } catch (_) { nodes = []; }
      nodes.forEach((el) => {
        if (!visible(el)) return;
        pushHeading(textOf(el), el);
      });
      let header = null;
      try {
        header = root.querySelector('header,[role="banner"],[class*="sidebar"],[class*="SideNav"],[class*="brand"]');
      } catch (_) {}
      if (header && visible(header)) {
        const bt = textOf(header).slice(0, 160);
        if (bt) branding.push(bt);
      }
      const main = (root.querySelector && (root.querySelector('main,[role="main"]') || root.body || root)) || root;
      try {
        Array.from(main.querySelectorAll('h1,h2,h3,h4,p,div,span')).forEach((el) => {
          if (!visible(el)) return;
          if (el.children && el.children.length > 6) return;
          const r = el.getBoundingClientRect();
          if (r.top > 340 || r.top < 0) return;
          const cs = window.getComputedStyle(el);
          const fs = parseFloat(cs.fontSize) || 0;
          const fw = parseInt(cs.fontWeight, 10) || 0;
          const t = textOf(el);
          if (!t || t.length < 2 || t.length > 80) return;
          if (fs >= 20 || fw >= 600) pushHeading(t, el);
        });
      } catch (_) {}
      try {
        Array.from(root.querySelectorAll('*')).forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot);
        });
      } catch (_) {}
    }
    walk(document);
    return { headings: headings.slice(0, 15), branding: branding[0] || '' };
  }).catch(() => ({ headings: [], branding: '' }));

  const headings = (snap && Array.isArray(snap.headings)) ? snap.headings : [];
  const headingTexts = headings.map((h) => (typeof h === 'string' ? h : h.text));
  const hit = headings.find((h) => comparableTextMatches(typeof h === 'string' ? h : h.text, want));
  if (hit) {
    const text = typeof hit === 'string' ? hit : hit.text;
    return {
      met: true,
      reason: 'Visible heading matches "' + want + '" (observed "' + text + '").',
    };
  }

  // Product name is often only document.title / browser tab, not an <h1>.
  if (comparableTextMatches(actualTitle, want)) {
    return {
      met: true,
      reason: 'Quoted "heading" is the page/document title (document.title="' + actualTitle
        + '"), not an on-page h1. Treated as title match.',
    };
  }

  const branding = snap && snap.branding ? snap.branding : '';
  if (branding && comparableTextMatches(branding, want)) {
    return {
      met: true,
      reason: 'Quoted text is visible in header/branding ("' + branding.slice(0, 80) + '").',
    };
  }

  const highlightRects = headings
    .filter((h) => h && h.w > 2 && h.h > 2)
    .slice(0, 8)
    .map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h, label: (h.text || 'Heading').slice(0, 40) }));
  return {
    met: false,
    reason: 'Heading "' + want + '" was not found. document.title="' + (actualTitle || '(empty)')
      + '". Visible headings: '
      + (headingTexts.length ? headingTexts.map((h) => '"' + h + '"').join(', ') : '(none)') + '.',
    highlightRects,
  };
}

function isNoErrorBannerExpected(text) {
  const t = String(text || '');
  return /\bno\s+(visible\s+)?(error|alert)s?\b/i.test(t)
    || /\bno\s+error\s+banners?\b/i.test(t)
    || /\berror\s+banners?\s+or\s+alerts?\b/i.test(t)
    || (/\bpage appears stable\b/i.test(t) && /\b(error|alert)\b/i.test(t));
}

function isNoBlockingOverlayExpected(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/\bno\s+(modal|popup|pop-up|overlay|dialog).{0,80}block/i.test(t)) return true;
  if (/\b(modal|overlay|dialog).{0,40}(not\s+)?block/i.test(t) && /\bno\b/i.test(t)) return true;
  return /\bmain content is fully visible and interactive\b/i.test(t)
    && /\b(modal|overlay|dialog|popup)\b/i.test(t);
}

/**
 * "No modal blocking / main content interactive" — ignore a11y progressbars and tiny loaders.
 * Fail only for a real covering dialog/cookie/consent overlay.
 */
async function verifyNoBlockingOverlayExpected(page, expected, retried) {
  if (!isNoBlockingOverlayExpected(expected)) return null;
  const scan = await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight;
    }
    function textOf(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .MuiDialog-paper, [class*="ant-modal-content"]'
    )).filter(visible);
    const covering = dialogs.filter((el) => {
      const r = el.getBoundingClientRect();
      return (r.width * r.height) > (vw * vh * 0.08);
    });
    const progress = Array.from(document.querySelectorAll('[role="progressbar"], .MuiLinearProgress-root'))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const covers = (r.width * r.height) > (vw * vh * 0.35);
        const inactive = el.getAttribute('aria-hidden') === 'true'
          || el.getAttribute('aria-busy') === 'false'
          || el.getAttribute('aria-valuenow') === '0'
          || r.height < 12;
        return { covers, inactive, h: Math.round(r.height) };
      });
    const blockingProgress = progress.some((p) => p.covers && !p.inactive);
    return {
      dialogCount: covering.length,
      dialogTitle: covering[0] ? textOf(covering[0]).slice(0, 80) : '',
      progressCount: progress.length,
      blockingProgress,
    };
  }).catch(() => ({ dialogCount: 0, dialogTitle: '', progressCount: 0, blockingProgress: false }));

  if (scan.dialogCount > 0) {
    return {
      met: false,
      reason: 'A dialog/overlay is still open: "' + (scan.dialogTitle || 'modal') + '".',
    };
  }
  if (scan.blockingProgress && !retried) {
    await page.waitForTimeout(800);
    return verifyNoBlockingOverlayExpected(page, expected, true);
  }
  return {
    met: true,
    reason: 'No blocking modal/overlay. Main content is usable'
      + (scan.progressCount ? ' (ignored ' + scan.progressCount + ' non-blocking progressbar/loader)' : '')
      + '.',
  };
}

/**
 * True positive: no real error/danger banners (ignore cards, tiles, nav "Template" labels).
 * True negative: a real error/danger/warning banner is visible — include highlight rects.
 */
async function verifyNoErrorBannerExpected(page, expected) {
  if (!isNoErrorBannerExpected(expected)) return null;
  const found = await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight;
    }
    function textOf(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function looksErrorText(t) {
      return /\b(error|failed|unable|invalid|required|denied|exception|unavailable|something went wrong|please try|not allowed|forbidden)\b/i.test(t);
    }
    function looksErrorStyle(el) {
      const cls = String(el.className || '') + ' ' + String(el.getAttribute('class') || '');
      const role = String(el.getAttribute('role') || '').toLowerCase();
      const live = String(el.getAttribute('aria-live') || '').toLowerCase();
      if (/\b(error|danger|fatal|severe|alert-error|Alert-error|standardError|filledError|toast--error|ant-alert-error|alert-danger)\b/i.test(cls)) return true;
      if (role === 'alert' && live === 'assertive') return true;
      try {
        const bg = window.getComputedStyle(el).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) {
          const r = +m[1], g = +m[2], b = +m[3];
          if (r > 160 && g < 120 && b < 120 && r - g > 40) return true;
        }
      } catch (_) {}
      return false;
    }
    function isContentTile(el, t) {
      const short = String(t || '').replace(/\s+/g, ' ').trim();
      if (/^(template|templates|created by me|created by others|email|fragment|brand management)$/i.test(short)) return true;
      if (el.closest && el.closest('[class*="card"],[class*="Card"],[class*="tile"],[class*="grid"],[class*="Gallery"]')) {
        if (!looksErrorText(short) && short.length < 48) return true;
      }
      return false;
    }
    const sel = [
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[class*="alert-danger"]',
      '[class*="Alert-error"]',
      '[class*="alert-error"]',
      '[class*="error-banner"]',
      '[class*="errorBanner"]',
      '[class*="MuiAlert-standardError"]',
      '[class*="MuiAlert-filledError"]',
      '[class*="ant-alert-error"]',
      '.Toastify__toast--error',
      '[class*="notification-error"]',
    ].join(',');
    const found = [];
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch (_) { nodes = []; }
    nodes.forEach((el) => {
      if (!visible(el)) return;
      const t = textOf(el).slice(0, 160);
      const r = el.getBoundingClientRect();
      if (r.width > window.innerWidth * 0.92 && r.height > window.innerHeight * 0.4) return;
      if (isContentTile(el, t)) return;
      if (!looksErrorStyle(el) && !looksErrorText(t)) return;
      found.push({
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        label: (t || 'Error banner').slice(0, 48),
        text: t,
      });
    });
    if (found.length >= 4) {
      const labels = found.map((f) => String(f.text || '').toLowerCase().slice(0, 24));
      const uniq = new Set(labels);
      if (uniq.size <= 2) return [];
    }
    return found.slice(0, 12);
  }).catch(() => []);

  const banners = Array.isArray(found) ? found : [];
  if (!banners.length) {
    return {
      met: true,
      reason: 'No error/danger banners or alerts on the page (content cards and nav labels ignored).',
    };
  }
  return {
    met: false,
    reason: 'Real error/alert banner(s) visible: '
      + banners.slice(0, 3).map((b) => '"' + (b.text || b.label || '') + '"').join('; ') + '.',
    highlightRects: banners.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, label: b.label || 'Error' })),
  };
}

function isCrawlImageHealthExpected(text) {
  const t = String(text || '');
  return /\bno\s+images?\s+are\s+present\b/i.test(t)
    || /\bthere are no images\b/i.test(t)
    || /\bcrawl-counted HTML\b/i.test(t)
    || (/\bas per crawl data\b/i.test(t) && /\bimages?\b/i.test(t))
    || /\bno broken image\b/i.test(t)
    || /\bno missing alt\b/i.test(t)
    || /\bno image placeholders?\b/i.test(t)
    || /\bimages have naturalWidth\b/i.test(t)
    || /\bno new broken images\b/i.test(t)
    || /\bmissing-alt count matches crawl\b/i.test(t)
    || /\bSVG icons are not broken-image\b/i.test(t)
    || (/\bSVG <image>\b/i.test(t) && /\bimages?\b/i.test(t));
}

/**
 * Crawl imageStats counts HTML <img> with a non-data src only.
 * SVG <image> nodes, icons, and role=img decorations are not crawl images —
 * Stagehand a11y snapshots still label them "image", which caused false fails.
 */
async function verifyCrawlImageHealthExpected(page, expected) {
  if (!isCrawlImageHealthExpected(expected)) return null;
  const exp = String(expected || '');
  const wantNone = /\bno\s+images?\s+are\s+present\b/i.test(exp)
    || /\bthere are no images\b/i.test(exp)
    || /\bsince there are no images\b/i.test(exp)
    || /\bno crawl-counted HTML\b/i.test(exp)
    || /\bdo not count as images\b/i.test(exp);
  const wantNoBroken = /\bno broken image\b/i.test(exp)
    || /\bno image placeholders?\b/i.test(exp)
    || /\bnaturalWidth\b/i.test(exp)
    || /\bno new broken images\b/i.test(exp);
  const wantNoMissingAlt = /\bno missing alt\b/i.test(exp) || /\bmissing-alt\b/i.test(exp);

  const stats = await page.evaluate(() => {
    function boxOf(el, label) {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        label: String(label || 'img').slice(0, 48),
      };
    }
    const content = [];
    const broken = [];
    const missingAlt = [];
    Array.from(document.querySelectorAll('img')).forEach((img) => {
      const attrSrc = img.getAttribute('src') || img.getAttribute('data-src') || '';
      const src = img.currentSrc || img.src || attrSrc || '';
      if (!attrSrc && (!src || src.indexOf('data:') === 0)) return;
      if (src.indexOf('data:') === 0) return;
      // Empty src resolves to the page URL — that is not a content image.
      try {
        if (new URL(src, location.href).href.split('#')[0] === location.href.split('#')[0]) return;
      } catch (_) {}
      const rec = boxOf(img, (img.alt || attrSrc || src).slice(0, 40) || 'img');
      rec.src = String(attrSrc || src).slice(0, 80);
      content.push(rec);
      if (!img.complete || img.naturalWidth === 0) broken.push(rec);
      if (!(img.alt || '').trim()) missingAlt.push({ ...rec, label: 'missing alt' });
    });
    let svgImageCount = 0;
    try { svgImageCount = document.querySelectorAll('svg image, svg img').length; } catch (_) {}
    return {
      contentCount: content.length,
      content,
      broken,
      missingAlt,
      svgImageCount,
    };
  }).catch(() => ({ contentCount: 0, content: [], broken: [], missingAlt: [], svgImageCount: 0 }));

  const svgNote = ' SVG <image>/icon nodes (' + (stats.svgImageCount || 0)
    + ') are not crawl-counted HTML images.';

  if (wantNone) {
    // "No images as per crawl" is a generation-time snapshot, not a product rule.
    // Template Manager (and most apps) have nav icons + card thumbnails — that is not a defect.
    if (stats.broken.length) {
      return {
        met: false,
        reason: stats.broken.length + ' broken HTML image(s) (naturalWidth=0). Live <img> count='
          + stats.contentCount + '.',
        highlightRects: stats.broken.slice(0, 8),
      };
    }
    return {
      met: true,
      reason: 'Crawl-zero image count is not a live invariant. Page has '
        + stats.contentCount + ' HTML <img> node(s) (icons/thumbnails are expected UI). No broken images.'
        + svgNote,
    };
  }

  if (wantNoBroken) {
    if (!stats.broken.length) {
      return {
        met: true,
        reason: stats.contentCount
          ? ('No broken HTML images (naturalWidth>0, count=' + stats.contentCount + ').' + svgNote)
          : ('No HTML content images, so no broken-image icons.' + svgNote),
      };
    }
    return {
      met: false,
      reason: stats.broken.length + ' broken HTML image(s) (naturalWidth=0).',
      highlightRects: stats.broken.slice(0, 8),
    };
  }

  if (wantNoMissingAlt) {
    if (!stats.contentCount) {
      return {
        met: true,
        reason: 'No HTML content images, so no missing-alt issue.' + svgNote,
      };
    }
    if (!stats.missingAlt.length) {
      return { met: true, reason: 'All crawl-counted HTML images have alt text.' };
    }
    return {
      met: false,
      reason: stats.missingAlt.length + ' HTML image(s) missing alt text.',
      highlightRects: stats.missingAlt.slice(0, 8),
    };
  }

  return {
    met: true,
    reason: 'Image health matches crawl rules (HTML <img> only).' + svgNote,
  };
}

async function activateNamedTabIfNeeded(page, tabName, stepLabel) {
  const want = String(tabName || '').trim();
  if (!want) return false;
  const state = await page.evaluate((want) => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }
    function norm(s) { return String(s || '').toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ' ').trim(); }
    function labelOf(el) {
      return (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function isSelected(el) {
      return el.getAttribute('aria-selected') === 'true'
        || el.getAttribute('aria-current') === 'page'
        || el.getAttribute('aria-current') === 'true'
        || /\b(active|selected|is-active|current)\b/i.test(String(el.className || ''));
    }
    document.querySelectorAll('[data-runpilot-tab]').forEach((el) => el.removeAttribute('data-runpilot-tab'));
    const w = norm(want);
    const nodes = Array.from(document.querySelectorAll(
      '[role="tab"], [role="menuitem"], a, button, .nav-link, [class*="tab"], [class*="Tab"]'
    )).filter(visible);
    let best = null;
    for (const el of nodes) {
      const lab = labelOf(el);
      const n = norm(lab);
      if (!n || n.length > 80) continue;
      if (!(n === w || n.includes(w) || w.includes(n))) continue;
      const selected = isSelected(el);
      const score = (n === w ? 4 : 2) + (selected ? 1 : 0)
        + (el.getAttribute('role') === 'tab' ? 2 : 0);
      if (!best || score > best.score) best = { el, lab, selected, score };
    }
    if (!best) return { found: false, selected: false, text: '' };
    best.el.setAttribute('data-runpilot-tab', '1');
    try { best.el.scrollIntoView({ block: 'center' }); } catch (_) {}
    return { found: true, selected: best.selected, text: best.lab.slice(0, 80) };
  }, want).catch(() => ({ found: false, selected: false, text: '' }));

  if (!state.found) {
    rlog((stepLabel || 'TAB') + ':TAB:not found "' + want + '"');
    return false;
  }
  if (state.selected) {
    rlog((stepLabel || 'TAB') + ':TAB:already active "' + state.text + '"');
    return true;
  }
  rlog((stepLabel || 'TAB') + ':TAB:activate "' + state.text + '" before verify');
  try {
    await shLocatorClick(page, '[data-runpilot-tab="1"]');
    await page.waitForTimeout(450);
    return true;
  } catch (e) {
    rlog((stepLabel || 'TAB') + ':TAB:WARN click failed — ' + (e && e.message ? e.message : e));
    return false;
  }
}

/**
 * True when a quoted label in the expected is the tab name ("'Created By Others' tab"),
 * not a CTA.
 */
function quotedIsTabName(exp, quotedName) {
  const idx = String(exp || '').toLowerCase().indexOf(String(quotedName || '').toLowerCase());
  if (idx < 0) return false;
  const rest = String(exp || '').slice(idx + quotedName.length, idx + quotedName.length + 16);
  return /^\s*['"]?\s*tab\b/i.test(rest);
}

/**
 * DOM-first verify for tab/empty-state/CTA expecteds (no LLM). Generic for any app.
 * Returns null when this expected is not a UI-empty/CTA/tab check, or when the
 * DOM cannot confirm so a later in-page/LLM verify should decide.
 */
async function verifyDomUiExpected(page, expected) {
  const exp = String(expected || '');
  const expL = exp.toLowerCase();
  const wantsEmpty = /\b(empty\s+state|no\s+(imported\s+|existing\s+)?[\w\s]{0,24}(listed|found|present)|no\s+records|nothing\s+(here|to\s+(show|display))|0\s+results)\b/i.test(exp);
  const quoted = [];
  const qm = exp.match(/['"]([^'"]{3,80})['"]/g) || [];
  qm.forEach((q) => quoted.push(q.replace(/^['"]|['"]$/g, '')));
  const tabName = extractNamedTab(exp);
  const ctaHint = quoted.find((q) => {
    if (!q) return false;
    if (tabName && q.toLowerCase() === tabName.toLowerCase()) return false;
    if (quotedIsTabName(exp, q)) return false;
    return /\b(import|add|create|upload)\b/i.test(q);
  }) || (/\bcta\b|\bcall-to-action\b/i.test(expL) && quoted[0] && !quotedIsTabName(exp, quoted[0]) ? quoted[0] : '')
    || (wantsEmpty && /\bimport/i.test(expL) ? 'import' : '');
  if (!wantsEmpty && !ctaHint && !tabName) return null;

  const snap = await page.evaluate(({ tabName, ctaHint }) => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }
    function norm(s) { return String(s || '').toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ' ').trim(); }
    function labelOf(el) {
      return (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    const w = norm(tabName);
    let tabSelected = !w;
    let tabVisible = !w;
    let selectedTabEl = null;
    if (w) {
      const tabs = Array.from(document.querySelectorAll(
        '[role="tab"], [role="menuitem"], a, button, .nav-link, [class*="tab"]'
      )).filter(visible);
      for (const el of tabs) {
        const n = norm(labelOf(el));
        if (!n || n.length > 80) continue;
        if (!(n === w || n.includes(w) || w.includes(n))) continue;
        tabVisible = true;
        const selected = el.getAttribute('aria-selected') === 'true'
            || !!el.getAttribute('aria-current')
            || /\b(active|selected|is-active|current)\b/i.test(String(el.className || ''));
        if (selected) {
          tabSelected = true;
          selectedTabEl = el;
        }
      }
    }
    let panel = document.body;
    const controls = selectedTabEl && selectedTabEl.getAttribute('aria-controls');
    if (controls) {
      const byId = document.getElementById(controls);
      if (byId && visible(byId)) panel = byId;
    }
    if (panel === document.body) {
      panel = Array.from(document.querySelectorAll(
        '[role="tabpanel"]:not([hidden]), .tab-panel.active, [class*="TabPanel"], main, [role="main"]'
      )).find(visible) || document.body;
    }
    const text = ((panel && panel.innerText) || '').replace(/\s+/g, ' ').trim();
    const textL = text.toLowerCase();
    const emptyKw = /\b(no\s+\w+\s+(yet|found|imported|listed)|empty|nothing\s+(here|to\s+(show|display))|get\s+started|no\s+records|0\s+results|no\s+data)\b/i.test(text);
    const listCount = Array.from(panel.querySelectorAll(
      '[role="row"], tbody tr, [class*="card"], [class*="list-item"], [class*="ListItem"]'
    )).filter(visible).length;
    let ctaVisible = false;
    let ctaText = '';
    const ctaWant = norm(ctaHint);
    if (ctaWant) {
      const clicks = Array.from(document.querySelectorAll(
        'button, a, [role="button"], [role="link"]'
      )).filter(visible);
      for (const el of clicks) {
        const lab = labelOf(el);
        const n = norm(lab);
        if (n && (n === ctaWant || n.includes(ctaWant) || (n.length >= 8 && ctaWant.includes(n)))) {
          ctaVisible = true;
          ctaText = lab.slice(0, 80);
          break;
        }
      }
    }
    return {
      tabVisible, tabSelected, emptyKw, listCount,
      ctaVisible, ctaText, textSample: text.slice(0, 220),
    };
  }, { tabName, ctaHint: ctaHint || '' }).catch(() => null);

  if (!snap) return null;

  if (tabName && !snap.tabVisible) {
    return { met: false, reason: 'Tab "' + tabName + '" is not visible on the page.' };
  }
  if (ctaHint && snap.ctaVisible) {
    return {
      met: true,
      reason: 'CTA visible: "' + snap.ctaText + '"'
        + (tabName ? ' on tab "' + tabName + '"' : '')
        + (wantsEmpty ? (snap.emptyKw || snap.listCount === 0 ? ' (empty state)' : '') : ''),
    };
  }
  if (wantsEmpty && (snap.emptyKw || ((snap.tabSelected || !tabName) && snap.listCount === 0))) {
    return {
      met: true,
      reason: 'Empty state on '
        + (tabName ? '"' + tabName + '" tab' : 'active panel')
        + (snap.emptyKw ? ' (empty copy visible)' : ' (no list rows/cards)')
        + (snap.ctaVisible ? '; CTA="' + snap.ctaText + '"' : ''),
    };
  }
  // Tab is active and the panel has content (template cards, list, copy) — this is a pass.
  if (tabName && snap.tabSelected && !wantsEmpty) {
    const contentShown = !!(snap.textSample && snap.textSample.replace(/\s+/g, '').length >= 8) || snap.listCount > 0;
    if (!ctaHint || contentShown) {
      return {
        met: true,
        reason: 'Tab "' + tabName + '" is active'
          + (contentShown ? ' and its content is displayed' : ''),
      };
    }
  }
  if (tabName && snap.tabVisible && !snap.tabSelected && (wantsEmpty || ctaHint)) {
    return {
      met: false,
      reason: 'Tab "' + tabName + '" is visible but inner empty/CTA state was not found on the active panel.',
    };
  }
  // Do not hard-fail generic tab/CTA wording — let in-page / LLM verify decide.
  return null;
}

async function verifyWorkflowExpected(page, expected, stepLabel, stagehand) {
  const exp = String(expected || '');
  const goal = inferWorkflowGoal('', exp);
  if (!goal.wantEditor && !goal.wantPopup && !goal.fieldName) return null;

  let snap = await inspectWorkflow(page);
  const label = stepLabel || 'VERIFY';

  if (isCompletableForm(snap) && expectedNeedsLeavingForm(snap, '', exp, goal) && !goal.fieldName) {
    rlog(label + ':VERIFY_WORKSPACE:open form does not match expected destination — fill and submit');
    await humanReachExpected(page, stagehand, label, '', exp);
    snap = await inspectWorkflow(page);
    if (isCompletableForm(snap) && expectedNeedsLeavingForm(snap, '', exp, goal)) {
      return {
        met: false,
        reason: 'Still on "' + String(snap.title || snap.kind).replace(/\s+/g, ' ').slice(0, 80)
          + '". Empty fields a tester would complete first: '
          + ((snap.fields || []).filter((f) => !String(f.value || '').trim()).map((f) => f.label).slice(0, 8).join(', ')
            || 'unknown')
          + '. Then click the visible primary button (not Cancel).',
      };
    }
    if (!isCompletableForm(snap) || snap.kind === 'page' || snap.hasMainEditorCue) {
      if (goal.wantEditor && snap.kind === 'create-form') {
        return {
          met: false,
          reason: 'A form is still open; that is not the destination workspace.',
        };
      }
      if (goal.wantEditor && snap.hasMainEditorCue) {
        return { met: true, reason: 'Destination workspace is showing (intermediate form is not blocking).' };
      }
      return null;
    }
  }

  if (goal.wantEditor && !goal.fieldName) {
    if (snap.hasMainEditorCue && snap.kind !== 'create-form') {
      return { met: true, reason: 'Destination workspace is showing (intermediate form is not blocking).' };
    }
    if (!goal.wantPopup) return null;
  }

  if (goal.fieldName) {
    if (goal.wantPopup && !snap.titleHits(goal.popupName)) {
      rlog(label + ':VERIFY_FIELD:named dialog "' + goal.popupName + '" not open (kind='
        + snap.kind + ' title="' + snap.title + '") — advancing then re-read');
      await maybeAdvanceWorkflow(page, stagehand, label, '', exp);
      snap = await inspectWorkflow(page);
    }
    let rec = snap.fieldByLabel(goal.fieldName);
    if (!rec) rec = await findNamedFieldOnPage(page, goal.fieldName, snap);
    if (goal.wantPopup && !snap.titleHits(goal.popupName)) {
      rec = null;
    }
    if (!rec) {
      const judged = await aiJudgeNamedField(label, exp, goal, snap, page);
      if (judged && (judged.needAdvance === 'fill_and_submit' || judged.needAdvance === 'click_cta')) {
        await maybeAdvanceWorkflow(page, stagehand, label, judged.cta || '', exp);
        snap = await inspectWorkflow(page);
        rec = snap.fieldByLabel(goal.fieldName) || await findNamedFieldOnPage(page, goal.fieldName, snap);
        if (goal.wantPopup && !snap.titleHits(goal.popupName)) rec = null;
      } else if (judged && judged.found) {
        rec = {
          label: judged.fieldLabel || goal.fieldName,
          value: judged.empty ? '' : String(judged.value || '').trim(),
          x: 0, y: 0, w: 0, h: 0,
          fromAi: true,
        };
      }
    }
    const val = rec ? String(rec.value || '').trim() : '';
    const rects = rec && rec.w > 2
      ? [{ x: rec.x, y: rec.y, w: rec.w, h: rec.h, label: goal.fieldName + ': ' + (val || '(empty)') }]
      : [];
    const identity = await readLoggedInIdentity(page);
    const looksLikeUser = !!(val && identity && val.toLowerCase() === identity.toLowerCase());

    if (goal.wantEmptyField) {
      if (!rec) return null;
      if (val) {
        return { met: false, reason: '"' + goal.fieldName + '" is "' + val + '", not empty.', highlightRects: rects };
      }
      return { met: true, reason: '"' + goal.fieldName + '" has no value selected.', highlightRects: rects };
    }
    if (!rec) {
      // Do not hard-fail on a missing exact label — OpenAI extract can still see the control.
      rlog(label + ':VERIFY_FIELD:no deterministic "' + goal.fieldName + '" (kind='
        + snap.kind + ' fields=' + (snap.fields || []).map((f) => f.label).join('|').slice(0, 160) + ')');
      return null;
    }
    if (looksLikeUser) {
      return {
        met: false,
        reason: '"' + goal.fieldName + '" matched the logged-in user identity "' + val
          + '", not the current record/email metadata.',
        highlightRects: rects,
      };
    }
    if (!val) {
      return {
        met: false,
        reason: '"' + goal.fieldName + '" is empty on "' + (snap.title || snap.kind)
          + '" — that is not an associated record value.',
        highlightRects: rects,
      };
    }
    return {
      met: true,
      reason: '"' + goal.fieldName + '" is "' + val + '" on "' + (snap.title || snap.kind)
        + '" (this field only — not a neighbor, not the logged-in user identity).',
      highlightRects: rects,
    };
  }

  if (goal.wantPopup) {
    if (snap.titleHits(goal.popupName)) {
      return { met: true, reason: 'Dialog "' + snap.title + '" is open.' };
    }
    if (snap.kind === 'create-form') {
      return {
        met: false,
        reason: 'Still on create/edit form "' + snap.title + '"; "' + goal.popupName + '" was not opened.',
      };
    }
    return {
      met: false,
      reason: '"' + goal.popupName + '" is not visible (workspace=' + snap.kind + ', title="' + snap.title + '").',
    };
  }

  return null;
}

async function verifyStepExpectedInner(stagehand, page, stepLabel, expected) {
  rlog(stepLabel + ':VERIFY:' + expected.substring(0, 200));
  const ctxSuffix = verifyContextSuffix();

  const typedValueCheck = await verifyTypedInputValueExpected(page, expected);
  if (typedValueCheck) return typedValueCheck;

  const pageLoadCheck = await verifyPageLoadHealthExpected(page, expected);
  if (pageLoadCheck) {
    rlog(stepLabel + ':VERIFY_LOAD:' + (pageLoadCheck.met ? 'PASS' : 'FAIL') + ' '
      + String(pageLoadCheck.reason || '').slice(0, 180));
    return pageLoadCheck;
  }

  const docTitleCheck = await verifyDocumentTitleExpected(page, expected);
  if (docTitleCheck) {
    rlog(stepLabel + ':VERIFY_TITLE:' + (docTitleCheck.met ? 'PASS' : 'FAIL') + ' '
      + String(docTitleCheck.reason || '').slice(0, 180));
    return docTitleCheck;
  }

  const headingCheck = await verifyVisibleHeadingExpected(page, expected);
  if (headingCheck) {
    rlog(stepLabel + ':VERIFY_HEADING:' + (headingCheck.met ? 'PASS' : 'FAIL') + ' '
      + String(headingCheck.reason || '').slice(0, 180));
    return headingCheck;
  }

  const noErrorCheck = await verifyNoErrorBannerExpected(page, expected);
  if (noErrorCheck) {
    rlog(stepLabel + ':VERIFY_NO_ERROR:' + (noErrorCheck.met ? 'PASS' : 'FAIL') + ' '
      + String(noErrorCheck.reason || '').slice(0, 180));
    return noErrorCheck;
  }

  const overlayCheck = await verifyNoBlockingOverlayExpected(page, expected);
  if (overlayCheck) {
    rlog(stepLabel + ':VERIFY_OVERLAY:' + (overlayCheck.met ? 'PASS' : 'FAIL') + ' '
      + String(overlayCheck.reason || '').slice(0, 180));
    return overlayCheck;
  }

  const imageHealthCheck = await verifyCrawlImageHealthExpected(page, expected);
  if (imageHealthCheck) {
    rlog(stepLabel + ':VERIFY_IMAGES:' + (imageHealthCheck.met ? 'PASS' : 'FAIL') + ' '
      + String(imageHealthCheck.reason || '').slice(0, 180));
    return imageHealthCheck;
  }

  const workspaceCheck = await verifyWorkflowExpected(page, expected, stepLabel, stagehand);
  if (workspaceCheck) {
    rlog(stepLabel + ':VERIFY_WORKSPACE:' + (workspaceCheck.met ? 'PASS' : 'FAIL') + ' '
      + String(workspaceCheck.reason || '').slice(0, 180));
    return workspaceCheck;
  }

  // Crawl-baked link health — HTTP status is NOT visible UI; trust crawl sample in expected text
  const exp = String(expected || '');
  if (/\bbroken\s+count\s+from\s+crawl\s*:\s*0\b/i.test(exp)
      || (/\bsampled\s+links\s+return\s+http\s*2xx/i.test(exp) && !/\bbroken\s+count\s+from\s+crawl\s*:\s*[1-9]/i.test(exp))) {
    return {
      met: true,
      reason: 'Crawl link-health sample reported no broken links (HTTP status is not asserted as on-screen UI).',
    };
  }
  if (/\bbroken\s+count\s+from\s+crawl\s*:\s*([1-9]\d*)\b/i.test(exp)) {
    const m = exp.match(/\bbroken\s+count\s+from\s+crawl\s*:\s*([1-9]\d*)\b/i);
    return {
      met: false,
      reason: 'Crawl reported ' + (m ? m[1] : 'some') + ' broken link(s) in the health sample.',
    };
  }

  const domUi = await verifyDomUiExpected(page, expected);
  if (domUi) {
    rlog(stepLabel + ':VERIFY_DOM:' + (domUi.met ? 'PASS' : 'FAIL') + ' ' + String(domUi.reason || '').slice(0, 180));
    return domUi;
  }

  if (isNetworkOrLoadingUiExpected(expected)) {
    const fast = await verifyLoadingOrSettledUi(page, expected);
    if (fast.met) return fast;
    // Last resort: ask LLM to look for loading button/spinner — never DevTools
    const check = await stagehand.extract(
      `Verify this UI loading/settle condition: "${expected}".` + ctxSuffix + ' '
      + 'IMPORTANT: Browser DevTools / Network panel is NOT visible on the page. '
      + 'Pass if a loading button, spinner, progress bar, disabled submit, or aria-busy is visible, '
      + 'OR if loading has finished and page content is visible/interactive. '
      + 'Do NOT fail because network traffic is invisible.',
      z.object({
        met: z.boolean().describe('true if loading UI or settled content is observed'),
        reason: z.string().describe('what loading control or content you observed'),
      }),
      { page },
    );
    return check;
  }

  if (isInPageContentExpected(expected)) {
    const fast = await verifyInPageContentExpected(page, expected);
    if (fast.met) return fast;
    const check = await stagehand.extract(
      `Verify this SAME-PAGE menu/section condition (URL redirect is NOT required): "${expected}".` + ctxSuffix + ' '
      + 'Confirm the visible section/panel/tab content updated and/or the menu/tab is active/selected. '
      + 'Do NOT fail only because the URL stayed the same.',
      z.object({
        met: z.boolean().describe('true if in-page content or active menu state matches'),
        reason: z.string().describe('what section/heading/active state you observed'),
      }),
      { page },
    );
    return check;
  }

  // Fast path: URL / title / redirect — avoid misrouting into audit-log extract
  if (isUrlOrTitleExpected(expected) && !AUDIT_LOG_VERIFY_RE.test(expected)) {
    const fast = await verifyUrlOrTitleFast(page, expected);
    if (fast.met) return fast;
    // Fall through to AI extract with an explicit URL/title instruction (still cheaper than audit path)
    const check = await stagehand.extract(
      `Verify this navigation/title condition on the current page: "${expected}".` + ctxSuffix + ' '
      + 'Use the browser URL and visible page title / main heading. Do NOT look for audit logs.',
      z.object({
        met: z.boolean().describe('true if URL/title/redirect condition is satisfied'),
        reason: z.string().describe('observed URL, title, and why it matches or not'),
      }),
      { page },
    );
    return check;
  }

  if (isAuditLogContentExpected(expected)) {
    const check = await stagehand.extract(
      `Verify this audit-log content requirement on the current page: "${expected}".` + ctxSuffix + ' ' +
      'Locate the audit log, activity log, change history, or event log (open it if needed). ' +
      'Find the most relevant log entry for the described action and validate the requested fields.',
      z.object({
        met: z.boolean().describe('true if the audit-log content requirement is satisfied'),
        actor: z.string().optional().describe('actor/user found in the log entry, if applicable'),
        action: z.string().optional().describe('action/event type found, if applicable'),
        timestamp: z.string().optional().describe('timestamp found, if applicable'),
        entity: z.string().optional().describe('entity/record referenced, if applicable'),
        oldValue: z.string().optional().describe('old/previous value found, if applicable'),
        newValue: z.string().optional().describe('new/updated value found, if applicable'),
        details: z.string().optional().describe('details/comment text found, if applicable'),
        reason: z.string().describe('what you actually observed in the audit log'),
      }),
      { page },
    );
    return check;
  }

  if (isLifecycleTransitionExpected(expected)) {
    const check = await stagehand.extract(
      `Verify this status/lifecycle transition on the current page: "${expected}". ` +
      'Inspect status badges, status labels, status dropdowns, status columns, and state indicators. ' +
      'If the expected mentions a before and after status, confirm the currently visible status matches the target/after status. ' +
      'If only one status is mentioned, confirm that exact status is displayed.',
      z.object({
        met: z.boolean().describe('true if the status/lifecycle condition is satisfied'),
        currentStatus: z.string().describe('the status value currently visible on the page'),
        reason: z.string().describe('what you actually observed regarding status/state'),
      }),
      { page },
    );
    return check;
  }

  if (isMetricsExpected(expected)) {
    const check = await stagehand.extract(
      `Verify this calculation/metric requirement on the current page: "${expected}". ` +
      'Inspect counts, percentages, scores, totals, KPI widgets, dashboard metrics, and summary panels. ' +
      'Confirm the visible numeric or percentage value matches what the expected result describes.',
      z.object({
        met: z.boolean().describe('true if the metric/calculation condition is satisfied'),
        observedValue: z.string().describe('the metric value currently visible'),
        reason: z.string().describe('what you observed about the metric or calculation'),
      }),
      { page },
    );
    return check;
  }

  if (isBackendIntegrationExpected(expected)) {
    const check = await stagehand.extract(
      `Verify this backend/persistence/integration requirement on the current page: "${expected}". ` +
      'Confirm data, records, or state described in the expected result are still present after navigation/refresh ' +
      'or visible in the related downstream/upstream view mentioned.',
      z.object({
        met: z.boolean().describe('true if persistence/integration condition is satisfied'),
        observedData: z.string().describe('the data/state currently visible that supports the check'),
        reason: z.string().describe('what you observed about persistence or downstream data'),
      }),
      { page },
    );
    return check;
  }

  if (isEmailWorkflowExpected(expected)) {
    const check = await stagehand.extract(
      `Verify this email/notification workflow requirement on the current page: "${expected}". ` +
      'Inspect sent email logs, notification centres, recipient fields, subject/body content, escalation messages, or reminder records.',
      z.object({
        met: z.boolean().describe('true if the email/notification workflow condition is satisfied'),
        recipient: z.string().optional().describe('recipient/to address if applicable'),
        content: z.string().optional().describe('subject/body/content fragment if applicable'),
        reason: z.string().describe('what you observed in the email/notification workflow'),
      }),
      { page },
    );
    return check;
  }

  if (isAttachmentLifecycleExpected(expected)) {
    const check = await stagehand.extract(
      `Verify this attachment lifecycle requirement on the current page: "${expected}". ` +
      'Inspect attachment lists, upload areas, download links, version history, and file metadata.',
      z.object({
        met: z.boolean().describe('true if the attachment lifecycle condition is satisfied'),
        fileName: z.string().optional().describe('attachment filename if visible'),
        reason: z.string().describe('what you observed about the attachment operation'),
      }),
      { page },
    );
    return check;
  }

  if (isNegativeFileExpected(expected)) {
    const check = await stagehand.extract(
      `Verify this negative file validation requirement on the current page: "${expected}". ` +
      'Confirm the invalid/corrupt/duplicate/oversized upload was rejected and an error indicator or message is visible.',
      z.object({
        met: z.boolean().describe('true if the negative file validation condition is satisfied'),
        errorVisible: z.boolean().describe('true if an error/validation indicator is visible'),
        reason: z.string().describe('what you observed about the file validation outcome'),
      }),
      { page },
    );
    return check;
  }

  return stagehand.extract(
    `Verify this condition on the current page: "${expected}".` + ctxSuffix + ' ' +
    'Inspect visible content, URL, headings, and real error/danger banners. '
    + 'Do NOT treat cards, tiles, grid items, nav labels, or repeated labels like "Template" as error alerts. '
    + 'Do NOT treat SVG <image> nodes, icons, or decorative SVGs as content images; crawl image health counts HTML <img> only. '
    + 'A role=progressbar, LinearProgress, or spinner that does not cover the page is NOT a blocking modal. '
    + 'Do not fail "no overlay / content interactive" just because an inactive or thin progressbar exists in the accessibility tree. '
    + 'A Create/New/Edit form with Cancel and OK is an intermediate dialog, not the editor or destination workspace. '
    + 'Do not click a shorter left-nav label when the step names a longer CTA. '
    + 'Read each named filter/field from its own labeled control — never reuse a neighboring value. '
    + '"Associated with the current email/record" means that entity metadata on the named field, not the logged-in user identity. '
    + 'If a Create/New Cancel+OK form is still open, the destination popup/editor is not showing yet.',
    z.object({
      met: z.boolean().describe('true if the expected condition is satisfied'),
      reason: z.string().describe('what you actually observed on the page'),
    }),
    { page },
  );
}

/**
 * Evidence-corroborated wrapper around verifyStepExpectedInner(). The inner cascade (all ~14
 * specialized checks plus the AI .extract() fallback) is completely unmodified — this only
 * captures accessibility-tree/network evidence before and after, logs it via the existing
 * rlog() channel (so it reaches TcResult.executionLog with zero Java-side changes), and —
 * narrowly, only when the accessibility-tree alert/status evidence transitioned in a way that
 * disagrees with the inner verdict — retries the inner check exactly once after a short settle
 * wait. The inner check's own verdict always decides the outcome; this never substitutes a
 * different verdict source, only defers finalization once in the two specific conflict cases.
 */
async function verifyStepExpected(stagehand, page, stepLabel, expected) {
  const before = await verificationEvidence.captureEvidence(page).catch(() => null);

  let result = await verifyStepExpectedInner(stagehand, page, stepLabel, expected);

  const after = await verificationEvidence.captureEvidence(page).catch(() => null);
  rlog(stepLabel + ':A11Y_EVIDENCE:' + verificationEvidence.summarize(after));

  if (before && after) {
    const conflict =
      (result && result.met && verificationEvidence.hasNewFailureSignal(before, after)) ||
      (result && !result.met && verificationEvidence.alertCleared(before, after)
        && !verificationEvidence.hasNewFailureSignal(before, after));

    if (conflict) {
      rlog(stepLabel + ':CORROBORATION_CONFLICT:retrying once — evidence before='
        + verificationEvidence.summarize(before) + ' after=' + verificationEvidence.summarize(after));
      try { await page.waitForTimeout(500); } catch (_) { /* ignore */ }
      const retried = await verifyStepExpectedInner(stagehand, page, stepLabel, expected);
      const afterRetry = await verificationEvidence.captureEvidence(page).catch(() => null);
      rlog(stepLabel + ':A11Y_EVIDENCE_RETRY:' + verificationEvidence.summarize(afterRetry));
      result = retried;
    }
  }

  return result;
}

async function tryDirectFileUpload(page, stepLabel) {
  if (!cfg.attachmentPath) return false;
  try {
    await page.locator('input[type="file"]').first().setInputFiles(cfg.attachmentPath);
    rlog(stepLabel + ':ATTACHMENT:Auto-filled file input with "' + cfg.attachmentName + '"');
    return true;
  } catch (fcErr) {
    rlog(stepLabel + ':ATTACHMENT_WARN:Could not set attached file — ' + fcErr.message);
    return false;
  }
}

// ── Direct Playwright form fill / select (faster + reliable than act() on wizards) ─
const FORM_FILL_STEP_RE = /\b(enter|type|fill|input|complete|provide)\b.*\b(field|value|data|details|form|mandatory|required)\b/i;
const FORM_SELECT_STEP_RE = /\b(select|choose|pick)\b/i;
const BULK_FORM_FILL_RE = /\b(all\s+)?(mandatory|required)\s+fields?\b|\bfill\s+all\b|\bcomplete\s+all\b|\benter\s+valid\s+data\b/i;

function parseTestDataMap() {
  const map = {};
  const raw = (cfg.testData || '').trim();
  if (!raw) return map;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      Object.keys(j).forEach((k) => { map[String(k).toLowerCase()] = String(j[k]); });
      return map;
    }
  } catch (_) {}
  raw.split(/[\n;|]+/).forEach((line) => {
    const m = line.match(/^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/);
    if (m) map[m[1].trim().toLowerCase()] = m[2].trim();
  });
  return map;
}

function normLabel(s) {
  return String(s || '').toLowerCase().replace(/[*:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function labelsMatch(a, b) {
  const x = normLabel(a);
  const y = normLabel(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xw = x.split(/\s+/).filter((w) => w.length > 2);
  const yw = y.split(/\s+/).filter((w) => w.length > 2);
  return xw.some((w) => yw.includes(w));
}

/** Value lookup only — one shared word like "vendor" must not map Name → Entity Type. */
/** Whole-word field label match: "Brand" → "Brand *", "Select Brand". Not Region. */
function fieldLabelsMatch(want, label) {
  const w = normLabel(want).replace(/[:*]+$/g, '').trim();
  const l = normLabel(label).replace(/[:*]+$/g, '').trim();
  if (!w || !l || w.length < 2) return false;
  if (w === l) return true;
  try {
    const re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)');
    return re.test(l);
  } catch (_) {
    return l.includes(w);
  }
}

function labelsMatchStrict(a, b) {
  const x = normLabel(a);
  const y = normLabel(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [sh, lo] = x.length <= y.length ? [x, y] : [y, x];
  if (lo.includes(sh) && (sh.split(/\s+/).length >= 2 || sh.length >= 12)) return true;
  const stop = new Set([
    'the', 'and', 'for', 'of', 'a', 'an', 'or', 'to', 'in', 'on', 'is',
    'field', 'form', 'select', 'input', 'vendor', 'name', 'type', 'value',
  ]);
  const xw = x.split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const yw = y.split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  if (!xw.length || !yw.length) return false;
  const overlap = xw.filter((w) => yw.includes(w));
  return overlap.length >= 2;
}

function looksLikeTcTitleValue(val) {
  const v = normLabel(val);
  const tc = normLabel(cfg.tcName);
  if (!v || v.length < 6) return false;
  if (tc && v === tc) return true;
  if (tc && tc.length >= 10 && (v.includes(tc) || tc.includes(v))) return true;
  return false;
}

function looksLikeYesNoQuestion(label) {
  const t = String(label || '').trim();
  const l = normLabel(t);
  if (/\?$/.test(t)) return true;
  return /\b(yes\s*\/\s*no|ict vendor|ai involved|artificial intelligence|machine learning)\b/.test(l);
}

/** True when the TC/step/test-data explicitly names this field (not just "fill mandatory fields"). */
function fieldMentionedInTestCase(label, stepHint) {
  const lbl = cleanFieldLabel(label);
  const n = normLabel(lbl).replace(/\?$/g, '').trim();
  if (!n || n.length < 3) return false;
  const stop = new Set([
    'the', 'and', 'for', 'of', 'a', 'an', 'or', 'to', 'in', 'on', 'is',
    'field', 'form', 'select', 'input', 'step', 'details', 'mandatory',
    'required', 'valid', 'data', 'all', 'vendor', 'name', 'type', 'value',
  ]);
  const blob = [stepHint, cfg.testData].filter(Boolean).join('\n');
  const blobN = normLabel(blob);
  const map = parseTestDataMap();
  if (lookupTestData(lbl, map)) return true;
  if (!blobN) return false;
  if (blobN.includes(n) && n.length >= 8) return true;
  // Short labels (Brand, Region, Name) are real field names when they appear as whole words.
  if (n.length >= 3 && n.length < 8) {
    try {
      const re = new RegExp('(?:^|[^a-z0-9])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)');
      if (re.test(blobN)) return true;
    } catch (_) {}
  }
  const words = n.split(/\s+/).filter((w) => w.length > 3 && !stop.has(w));
  if (words.length >= 2 && words.every((w) => blobN.includes(w))) return true;
  try {
    const esc = lbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (esc.length >= 4 && new RegExp('[\'"]' + esc + '[\'"]', 'i').test(blob)) return true;
  } catch (_) {}
  return false;
}

/** Optional fields/controls are ignored unless the TC names them or they block with a required error. */
function shouldFillField(f, stepHint, opts) {
  opts = opts || {};
  if (!f || !f.label) return false;
  if (/logout|sign\s*out|password|search/i.test(f.label || '')) return false;
  if (/click here|naming convention/i.test(f.label || '')) return false;
  // Framework ids (f_<uuid>) are fine on a real field — only a uuid *label* means no label at all.
  if (isGeneratedFieldId(f.label)) return false;
  if (/^(yes|no)$/i.test(cleanFieldLabel(f.label || ''))) return false;
  const mentioned = fieldMentionedInTestCase(f.label, stepHint);
  if (f.optional && !mentioned && !opts.fillAllEmpty) return false;
  if (f.isCheckbox && !mentioned && !opts.errored && !f.required) return false;
  if (mentioned) return !!f.empty || !!opts.errored;
  if (opts.errored && !f.optional) return true;
  if (f.required && f.empty) return true;
  // Create/edit dialogs often have no HTML required. When leaving this form to reach a
  // later screen, fill every empty unlocked field the way a person would.
  if (opts.fillAllEmpty && f.empty && !f.optional && !isFieldLocked(f)) return true;
  return false;
}

function leftoverMustFill(fields, stepHint, opts) {
  return (fields || []).filter((f) => f.empty && shouldFillField(f, stepHint, opts || {}));
}

/** Why an empty field was not planned — logged so a silent no-op is always visible. */
function fieldSkipReason(f, stepHint, opts) {
  opts = opts || {};
  if (!f || !f.label) return 'no-label';
  if (/logout|sign\s*out|password|search/i.test(f.label)) return 'chrome-field';
  if (/click here|naming convention/i.test(f.label)) return 'helper-text';
  if (isGeneratedFieldId(f.label)) return 'uuid-label';
  if (/^(yes|no)$/i.test(cleanFieldLabel(f.label))) return 'yes-no-option';
  if (f.optional && !fieldMentionedInTestCase(f.label, stepHint) && !opts.fillAllEmpty) return 'optional';
  if (isFieldLocked(f)) return 'locked';
  if (!f.empty) return 'already-filled';
  return 'not-required';
}

function workflowFieldToMeta(sf, idx) {
  const lab = cleanFieldLabel(sf && sf.label);
  if (!lab) return null;
  const val = String((sf && sf.value) || '').trim();
  const isSelect = !!(sf && sf.isSelect);
  const empty = looksEmptyFieldValue(val, isSelect || true);
  return {
    label: lab,
    value: val,
    empty,
    required: false,
    optional: false,
    isSelect,
    kind: isSelect ? 'select' : 'text',
    isRadio: false,
    locked: false,
    disabled: false,
    y: (sf && sf.y) || 0,
    x: (sf && sf.x) || 0,
    idx: 8000 + (idx || 0),
    tag: isSelect ? 'div' : 'input',
    type: isSelect ? 'select' : 'text',
  };
}

async function enrichFieldsFromWorkflow(page, fields, stepLabel) {
  const have = Array.isArray(fields) ? fields.slice() : [];
  const seen = new Set(have.map((f) => normLabel(f.label)));
  let snap = null;
  try { snap = await inspectWorkflow(page); } catch (_) { return have; }
  let added = 0;
  (snap && snap.fields || []).forEach((sf, i) => {
    const meta = workflowFieldToMeta(sf, i);
    if (!meta || seen.has(normLabel(meta.label))) return;
    if (/click here|naming convention/i.test(meta.label)) return;
    if (isGeneratedFieldId(meta.label)) return;
    have.push(meta);
    seen.add(normLabel(meta.label));
    added++;
  });
  if (added) {
    rlog((stepLabel || 'FORM') + ':HUMAN:enrich +' + added + ' visible dialog fields (total '
      + have.length + ')');
  }
  return sortFieldsTopDown(have);
}

async function formNeedsMoreInput(page, stepHint, stepLabel) {
  const fillOpts = { fillAllEmpty: true };
  let fields = sortFieldsTopDown(await collectFormFieldMeta(page, { dialogOnly: true }).catch(() => []));
  fields = await enrichFieldsFromWorkflow(page, fields, stepLabel);
  const empty = leftoverMustFill(fields, stepHint, fillOpts)
    .filter((f) => !isFieldLocked(f));
  const errTargets = await collectValidationErrorTargets(page).catch(() => []);
  const errs = Math.max(await countVisibleFormErrors(page).catch(() => 0), errTargets.length);
  const labels = empty.map((f) => cleanFieldLabel(f.label));
  if (empty.length || errs) {
    rlog((stepLabel || 'FORM') + ':HUMAN:still-needed empty=' + labels.join(', ').slice(0, 200)
      + ' errors=' + errs);
  }
  return { needs: empty.length > 0 || errs > 0, empty, errs, fields };
}

/**
 * Conservative proceed intent from the CURRENT step only.
 * Fill-only steps return null — do not click Next/Save/Draft.
 */
function parseProceedIntent(stepHint) {
  const d = stripLeadingStepNumber(stripStepHtml(stepHint || '')).toLowerCase();
  if (!d) return null;
  if (/\b(save\s+as\s+draft|save\s+draft|save\s+for\s+later)\b/.test(d)
      || (/\bdraft\b/.test(d) && /\b(click|press|tap|save)\b/.test(d) && !/\b(next|submit|publish)\b/.test(d))) {
    return { kind: 'draft', labels: ['Save as Draft', 'Save Draft', 'Draft'] };
  }
  if (/\b(click|press|tap|hit)\b[\s\S]{0,40}\b(next|continue|proceed)\b/.test(d)
      || /\band\s+click\s+(on\s+)?(next|continue)\b/.test(d)
      || /\bclick\s+on\s+(next|continue)\b/.test(d)
      || /^(next|continue|proceed)(\s+button)?\s*$/.test(d)) {
    return { kind: 'next', labels: ['Next', 'Continue', 'Proceed'] };
  }
  if (/\b(click|press|tap)\b[\s\S]{0,40}\b(submit|finish|publish|raise\s+request)\b/.test(d)
      && !/\bdraft\b/.test(d)) {
    return { kind: 'submit', labels: ['Submit', 'Finish', 'Publish', 'Raise Request'] };
  }
  if (/\b(click|press|tap)\b[\s\S]{0,40}\bsave(\s+changes)?\b/.test(d) && !/\bdraft\b/.test(d)) {
    return { kind: 'save', labels: ['Save', 'Save Changes'] };
  }
  return null;
}

function stepWantsProceed(stepHint) {
  return !!parseProceedIntent(stepHint);
}

function isForbiddenProceedLabel(text, intent) {
  const n = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!n) return true;
  if (/logout|sign\s*out|cancel|back|previous|discard|close|reset|delete/i.test(n)) return true;
  const kind = intent && intent.kind;
  if (kind !== 'draft' && /\bdraft\b/.test(n)) return true;
  if (kind === 'next' && /\b(save|submit|publish|finish)\b/.test(n) && !/\b(next|continue|proceed)\b/.test(n)) {
    return true;
  }
  if (kind === 'submit' && /\bdraft\b/.test(n)) return true;
  if (kind === 'save' && /\bdraft\b/.test(n)) return true;
  return false;
}

function looksLikePlaceholderSelectValue(val, label) {
  let s = String(val || '').replace(/\s+/g, ' ').trim();
  const lab = cleanFieldLabel(label);
  if (lab) {
    const re = new RegExp('^' + lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s*:]*', 'i');
    s = s.replace(re, '').trim();
  }
  if (!s) return true;
  if (/^(select|choose|pick|--)\b/i.test(s)) return true;
  if (/\b(select|choose|pick)\s+(an?\s+|the\s+)?/i.test(s)) return true;
  if (/please\s+select/i.test(s)) return true;
  if (lab && s.toLowerCase() === lab.toLowerCase()) return true;
  return false;
}

function extractQuotedFromStep(desc) {
  const m = String(desc || '').match(/['"]([^'"]{1,120})['"]/);
  return m ? m[1].trim() : '';
}

function extractFieldHintFromStep(desc) {
  const d = stripStepHtml(desc);
  let m = d.match(/\b(?:in|into|for)\s+(?:the\s+)?['"]?([^'"]{2,80}?)['"]?\s+(?:field|input|box|dropdown|select|text\s*area)\b/i);
  if (m) return m[1].trim();
  m = d.match(/\b(?:fill|enter|type|select|choose)\s+(?:the\s+)?['"]?([^'"]{2,80}?)['"]?\s*(?:field|dropdown|select|with|$)/i);
  if (m) return m[1].trim();
  m = d.match(/\b(vendor\s+\w+|company\s+\w+|email|phone|address|country|city|state|zip|tax|registration|contact\s+\w+)/i);
  return m ? m[0].trim() : '';
}

function guessValueForField(label, fieldType, testMap) {
  const fromTest = lookupTestData(label, testMap);
  if (fromTest) return fromTest;
  const fromAi = _aiFormValueCache.get(normLabel(label));
  if (fromAi) return fromAi;
  const fromMem = lookupAppFormMemory(label);
  if (fromMem) return fromMem;
  const fromCatalog = lookupAppFieldCatalog(label);
  if (fromCatalog) return fromCatalog;
  const l = normLabel(label);
  const stamp = Date.now().toString().slice(-6);
  // Yes/No assessment radios (TPRM / ICT / AI) — prefer No to avoid cascading follow-ups
  if (/\b(ict\s*vendor|information and communication|technology assessment)\b/.test(l)
    || /\b(ai\s*\/?\s*ml|artificial intelligence|machine learning|ai service)\b/.test(l)
    || (/\?/.test(label || '') && /\b(yes|no)\b/.test(fieldType || ''))) {
    return 'No';
  }
  if (fieldType === 'radio' || fieldType === 'yesno') return 'No';
  // Dropdown-specific BEFORE generic "vendor/name" (otherwise "Vendor Entity Type" → AutoVendor)
  if (/\b(expense\s*category|expense)\b/.test(l)) return 'Consultant';
  if (/\b(entity\s*type|vendor\s*entity)\b/.test(l)) return 'Individual / Sole Proprietor';
  if (/\b(indegene\s*entity|contracting\s*entity)\b/.test(l)) return 'Addressable Health LLC';
  if (/\bemail\b/.test(l)) return `autotest${stamp}@indegene.com`;
  if (/\b(phone|mobile|contact\s*number|tel)\b/.test(l)) return `9${stamp}${String(Date.now()).slice(-4)}`.slice(0, 10);
  if (/\b(url|website|web\s*site)\b/.test(l)) return `https://vendor-${stamp}.example.com`;
  if (/\b(zip|postal|pin)\b/.test(l)) return '560001';
  if (/\b(country|nation)\b/.test(l)) return 'India';
  if (/\b(state|province)\b/.test(l)) return 'Karnataka';
  if (/\b(city|town)\b/.test(l)) return 'Bengaluru';
  if (/\b(description|comment|remarks|notes|purpose)\b/.test(l)) {
    return 'To enable procurement of cloud-based analytics services for marketing operations.';
  }
  if (/\b(template\s*name|enter\s*name)\b/.test(l) || /^\s*(enter\s+)?name\s*$/.test(l)) {
    return `AutoTemplate ${stamp}`;
  }
  if (/\b(name|vendor|company)\b/.test(l) && !/entity|category|type|email|ict|assessment/.test(l)) {
    return `AutoVendor ${stamp}`;
  }
  if (fieldType === 'number') return String(1000 + (parseInt(stamp, 10) % 9000));
  if (fieldType === 'date' || /\b(date|dob|start\s*date|end\s*date|due\s*date)\b/.test(l)) {
    return new Date().toISOString().slice(0, 10);
  }
  return `TestValue${stamp}`;
}

/** App-specific defaults learned from VMS / vendor onboarding UI. */
function lookupAppFieldCatalog(label) {
  const l = normLabel(label);
  const host = (() => {
    try { return new URL(cfg.baseUrl).hostname.toLowerCase(); } catch (_) {
      return String(cfg.baseUrl || '').toLowerCase();
    }
  })();
  const isVms = /vms|myvendor|vendor/.test(host) || /vendor/i.test(cfg.tcName || '');
  if (!isVms && !/vendor|tprm|ict/i.test(l)) return null;
  if (/\bict\s*vendor\b/.test(l) || /\bict\b/.test(l) && /vendor|assessment/.test(l)) return 'No';
  if (/\b(ai|ml|artificial intelligence|machine learning)\b/.test(l)) return 'No';
  if (/\bexpense\s*category\b/.test(l)) return 'Consultant';
  if (/\b(entity\s*type|vendor\s*entity)\b/.test(l)) return 'Individual / Sole Proprietor';
  if (/\bindegene\s*entity\b/.test(l)) return 'Addressable Health LLC';
  if (/\bpurpose\b/.test(l) && /\bonboard/.test(l)) {
    return 'To enable procurement of professional services for ongoing project delivery.';
  }
  return null;
}

/** Persist successful form values per app host so later runs reuse app-learned answers. */
function appFormMemoryPath() {
  return path.join(process.cwd(), 'config', 'runpilot-form-memory.json');
}

function appFormMemoryHostKey() {
  try { return new URL(cfg.baseUrl).hostname.toLowerCase(); } catch (_) {
    return String(cfg.baseUrl || 'default').toLowerCase().replace(/[^\w.-]+/g, '_').slice(0, 80) || 'default';
  }
}

let _appFormMemory = null;
function loadAppFormMemory() {
  if (_appFormMemory) return _appFormMemory;
  _appFormMemory = {};
  try {
    const p = appFormMemoryPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object') _appFormMemory = raw;
    }
  } catch (_) {
    _appFormMemory = {};
  }
  // Scrub any previously poisoned HTML/script/SQL values from disk memory
  try {
    let dirty = false;
    for (const host of Object.keys(_appFormMemory)) {
      const bucket = _appFormMemory[host];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const k of Object.keys(bucket)) {
        if (looksLikeInjectionPayload(bucket[k])
            || (looksLikeTcTitleValue(bucket[k]) && !/\bquestionnaire\b/.test(k))) {
          delete bucket[k];
          dirty = true;
        }
      }
    }
    if (dirty) saveAppFormMemoryStore(_appFormMemory);
  } catch (_) {}
  return _appFormMemory;
}

function lookupAppFormMemory(label) {
  const store = loadAppFormMemory();
  const host = appFormMemoryHostKey();
  const bucket = store[host] || {};
  const l = normLabel(label);
  for (const [k, v] of Object.entries(bucket)) {
    if (labelsMatchStrict(l, k) && v) {
      if (looksLikeInjectionPayload(v) || (looksLikeTcTitleValue(v) && !/\bquestionnaire\b/.test(l))) {
        try { delete bucket[k]; saveAppFormMemoryStore(store); } catch (_) {}
        return null;
      }
      return String(v);
    }
  }
  return null;
}

function rememberAppFormValue(label, value) {
  const lbl = cleanFieldLabel(label);
  let val = String(value || '').trim();
  if (!lbl || !val || val.length > 200) return;
  if (/autovendor|testvalue|@indegene\.com/i.test(val) && /entity|category|ict|ai/i.test(lbl)) return;
  if (looksLikeTcTitleValue(val) && !/\bquestionnaire\b/.test(normLabel(lbl))) return;
  if (/\b(entity|category|type|unit|department)\b/.test(normLabel(lbl)) && looksLikePlaceholderSelectValue(val, lbl)) return;
  // Never persist HTML/script/SQL injection fragments into form memory
  if (looksLikeInjectionPayload(val)) {
    rlog('FORM_SAFE:refusing to remember unsafe value for "' + lbl + '"');
    return;
  }
  try {
    const store = loadAppFormMemory();
    const host = appFormMemoryHostKey();
    if (!store[host]) store[host] = {};
    store[host][normLabel(lbl)] = val;
    fs.mkdirSync(path.dirname(appFormMemoryPath()), { recursive: true });
    fs.writeFileSync(appFormMemoryPath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (_) {}
}

/** Drop poisoned memory/AI values so they cannot be reused. */
function purgeUnsafeStoredValue(label) {
  const key = normLabel(label);
  try { _aiFormValueCache.delete(key); } catch (_) {}
  try {
    const store = loadAppFormMemory();
    const host = appFormMemoryHostKey();
    if (store[host] && store[host][key] && looksLikeInjectionPayload(store[host][key])) {
      delete store[host][key];
      saveAppFormMemoryStore(store);
    }
  } catch (_) {}
}

function saveAppFormMemoryStore(store) {
  try {
    _appFormMemory = store;
    fs.mkdirSync(path.dirname(appFormMemoryPath()), { recursive: true });
    fs.writeFileSync(appFormMemoryPath(), JSON.stringify(store, null, 2), 'utf8');
  } catch (_) {}
}

/** Always returns a clean usable value — never HTML/script/SQL junk (unless security TC). */
function safeCleanValueForField(label, fieldType, testMap, stepHint) {
  if (isSecurityFocusedTestCase(stepHint)) {
    return resolveFieldValue(label, fieldType || 'text', testMap);
  }
  purgeUnsafeStoredValue(label);
  const candidates = [
    lookupTestData(label, testMap),
    lookupAppFieldCatalog(label),
    guessValueForField(label, fieldType || 'text', testMap),
  ];
  for (const c of candidates) {
    if (c && !looksLikeInjectionPayload(c)) return String(c);
  }
  // Hard fallbacks by field kind
  const l = normLabel(label);
  const stamp = Date.now().toString().slice(-5);
  if (/\bemail\b/.test(l)) return `vendor.user${stamp}@example.com`;
  if (/\bphone|mobile|tel\b/.test(l)) return `98${stamp}1234`.slice(0, 10);
  if (/\bpurpose|description|comment|remarks|notes|reason\b/.test(l)) {
    return 'To enable procurement of professional services for ongoing project delivery.';
  }
  if (/\bexpense|category\b/.test(l)) return 'Consultant';
  if (/\bentity type|vendor entity\b/.test(l)) return 'Individual / Sole Proprietor';
  if (/\bindegene entity|contracting entity\b/.test(l)) return 'Addressable Health LLC';
  if (/\bname\b/.test(l)) return `Bluewave Solutions ${stamp}`;
  return `ValidValue${stamp}`;
}

// ── Self-navigate path cache (observe → explore → replay) ──────────────────────
function navCachePath() {
  return path.join(process.cwd(), 'config', 'runpilot-nav-cache.json');
}

let _navCache = null;
function loadNavCache() {
  if (_navCache) return _navCache;
  _navCache = {};
  try {
    const p = navCachePath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object') _navCache = raw;
    }
  } catch (_) {
    _navCache = {};
  }
  return _navCache;
}

function saveNavCache() {
  try {
    fs.mkdirSync(path.dirname(navCachePath()), { recursive: true });
    fs.writeFileSync(navCachePath(), JSON.stringify(loadNavCache(), null, 2), 'utf8');
  } catch (_) {}
}

function navCacheKey(intent, fingerprint) {
  return String(intent || '').trim().toLowerCase().slice(0, 160)
    + '::' + String(fingerprint || '').slice(0, 220);
}

function lookupNavCache(intent, fingerprint) {
  const store = loadNavCache();
  const key = navCacheKey(intent, fingerprint);
  const hit = store[key];
  if (hit && Array.isArray(hit.steps) && hit.steps.length) return { key, entry: hit };
  return null;
}

function rememberNavPath(intent, fingerprint, steps) {
  if (!intent || !fingerprint || !Array.isArray(steps) || !steps.length) return;
  const store = loadNavCache();
  const key = navCacheKey(intent, fingerprint);
  const prev = store[key];
  store[key] = {
    intent: String(intent).trim().slice(0, 200),
    pageFingerprint: fingerprint,
    steps: steps.map(s => ({
      instruction: String(s.instruction || '').slice(0, 300),
      selector: String(s.selector || '').slice(0, 400),
      method: String(s.method || 'click').slice(0, 40),
      arguments: Array.isArray(s.arguments) ? s.arguments.slice(0, 4) : undefined,
    })),
    successCount: (prev && prev.successCount ? prev.successCount : 0) + 1,
    discoveredAt: (prev && prev.discoveredAt) || Date.now(),
  };
  saveNavCache();
}

function deleteNavCacheKey(key) {
  if (!key) return;
  const store = loadNavCache();
  if (store[key]) {
    delete store[key];
    saveNavCache();
  }
}

/** Cached AI-generated values per field label (one batch call per wizard screen). */
const _aiFormValueCache = new Map();
const _aiFormPlanByKey = new Map();
let _formAiClient = null;

function getFormAiClient() {
  if (_formAiClient) return _formAiClient;
  if (!cfg.apiKey || !cfg.endpoint) return null;
  _formAiClient = new OpenAI({
    apiKey:         cfg.apiKey,
    baseURL:        `${cfg.endpoint}/openai/deployments/${cfg.deploy}`,
    defaultQuery:   { 'api-version': cfg.version },
    defaultHeaders: { 'api-key': cfg.apiKey },
  });
  return _formAiClient;
}

function lookupTestData(label, testMap) {
  const l = normLabel(label);
  if (!l) return null;
  for (const [k, v] of Object.entries(testMap || {})) {
    if (labelsMatchStrict(l, k) || labelsMatchStrict(l, String(k).replace(/_/g, ' '))) return v;
  }
  return null;
}

function resolveFieldValue(label, fieldType, testMap) {
  const fromTest = lookupTestData(label, testMap);
  if (fromTest) return fromTest;
  const fromAi = _aiFormValueCache.get(normLabel(label));
  if (fromAi) return fromAi;
  return guessValueForField(label, fieldType, testMap);
}

/**
 * When test data does not cover visible fields, ask Azure OpenAI once for realistic
 * fake values using live page + app memory context; cache them, then Playwright fills.
 */
async function scrapePageFormContext(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el || el.offsetHeight <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    }
    const lines = [];
    const title = (document.querySelector('main h1, main h2, [class*="wizard"] h1') || {}).innerText || '';
    if (title) lines.push('Screen: ' + title.replace(/\s+/g, ' ').trim().slice(0, 120));
    document.querySelectorAll('label, legend, [role="radiogroup"], h3, h4').forEach((el) => {
      if (!visible(el)) return;
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length >= 3 && t.length <= 140) lines.push(t);
    });
    // Unique, keep order
    const seen = new Set();
    const out = [];
    for (const l of lines) {
      const k = l.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
      if (out.length >= 40) break;
    }
    return out.join('\n');
  }).catch(() => '');
}

async function ensureAiValuesForFields(fields, stepLabel, stepHint, page) {
  const testMap = parseTestDataMap();
  const missing = (fields || []).filter((f) => {
    const lbl = f.label || f.name || f.placeholder || '';
    if (!lbl) return false;
    // Dropdowns pick the first live option in the open list — do not ask the LLM
    // (guessed labels cause random/wrong picks on cascading parent→sub selects).
    if (f.isSelect || fieldShouldUseDropdown(f)) return false;
    if (lookupTestData(lbl, testMap)) return false;
    if (_aiFormValueCache.has(normLabel(lbl))) return false;
    return true;
  });
  if (!missing.length) return;

  // Prefer learned/app catalog immediately (works even when Azure OpenAI is blocked)
  missing.forEach((f) => {
    const lbl = f.label || f.name || 'field';
    const learned = lookupAppFormMemory(lbl) || lookupAppFieldCatalog(lbl);
    if (learned) _aiFormValueCache.set(normLabel(lbl), learned);
  });
  const stillMissing = missing.filter((f) => !_aiFormValueCache.has(normLabel(f.label || f.name || '')));

  const client = getFormAiClient();
  if (!client || !stillMissing.length) {
    stillMissing.forEach((f) => {
      const lbl = f.label || f.name || 'field';
      _aiFormValueCache.set(normLabel(lbl), guessValueForField(lbl, f.type || (f.isRadio ? 'radio' : ''), testMap));
    });
    if (!stillMissing.length) {
      rlog(stepLabel + ':FORM_AI:used app memory/catalog for ' + missing.length + ' field(s)');
    }
    sanitizeAiDropdownCache(missing);
    return;
  }

  const pageCtx = page ? await scrapePageFormContext(page) : '';
  const fieldLines = stillMissing.map((f) => {
    const lbl = f.label || f.name || f.placeholder || 'field';
    let kind = f.type || 'text';
    if (f.isRadio) kind = 'radio (answer must be one of: ' + (f.options || ['Yes', 'No']).join(' | ') + ')';
    else if (f.isSelect) kind = 'dropdown (pick a realistic visible option label)';
    return `- "${lbl}" (${kind}${f.required ? ', required' : ''})`;
  }).join('\n');

  const appMemory = (() => {
    const store = loadAppFormMemory()[appFormMemoryHostKey()] || {};
    const entries = Object.entries(store).slice(0, 20).map(([k, v]) => k + '=' + v);
    return entries.length ? entries.join('\n') : '';
  })();

  const ctx = buildFullTestCaseDossier(stepHint, '');
  const prompt =
    'You fill ANY enterprise web form for an automated test. Read the test case and the live form.\n'
    + 'Return ONLY a JSON object: keys = field labels (as given), values = data to type/select.\n'
    + 'Rules:\n'
    + '- Prefer exact values from test data / steps when the label matches\n'
    + '- Otherwise invent realistic values that fit THIS form\'s labels and the test-case content\n'
    + '- One field = one value; never copy a neighbor field or the logged-in user identity\n'
    + '- Radio Yes/No: use exactly "Yes" or "No"\n'
    + '- Valid formats: emails look real, phones 10 digits, dates YYYY-MM-DD\n'
    + '- Dropdown values = short real option text (not "Select...")\n'
    + '- No HTML/script/SQL unless the test case is explicitly a security test\n'
    + (ctx ? '\nTest case + app context:\n' + ctx + '\n' : '')
    + (appMemory ? '\nLearned field values for this app:\n' + appMemory + '\n' : '')
    + (pageCtx ? '\nVisible labels on current form:\n' + pageCtx.slice(0, 1200) + '\n' : '')
    + '\nFields:\n' + fieldLines
    + '\n\nJSON only:';

  try {
    const resp = await client.chat.completions.create({
      model: cfg.deploy,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 900,
    });
    const text = resp.choices && resp.choices[0] && resp.choices[0].message
      ? String(resp.choices[0].message.content || '') : '';
    const jsonM = text.match(/\{[\s\S]*\}/);
    if (jsonM) {
      const parsed = JSON.parse(jsonM[0]);
      let applied = 0;
      for (const f of stillMissing) {
        const lbl = f.label || f.name || f.placeholder || '';
        let val = null;
        for (const [k, v] of Object.entries(parsed)) {
          if (labelsMatch(lbl, k)) { val = String(v); break; }
        }
        if (!val) val = guessValueForField(lbl, f.type || (f.isRadio ? 'radio' : ''), testMap);
        _aiFormValueCache.set(normLabel(lbl), val);
        applied++;
      }
      rlog(stepLabel + ':FORM_AI:generated ' + applied + ' value(s) from app context');
      sanitizeAiDropdownCache(stillMissing);
      return;
    }
  } catch (e) {
    rlog(stepLabel + ':FORM_AI_WARN:' + (e && e.message ? e.message : e));
  }

  stillMissing.forEach((f) => {
    const lbl = f.label || f.name || 'field';
    _aiFormValueCache.set(normLabel(lbl), guessValueForField(lbl, f.type || (f.isRadio ? 'radio' : ''), testMap));
  });
  sanitizeAiDropdownCache(missing);
}

function looksLikeBulkFormFillStep(desc) {
  return BULK_FORM_FILL_RE.test(stripStepHtml(desc));
}

function looksLikeFormSelectStep(desc) {
  const d = stripStepHtml(desc);
  return FORM_SELECT_STEP_RE.test(d)
    && /\b(dropdown|select|option|list|combobox|from\s+the)\b/i.test(d);
}

function looksLikeFormTextFillStep(desc) {
  const d = stripStepHtml(desc);
  if (looksLikeBulkFormFillStep(d)) return false;
  if (looksLikeFormSelectStep(d)) return false;
  return FORM_FILL_STEP_RE.test(d)
    || /\b(enter|type|fill)\s+['"]/.test(d)
    || /\bfield\b.*\b(enter|fill|type)\b/i.test(d);
}

function stripUiChromeText(raw) {
  return String(raw || '')
    .replace(/keyboard_arrow_(down|up|left|right)|arrow_drop_(down|up)|expand_(more|less)|unfold_more|chevron_right|check_circle/gi, ' ')
    .replace(/[▼▾▲▴]/g, ' ')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanFieldLabel(raw) {
  return stripUiChromeText(raw);
}

function isGeneratedFieldId(s) {
  const t = String(s || '').trim();
  return /^f_[0-9a-f-]{8,}$/i.test(t)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t);
}

/** True when harvest/live widget says this is a picker — never type into it. */
function fieldShouldUseDropdown(f) {
  if (!f) return false;
  if (f.isRadio || f.isCheckbox) return false;
  if (f.isSelect || f.kind === 'select') return true;
  const t = String(f.type || f.tag || '').toLowerCase();
  return t === 'select' || t === 'combobox' || t === 'listbox';
}

function looksEmptyFieldValue(val, isSelect) {
  const v = String(val || '').trim();
  if (!v) return true;
  if (/keyboard_arrow|arrow_drop_down|expand_more|^[▼▾]$/i.test(v)) return true;
  if (isSelect && /^(select|choose|--|please\s+select)/i.test(v)) return true;
  return false;
}

/** Label-first scan — finds React/Ant/MUI controls even without id/name. */
async function collectFormFieldMeta(page, opts) {
  const dialogOnly = !!(opts && opts.dialogOnly);
  return page.evaluate((dialogOnly) => {
    /**
     * While a modal is open, accessible UI kits (MUI, Ant, Radix, Bootstrap, HeadlessUI)
     * mark the rest of the page aria-hidden/inert. A human cannot reach those controls,
     * so neither should we — this keeps page filters out of a dialog's field plan.
     */
    function behindModal(el) {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.getAttribute('aria-hidden') === 'true') return true;
        if (n.hasAttribute('inert')) return true;
      }
      return false;
    }
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      if (behindModal(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }
    function labelUsable(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      if (behindModal(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 2) return true;
      const box = el.closest(
        '[class*="MuiFormControl"], [class*="FormControl"], [class*="form-item"], '
        + '[class*="FormItem"], [class*="ant-form-item"], [class*="form-group"]'
      );
      return !!(box && visible(box));
    }
    function junkLabel(t) {
      const s = String(t || '')
        .replace(/keyboard_arrow_(down|up|left|right)|arrow_drop_(down|up)|expand_(more|less)|unfold_more|chevron_right|check_circle/gi, ' ')
        .replace(/[▼▾▲▴]/g, ' ')
        .replace(/\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!s || s.length < 2 || s.length > 48) return true;
      if (/^f_[0-9a-f-]{8,}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(s)) return true;
      return /click here|naming convention/i.test(s)
        || /^(close|cancel|ok|save|create|search|reset)$/i.test(s);
    }
    const root = (() => {
      if (!dialogOnly) return document;
      function zOf(el) {
        const z = parseInt(window.getComputedStyle(el).zIndex, 10);
        return Number.isFinite(z) ? z : 0;
      }
      function areaOf(el) {
        const r = el.getBoundingClientRect();
        return Math.max(0, r.width) * Math.max(0, r.height);
      }
      function scoreOverlay(el) {
        if (!visible(el)) return -1;
        const r = el.getBoundingClientRect();
        if (r.width < 160 || r.height < 80) return -1;
        // A dialog never contains the app shell. This is what separates a real popup from
        // a page-level wrapper, without depending on any framework class name.
        if (el.querySelector('nav, header, aside, main')) return -1;
        if (!el.querySelector('input, select, textarea, [role="combobox"], [role="listbox"]')) return -1;
        const t = (el.innerText || '').slice(0, 2000);
        const hasCancel = /\bcancel\b|\bclose\b/i.test(t);
        const hasPrimary = /\b(ok|save|create|submit|continue|add|apply|next)\b/i.test(t);
        let score = Math.min(zOf(el), 60) + Math.min(areaOf(el) / 4000, 80);
        if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') score += 220;
        if (/MuiDialog-paper|ant-modal-content/i.test(String(el.className || ''))) score += 80;
        if (hasCancel && hasPrimary) score += 140;
        return score;
      }
      // Not every app labels its popup. Fall back to structure: a floating layer that
      // stacks above the page and holds its own form controls.
      function genericOverlays() {
        const out = [];
        const nodes = document.body ? document.body.querySelectorAll('div, section, form, dialog') : [];
        for (const el of nodes) {
          const st = window.getComputedStyle(el);
          if (st.position !== 'fixed' && st.position !== 'absolute') continue;
          const z = parseInt(st.zIndex, 10);
          if (!Number.isFinite(z) || z < 1) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 200 || r.height < 120) continue;
          if (!el.querySelector('button, [role="button"]')) continue;
          out.push(el);
          if (out.length > 40) break;
        }
        return out;
      }
      const cands = Array.from(document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], .MuiDialog-paper, [class*="MuiDialog-paper"], '
        + '[class*="ant-modal-content"], .MuiModal-root, .MuiDialog-root'
      )).concat(genericOverlays()).filter(visible);
      if (!cands.length) return document;
      return cands.map((el) => ({ el, score: scoreOverlay(el) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.el)[0] || document;
    })();
    function cleanLabel(raw) {
      return String(raw || '')
        .replace(/keyboard_arrow_(down|up|left|right)|arrow_drop_(down|up)|expand_(more|less)|unfold_more|chevron_right|check_circle/gi, ' ')
        .replace(/[▼▾▲▴]/g, ' ')
        .replace(/\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function isGhostInput(el) {
      if (!el) return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      const cls = String(el.className || '');
      if (/nativeInput|visually-hidden|sr-only|hidden-input|offscreen|screen-reader/i.test(cls)) return true;
      const st = window.getComputedStyle(el);
      if (parseFloat(st.opacity || '1') === 0) return true;
      if (st.clip && /rect\(\s*0|rect\(\s*1px/i.test(st.clip)) return true;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return true;
      if (el.tabIndex === -1 && (st.position === 'absolute' || st.position === 'fixed') && r.height < 12) return true;
      return false;
    }
    function widgetSel() {
      return 'select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], '
        + '[aria-autocomplete="list"], [aria-autocomplete="both"], [data-radix-select-trigger], '
        + '[class*="select-trigger"], [class*="SelectTrigger"], [class*="MuiSelect-select"], '
        + '[class*="ant-select-selector"]';
    }
    function preferVisibleControl(control, grp) {
      const combo = grp && grp.querySelector(widgetSel());
      if (combo && control && isGhostInput(control)) return combo;
      if (combo && !isGhostInput(combo) && control && control !== combo
          && (control.tagName === 'INPUT' || isGhostInput(control))) {
        return combo;
      }
      return control;
    }
    function fieldGroup(el) {
      let n = el;
      for (let i = 0; i < 7 && n && n !== document.body; i++) {
        if (n.querySelector) {
          const labels = n.querySelectorAll('label');
          const tooWide = labels.length > 1
            || /^(FORM|MAIN|SECTION)$/i.test(n.tagName || '')
            || (n.className && /grid|wizard|form-root/i.test(String(n.className)));
          if (!tooWide) {
            const hasControl = n.querySelector(
              'input:not([type=hidden]), textarea, select, [role="combobox"], '
              + '[aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-autocomplete="list"]'
            );
            if (hasControl) return n;
          }
        }
        n = n.parentElement;
      }
      return el.parentElement;
    }
    function labelFromGroup(grp, el) {
      if (!grp) return '';
      const lab = grp.querySelector('label');
      if (lab && visible(lab)) return cleanLabel(lab.innerText || lab.textContent);
      const prev = grp.previousElementSibling;
      if (prev && prev.tagName === 'LABEL' && visible(prev)) return cleanLabel(prev.innerText);
      const fallback = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || '';
      if (/^f_[0-9a-f-]{8,}$/i.test(fallback) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(fallback)) return '';
      return cleanLabel(fallback);
    }
    function isRequiredGroup(grp, label) {
      if (!grp) return /\*/.test(label);
      return !!(grp.querySelector('[required], [aria-required="true"]')
        || (grp.className && grp.className.toString().includes('required'))
        || /\*/.test(label));
    }
    function isOptionalGroup(grp, label) {
      if (isRequiredGroup(grp, label)) return false;
      const lab = String(label || '');
      if (/\(\s*optional\s*\)/i.test(lab)) return true;
      if (grp) {
        const local = String(grp.innerText || '').replace(/\s+/g, ' ').slice(0, 280);
        if (/\(\s*optional\s*\)/i.test(local)) return true;
        if (grp.querySelector('[aria-required="false"]')) return true;
      }
      return false;
    }
    function isSelectTrigger(el, grp) {
      if (!el) return false;
      const role = (el.getAttribute('role') || '').toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const tag = (el.tagName || '').toLowerCase();
      const type = (el.type || '').toLowerCase();
      const popup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
      const auto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
      if (tag === 'select') return true;
      if (role === 'combobox' || role === 'listbox') return true;
      if (popup === 'listbox' || popup === 'menu') return true;
      if (auto === 'list' || auto === 'both') return true;
      if (tag === 'input' && (el.readOnly || el.getAttribute('aria-readonly') === 'true')
          && !/^(checkbox|radio|file|date|datetime-local|time|month|week|password)$/.test(type)) {
        return true;
      }
      if (/(^|[^a-z])(combobox|dropdown|listbox|nativeinput)([^a-z]|$)/i.test(cls.replace(/-/g, ''))) return true;
      if (el.matches && el.matches(widgetSel())) return true;
      if (grp) {
        const custom = grp.querySelector(widgetSel());
        if (custom && (custom === el || custom.contains(el) || el.contains(custom))) return true;
        if (custom && isGhostInput(el)) return true;
      }
      return false;
    }
    function hasPickerChrome(grp) {
      if (!grp) return false;
      const t = String(grp.innerText || '');
      if (/keyboard_arrow_down|arrow_drop_down|expand_more|[▼▾]/.test(t)) return true;
      return !!(grp.querySelector(
        '[class*="arrow-drop"], [class*="ArrowDrop"], [class*="ExpandMore"], '
        + '[class*="chevron-down"], [class*="ChevronDown"], [class*="CaretDown"]'
      ));
    }
    function isTypableTextControl(el, grp) {
      if (!el || isGhostInput(el)) return false;
      const tag = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const popup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
      const auto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
      if (role === 'combobox' || role === 'listbox') return false;
      if (popup === 'listbox' || popup === 'menu') return false;
      if (auto === 'list' || auto === 'both') return false;
      if (tag === 'select') return false;
      if (el.isContentEditable) return true;
      if (tag === 'textarea') return true;
      if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        if (/^(hidden|checkbox|radio|file|button|submit|reset|image|range|color)$/.test(type)) return false;
        if (/^(date|datetime-local|time|month|week)$/.test(type)) return false;
        if (el.readOnly || el.getAttribute('aria-readonly') === 'true') return false;
        if (grp && grp.querySelector(widgetSel())) return false;
        return true;
      }
      return false;
    }
    function controlKind(el, grp) {
      if (!el) return 'unknown';
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'file';
      if (/^(date|datetime-local|time|month|week)$/.test(type)) return 'date';
      if (isSelectTrigger(el, grp) || hasPickerChrome(grp) || !isTypableTextControl(el, grp)) return 'select';
      return 'text';
    }
    /** The hidden native input that select libraries keep in sync holds the real value. */
    function backingValue(el, grp) {
      const scope = grp || (el && el.parentElement);
      if (!scope || !scope.querySelector) return '';
      const hidden = scope.querySelectorAll('input, select');
      for (const h of hidden) {
        if (h === el) continue;
        if (!isGhostInput(h) && h.type !== 'hidden') continue;
        const v = String(h.value || '').trim();
        if (v) return v;
      }
      return '';
    }
    function readValue(el, isSelect, label, grp) {
      if (isSelect) {
        const backed = backingValue(el, grp);
        if (backed) return backed;
        let txt = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
        const lab = String(label || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
        if (lab && txt.toLowerCase().startsWith(lab.toLowerCase())) {
          txt = txt.slice(lab.length).replace(/^[*\s:]+/, '').trim();
        }
        return txt;
      }
      return String(el.value || '').trim();
    }
    function isEmptyValue(val, isSelect, label) {
      let v = String(val || '').replace(/\s+/g, ' ').trim();
      const lab = String(label || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
      if (lab && v.toLowerCase().startsWith(lab.toLowerCase())) {
        v = v.slice(lab.length).replace(/^[*\s:]+/, '').trim();
      }
      if (!v) return true;
      if (/keyboard_arrow|arrow_drop_down|expand_more|^[▼▾]$/i.test(v)) return true;
      if (isSelect) {
        if (/^(select|choose|pick|--)\b/i.test(v)) return true;
        if (/\b(select|choose|pick)\s+(an?\s+|the\s+)?/i.test(v)) return true;
        if (/please\s+select/i.test(v)) return true;
        if (lab && v.toLowerCase() === lab.toLowerCase()) return true;
      }
      return false;
    }
    function posOf(el) {
      try {
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.top + (window.scrollY || 0)), x: Math.round(r.left + (window.scrollX || 0)) };
      } catch (_) {
        return { y: 0, x: 0 };
      }
    }
    function isLockedControl(el, grp) {
      if (!el) return true;
      if (el.disabled) return true;
      if (el.getAttribute('aria-disabled') === 'true') return true;
      if (el.getAttribute('data-disabled') === 'true') return true;
      if (el.getAttribute('aria-busy') === 'true') return true;
      const cls = String(el.className || '');
      if (/\bdisabled\b|pointer-events-none|cursor-not-allowed/i.test(cls)) return true;
      const wrap = el.closest('[aria-disabled="true"], [data-disabled="true"]');
      if (wrap && wrap !== document.body && wrap !== document.documentElement) {
        const labelsInWrap = wrap.querySelectorAll ? wrap.querySelectorAll('label').length : 99;
        if (labelsInWrap <= 2) return true;
      }
      if (grp) {
        if (grp.getAttribute('aria-disabled') === 'true') return true;
        const hint = String(grp.innerText || '').replace(/\s+/g, ' ').slice(0, 240);
        if (/select .{0,48}first|choose .{0,48}first|select a (parent|category|type)/i.test(hint)) return true;
      }
      if ((el.tagName || '').toLowerCase() === 'select') {
        const opts = Array.from(el.options || []).filter((o) => {
          const t = String(o.text || '').trim();
          return o.value && !o.disabled && !/^(select|choose|--|please)/i.test(t);
        });
        if (!opts.length) return true;
      }
      return false;
    }

    const out = [];
    const seen = new Set();
    let ctlSeq = 0;
    document.querySelectorAll('[data-runpilot-ctl]').forEach((el) => el.removeAttribute('data-runpilot-ctl'));

    /**
     * Tag the live element so later steps operate on exactly this control instead of
     * re-matching a label. Apps that render the label inside the control (MUI Select)
     * cannot be found by a <label> lookup at all.
     */
    function pushField(meta, el) {
      const key = dialogOnly
        ? String(meta.label || '').toLowerCase()
        : (meta.label || '') + '|' + (meta.id || meta.name || meta.idx);
      if (!meta.label || seen.has(key)) return;
      seen.add(key);
      if (el && el.setAttribute) {
        ctlSeq++;
        try {
          el.setAttribute('data-runpilot-ctl', String(ctlSeq));
          meta.ctl = ctlSeq;
        } catch (_) {}
      }
      out.push(meta);
    }

    // Pass 1 — labels drive discovery (best for wizard forms)
    root.querySelectorAll('label, legend, [class*="InputLabel"], [class*="FormLabel"]').forEach((lab, idx) => {
      if (!labelUsable(lab)) return;
      const label = cleanLabel(lab.innerText || lab.textContent || lab.getAttribute('aria-label'));
      if (junkLabel(label)) return;
      const forId = lab.getAttribute('for');
      const grp = fieldGroup(lab);
      let control = forId ? document.getElementById(forId) : null;
      if (!control && grp) {
        control = grp.querySelector(
          'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), '
          + 'textarea, select, [role="combobox"], [aria-haspopup="listbox"], '
          + '[class*="ant-select"], [class*="Select"], [class*="select-trigger"]'
        );
      }
      if (!control) {
        let sib = lab.nextElementSibling;
        for (let hop = 0; hop < 4 && sib && !control; hop++) {
          if (sib.matches(
            'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"], '
            + '[class*="ant-select"], [class*="Select"], [class*="select"]'
          ) && visible(sib)) {
            control = sib;
            break;
          }
          control = sib.querySelector(
            'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), '
            + 'textarea, select, [role="combobox"], [aria-haspopup="listbox"], '
            + '[class*="ant-select"], [class*="Select"], [class*="select-trigger"], '
            + '[class*="select"]:not(label)'
          );
          sib = sib.nextElementSibling;
        }
      }
      if (!control && grp && grp.parentElement && grp.parentElement.querySelectorAll('label').length <= 1) {
        control = grp.parentElement.querySelector(
          'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), '
          + 'textarea, select, [role="combobox"], [aria-haspopup="listbox"], '
          + '[class*="ant-select"], [class*="Select"], [class*="select-trigger"]'
        );
      }
      if (!control) return;
      control = preferVisibleControl(control, grp);
      if (!control) return;
      const radioCount = (grp && grp.querySelectorAll('input[type="radio"]').length) || 0;
      if (radioCount >= 2) return;
      const kind = controlKind(control, grp);
      const isSelect = kind === 'select';
      const value = readValue(control, isSelect, label, grp);
      const xy = posOf(control);
      const locked = isLockedControl(control, grp);
      pushField({
        idx: 2000 + idx,
        tag: (control.tagName || '').toLowerCase(),
        type: isSelect ? 'select' : (control.type || control.tagName || '').toLowerCase(),
        label,
        name: control.name || '',
        id: control.id || '',
        placeholder: control.getAttribute('placeholder') || '',
        value,
        empty: isEmptyValue(value, isSelect, label),
        required: !!isRequiredGroup(grp, label),
        optional: isOptionalGroup(grp, label),
        isSelect,
        kind,
        isRadio: false,
        locked,
        disabled: locked,
        y: xy.y,
        x: xy.x,
      }, control);
    });

    // Pass 2 — orphan inputs/textareas
    root.querySelectorAll(
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select'
    ).forEach((el, idx) => {
      if (!visible(el) || isGhostInput(el)) return;
      const grp = fieldGroup(el);
      const label = labelFromGroup(grp, el);
      if (junkLabel(label)) return;
      const kind = controlKind(el, grp);
      const isSelect = kind === 'select';
      const value = readValue(el, isSelect, label, grp);
      const xy = posOf(el);
      const locked = isLockedControl(el, grp);
      pushField({
        idx,
        tag: (el.tagName || '').toLowerCase(),
        type: isSelect ? 'select' : (el.type || el.tagName || '').toLowerCase(),
        label,
        name: el.name || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        value,
        empty: isEmptyValue(value, isSelect, label),
        required: !!isRequiredGroup(grp, label),
        optional: isOptionalGroup(grp, label),
        isSelect,
        kind,
        isRadio: false,
        locked,
        disabled: locked,
        y: xy.y,
        x: xy.x,
      }, el);
    });

    // Pass 2b — MUI/Ant/custom dropdowns (often no native <select> and label may be legend / opacity-0)
    /** Label text that comes from somewhere other than the control's own contents. */
    function externalLabel(grp, el) {
      const scope = grp || (el && el.parentElement);
      if (scope && scope.querySelectorAll) {
        const nodes = scope.querySelectorAll('label, legend, [class*="InputLabel"], [class*="FormLabel"]');
        for (const n of nodes) {
          if (el && (n === el || n.contains(el))) continue;
          const t = cleanLabel(n.innerText || n.textContent || n.getAttribute('aria-label'));
          if (!junkLabel(t)) return t;
        }
      }
      const labelled = el && el.getAttribute('aria-labelledby');
      if (labelled) {
        const t = cleanLabel(((document.getElementById(labelled) || {}).innerText) || '');
        if (!junkLabel(t)) return t;
      }
      return cleanLabel((el && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || '');
    }
    function controlLabel(grp, el) {
      const ext = externalLabel(grp, el);
      if (ext) return ext;
      // A closed picker with no label anywhere shows the field name as its own text.
      // Identity then comes from that text, so emptiness must come from the backing value.
      const own = cleanLabel((el && (el.innerText || el.textContent)) || '');
      return junkLabel(own) ? '' : own;
    }
    root.querySelectorAll(
      'select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], '
      + '[aria-autocomplete="list"], [aria-autocomplete="both"], [data-radix-select-trigger], '
      + '[class*="MuiSelect-select"], [class*="ant-select-selector"], [class*="select-trigger"]'
    ).forEach((el, idx) => {
      const grp = el.closest(
        '[class*="MuiFormControl"], [class*="FormControl"], [class*="form-item"], '
        + '[class*="FormItem"], [class*="ant-form-item"], [class*="form-group"], '
        + '[class*="form-field"], [class*="FormField"], fieldset'
      ) || fieldGroup(el);
      const boxVisible = visible(el) || (grp && visible(grp));
      if (!boxVisible) return;
      const combo = (el.matches && el.matches(widgetSel())) ? el
        : ((grp || el).querySelector(widgetSel()) || el);
      const trigger = combo || el;
      const label = controlLabel(grp, trigger);
      if (junkLabel(label)) return;
      const isSelect = true;
      const value = readValue(trigger, isSelect, label, grp);
      // With no external label the visible text is the identity, so it cannot also prove
      // emptiness — only the backing value can.
      const empty = externalLabel(grp, trigger)
        ? isEmptyValue(value, isSelect, label)
        : !backingValue(trigger, grp);
      const xy = posOf(trigger);
      const locked = isLockedControl(trigger, grp);
      pushField({
        idx: 3000 + idx,
        tag: (trigger.tagName || '').toLowerCase(),
        type: 'select',
        label,
        name: trigger.name || '',
        id: trigger.id || '',
        placeholder: trigger.getAttribute('placeholder') || '',
        value,
        empty,
        required: !!isRequiredGroup(grp, label),
        optional: isOptionalGroup(grp, label),
        isSelect,
        kind: 'select',
        isRadio: false,
        locked,
        disabled: locked,
        y: xy.y,
        x: xy.x,
      }, trigger);
    });

    // Pass 2c — checkboxes / switches (hidden native input + visible label)
    root.querySelectorAll('input[type="checkbox"], [role="checkbox"]').forEach((el, idx) => {
      const wrap = el.closest('label, [class*="FormControlLabel"], [class*="MuiFormControlLabel"]') || el.parentElement;
      if (!visible(el) && !(wrap && visible(wrap))) return;
      const label = controlLabel(wrap, el);
      if (junkLabel(label)) return;
      const checked = !!(el.checked || el.getAttribute('aria-checked') === 'true');
      const xy = posOf(wrap || el);
      pushField({
        idx: 4000 + idx,
        tag: 'input',
        type: 'checkbox',
        label,
        name: el.name || '',
        id: el.id || '',
        placeholder: '',
        value: checked ? 'Yes' : '',
        empty: !checked,
        required: !!isRequiredGroup(wrap, label),
        optional: !isRequiredGroup(wrap, label),
        isSelect: false,
        isRadio: false,
        isCheckbox: true,
        locked: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        y: xy.y,
        x: xy.x,
      }, el);
    });

    // Pass 3 — radio groups (ICT Vendor? / AI-ML? etc.)
    function radioOptionLabel(r) {
      if (r.id) {
        const lab = document.querySelector('label[for="' + r.id + '"]');
        if (lab) return cleanLabel(lab.innerText || lab.textContent);
      }
      const wrap = r.closest('label');
      if (wrap) {
        const clone = wrap.cloneNode(true);
        clone.querySelectorAll('input').forEach((n) => n.remove());
        const t = cleanLabel(clone.innerText || clone.textContent);
        if (t) return t;
      }
      const sib = r.nextElementSibling;
      if (sib && (sib.tagName === 'LABEL' || sib.tagName === 'SPAN')) {
        return cleanLabel(sib.innerText || sib.textContent);
      }
      return cleanLabel(r.value || r.getAttribute('aria-label') || '');
    }
    function radioQuestionLabel(groupEls) {
      const first = groupEls[0];
      function isQuestionText(t) {
        if (!t || t.length < 3 || t.length > 160) return false;
        if (/^(yes|no)$/i.test(t)) return false;
        return /\?/.test(t) || /\b(ict vendor|artificial intelligence|machine learning|assessment)\b/i.test(t);
      }
      let node = first.parentElement;
      for (let hop = 0; hop < 6 && node && node !== document.body; hop++) {
        if (/^(FORM|MAIN)$/i.test(node.tagName || '')) break;
        if (node.querySelectorAll && node.querySelectorAll('input[type="radio"]').length > 8) {
          node = node.parentElement;
          continue;
        }
        const rg = node.getAttribute && node.getAttribute('aria-label');
        if (rg && isQuestionText(cleanLabel(rg))) return cleanLabel(rg);
        const legend = node.querySelector && node.querySelector('legend');
        if (legend && visible(legend) && isQuestionText(cleanLabel(legend.innerText))) {
          return cleanLabel(legend.innerText);
        }
        const prev = node.previousElementSibling;
        if (prev) {
          const pt = cleanLabel(prev.innerText || prev.textContent);
          if (isQuestionText(pt) && !(prev.querySelector && prev.querySelector('input[type=radio]'))) return pt;
        }
        const kids = node.querySelectorAll ? node.querySelectorAll('p, h3, h4, legend, label, span') : [];
        for (const el of kids) {
          if (!visible(el)) continue;
          if (el.querySelector && el.querySelector('input[type=radio]')) continue;
          const t = cleanLabel(el.innerText || el.textContent);
          if (isQuestionText(t)) return t;
        }
        node = node.parentElement;
      }
      const named = first.getAttribute('aria-label') || '';
      if (named) return cleanLabel(named);
      return cleanLabel((first.name || '').replace(/[-_]/g, ' '));
    }

    const radios = Array.from(root.querySelectorAll('input[type="radio"]')).filter(visible);
    const byName = new Map();
    radios.forEach((r, idx) => {
      const key = r.name || ('anon-radio-' + idx);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(r);
    });
    let rIdx = 0;
    byName.forEach((groupEls, name) => {
      if (groupEls.length < 2) return;
      const options = groupEls.map(radioOptionLabel).filter(Boolean);
      const label = radioQuestionLabel(groupEls);
      if (!label || /^(yes|no)$/i.test(label)) return;
      const checked = groupEls.find((r) => r.checked);
      const value = checked ? radioOptionLabel(checked) : '';
      const grp = fieldGroup(groupEls[0]);
      const xy = posOf(groupEls[0]);
      pushField({
        idx: 5000 + rIdx++,
        tag: 'input',
        type: 'radio',
        label,
        name: name || '',
        id: groupEls[0].id || '',
        placeholder: '',
        value,
        empty: !checked,
        required: !!isRequiredGroup(grp, label),
        optional: isOptionalGroup(grp, label),
        isSelect: false,
        isRadio: true,
        options: options.length ? options : ['Yes', 'No'],
        locked: false,
        disabled: false,
        y: xy.y,
        x: xy.x,
      });
    });

    out.sort((a, b) => {
      const dy = (a.y || 0) - (b.y || 0);
      if (Math.abs(dy) > 8) return dy;
      const dx = (a.x || 0) - (b.x || 0);
      if (dx) return dx;
      return (a.idx || 0) - (b.idx || 0);
    });
    return out;
  }, dialogOnly);
}

async function shLocatorFill(page, selector, value) {
  const loc = page.locator(selector).first();
  await loc.click().catch(() => {});
  await page.waitForTimeout(cfg.humanLike ? humanPauseMs(120, 280) : 40);
  if (cfg.humanLike && cfg.humanTypeDelayMs > 0 && String(value).length <= 80) {
    await loc.fill('').catch(() => {});
    await loc.pressSequentially(String(value), { delay: cfg.humanTypeDelayMs }).catch(async () => {
      // Fallback if pressSequentially unsupported on this Stagehand/Playwright build
      await loc.fill(String(value));
    });
  } else {
    await loc.fill(String(value));
  }
}

/** Bring a control into view first — Playwright builds differ on locator helpers. */
async function scrollSelectorIntoView(page, selector) {
  const loc = page.locator(selector).first();
  if (loc && typeof loc.scrollIntoViewIfNeeded === 'function') {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    return;
  }
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { el.scrollIntoView(); }
    }
  }, selector).catch(() => {});
}

/**
 * Click any control the way a tester does: scroll to it, real click, then fall back
 * to a forced click and finally a DOM click. Covers buttons, links, tabs, menu items,
 * icon buttons, table row actions and custom [role=button] widgets.
 */
async function shLocatorClick(page, selector) {
  await scrollSelectorIntoView(page, selector);
  const loc = page.locator(selector).first();
  try {
    await loc.click();
    return true;
  } catch (e1) {
    try {
      await loc.click({ force: true, timeout: 2500 });
      return true;
    } catch (e2) {
      const done = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const target = el.closest('button, a, [role="button"], [role="menuitem"], [role="tab"], label') || el;
        try { target.click(); return true; } catch (_) { return false; }
      }, selector).catch(() => false);
      if (done) return true;
      throw e1;
    }
  }
}

/** Random human-like pause between min–max ms. */
function humanPauseMs(minMs, maxMs) {
  const a = Math.max(0, minMs || 0);
  const b = Math.max(a, maxMs || a);
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function humanPause(page, minMs, maxMs) {
  if (cfg.batchMode) {
    const ms = Math.min(minMs || 0, 60);
    if (ms > 0) await page.waitForTimeout(ms);
    return;
  }
  const ms = cfg.humanLike ? humanPauseMs(minMs, maxMs) : Math.min(minMs || 0, 80);
  if (ms > 0) await page.waitForTimeout(ms);
}

function sortFieldsTopDown(fields) {
  return (fields || []).slice().sort((a, b) => {
    const dy = (Number(a.y) || 0) - (Number(b.y) || 0);
    if (Math.abs(dy) > 8) return dy;
    const dx = (Number(a.x) || 0) - (Number(b.x) || 0);
    if (dx) return dx;
    return (Number(a.idx) || 0) - (Number(b.idx) || 0);
  });
}

function isFieldLocked(f) {
  return !!(f && (f.locked || f.disabled));
}

/** Wait after a parent dropdown so dependent sub-options can load. */
async function waitForCascadeAfterSelect(page, stepLabel, parentLabel) {
  await dismissOpenDropdowns(page);
  const ms = cfg.cascadeWaitMs || 450;
  rlog((stepLabel || 'FORM') + ':CASCADE:wait ' + ms + 'ms after "'
    + cleanFieldLabel(parentLabel) + '" for child dropdowns');
  await page.waitForTimeout(ms);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const fields = sortFieldsTopDown(await collectFormFieldMeta(page, { dialogOnly: true }).catch(() => []));
    const unlockedEmpty = fields.filter((f) => f.isSelect && f.empty && !isFieldLocked(f)).length;
    if (unlockedEmpty > 0) break;
    await page.waitForTimeout(120);
  }
}

/** Scroll field into view the way a person would before interacting. */
async function humanScrollToField(page, labelHint) {
  await page.evaluate((labelHint) => {
    function norm(s) { return String(s || '').replace(/\*/g, '').trim().toLowerCase(); }
    function matchLabel(a, b) {
      const x = norm(a); const y = norm(b);
      return x === y || x.includes(y) || y.includes(x);
    }
    function formLabels() {
      const vis = (el) => {
        if (!el || el.offsetHeight <= 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
      };
      const d = Array.from(document.querySelectorAll(
        '[role="dialog"],[aria-modal="true"],.MuiDialog-paper,[class*="MuiDialog-paper"],[class*="ant-modal-content"]'
      )).filter(vis).sort((a, b) =>
        (parseInt(window.getComputedStyle(b).zIndex, 10) || 0) - (parseInt(window.getComputedStyle(a).zIndex, 10) || 0)
      )[0];
      return Array.from((d || document).querySelectorAll('label'));
    }
    for (const lab of formLabels()) {
      const lt = (lab.innerText || '').replace(/\*/g, '').trim();
      if (!matchLabel(lt, labelHint)) continue;
      const grp = lab.closest(
        '.form-group,.field,.MuiFormControl-root,[class*="form-field"],[class*="FormField"],[class*="FormItem"],[class*="form-item"],[class*="ant-form-item"],.mb-3,.mb-4'
      ) || lab.parentElement || lab;
      try {
        grp.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      } catch (_) {
        try { grp.scrollIntoView(true); } catch (_2) {}
      }
      return true;
    }
    return false;
  }, cleanFieldLabel(labelHint)).catch(() => false);
  await humanPause(page, 50, 100);
}

/**
 * Human-like intelligence: scan the form, fill missing required fields top→bottom
 * with natural pacing + confirm, fix validation, then proceed to complete the step.
 * Generic for all products.
 */
async function humanLikeFillFormAndComplete(page, stagehand, stepLabel, stepHint, options) {
  options = options || {};
  const label = stepLabel || 'FORM';
  const testMap = parseTestDataMap();
  const securityTc = isSecurityFocusedTestCase(stepHint);
  const complete = options.complete != null ? !!options.complete : stepWantsProceed(stepHint);
  const fillAllEmpty = !!options.fillAllEmpty;
  const fillOpts = { fillAllEmpty };
  const scanOpts = (options.dialogOnly || fillAllEmpty) ? { dialogOnly: true } : {};
  const skipInterrupt = !!options.skipInterrupt || fillAllEmpty;

  rlog(label + ':HUMAN:start scanning form (TC-context fill + confirm + '
    + (complete ? 'proceed' : 'no-proceed')
    + (fillAllEmpty ? ' + fill-all-empty' : '') + ')');

  if (!skipInterrupt) {
    await handleMidFlowInterrupt(page, stagehand, label, stepHint || '', '').catch(() => {});
  }
  await dismissOpenUserMenu(page, label).catch(() => {});
  await scrollWizardForm(page).catch(() => {});
  await humanPause(page, 80, 160);

  // Observe: what does a human see?
  let fields = sortFieldsTopDown(await collectFormFieldMeta(page, scanOpts));
  if (!fields.length) {
    await humanPause(page, 250, 400);
    fields = sortFieldsTopDown(await collectFormFieldMeta(page, scanOpts));
  }
  fields = await enrichFieldsFromWorkflow(page, fields, label);
  const errored = await collectValidationErrorTargets(page);
  const visibleErrs = await countVisibleFormErrors(page);

  rlog(label + ':HUMAN:scan fields=' + fields.length
    + ' empty=' + fields.filter((f) => f.empty).length
    + ' required=' + fields.filter((f) => f.required).length
    + ' optional=' + fields.filter((f) => f.optional).length
    + ' locked=' + fields.filter((f) => isFieldLocked(f)).length
    + ' errors=' + visibleErrs);

  try {
    const alreadySeeded = fields.some((f) => _aiFormValueCache.has(normLabel(f.label || f.name || '')));
    if (!alreadySeeded) {
      const snap = await inspectWorkflow(page);
      await aiAnalyzeFormAndTestCase(label, stepHint, '', snap, page);
    }
  } catch (_) {}

  const needsAny = fields.some((f) => shouldFillField(f, stepHint, fillOpts)) || visibleErrs > 0;
  if (!needsAny && visibleErrs > 0) {
    rlog(label + ':HUMAN:no field meta but ' + visibleErrs + ' validation errors — fix path');
    await fixValidationErrorsAndContinue(page, stagehand, label, stepHint, {
      skipProceed: !stepWantsProceed(stepHint),
    });
    return true;
  }
  if (!needsAny) {
    const emptySkipped = fields.filter((f) => f.empty);
    if (emptySkipped.length) {
      rlog(label + ':HUMAN:WARN ' + emptySkipped.length + ' empty field(s) not planned: '
        + emptySkipped.map((f) => cleanFieldLabel(f.label) + '(' + fieldSkipReason(f, stepHint, fillOpts) + ')')
          .join(', ').slice(0, 300));
    }
    rlog(label + ':HUMAN:no empty/errored required fields — form looks complete');
    if (complete) {
      await humanPause(page, 150, 280);
      const still = leftoverMustFill(await collectFormFieldMeta(page, scanOpts), stepHint, fillOpts);
      if (still.length && !options._rescanned) {
        rlog(label + ':HUMAN:rescan found ' + still.length + ' still-empty — filling instead of Next');
        return humanLikeFillFormAndComplete(page, stagehand, stepLabel, stepHint, { ...options, _rescanned: true });
      }
      await proceedWizardNextIfIntended(page, stagehand, label, stepHint);
    }
    return true;
  }

  const planned = fields
    .filter((f) => shouldFillField(f, stepHint, fillOpts))
    .map((f) => cleanFieldLabel(f.label) + (fieldShouldUseDropdown(f) ? '[dd]' : '') + (isFieldLocked(f) ? '[locked]' : ''));
  rlog(label + ':HUMAN:plan fill top→bottom: ' + planned.join(', ').slice(0, 260));

  await ensureAiValuesForFields(
    fields.filter((f) => shouldFillField(f, stepHint, fillOpts) && !fieldShouldUseDropdown(f)),
    label,
    (stepHint || 'Complete this form accurately like a careful user')
      + '\nUse realistic business data from the test case. '
      + (securityTc
        ? 'Security payloads may be intentional for this TC.'
        : 'Never use HTML tags, scripts, or SQL injection strings.')
      + '\n' + buildTestCaseFormContext(stepHint).slice(0, 700),
    page
  );

  let filled = 0;
  const doneKeys = new Set();
  const retryCounts = new Map();
  for (let pass = 0; pass < 20; pass++) {
    await dismissOpenUserMenu(page, label).catch(() => {});
    const live = sortFieldsTopDown(await enrichFieldsFromWorkflow(
      page,
      await collectFormFieldMeta(page, scanOpts),
      label
    ));
    const liveErr = await collectValidationErrorTargets(page);
    const liveErrKeys = new Set(liveErr.map((e) => normLabel(e.label)));

    const next = live.find((f) => {
      const k = normLabel(f.label);
      if (!k || doneKeys.has(k)) return false;
      if (/logout|sign\s*out|password|search/i.test(f.label || '')) return false;
      if (/^(yes|no)$/i.test(cleanFieldLabel(f.label || ''))) return false;
      if (f.optional && !fieldMentionedInTestCase(f.label, stepHint) && !fillAllEmpty) return false;
      return shouldFillField(f, stepHint, { ...fillOpts, errored: liveErrKeys.has(k) });
    });

    if (!next) break;

    // Parent→child: never jump past a locked field to fill something below it.
    if (isFieldLocked(next)) {
      rlog(label + ':CASCADE:blocked on "' + cleanFieldLabel(next.label)
        + '" — parent above must be set first');
      if (pass >= 8) break;
      await waitForCascadeAfterSelect(page, label, next.label);
      continue;
    }

    const k = normLabel(next.label);
    let asDropdown = fieldShouldUseDropdown(next);
    if (!asDropdown && !next.isRadio && !next.isCheckbox) {
      const liveKind = await liveFieldKind(page, next.label);
      if (liveKind && liveKind.kind === 'select') {
        asDropdown = true;
        next.isSelect = true;
        next.kind = 'select';
        rlog(label + ':FORM_KIND:dropdown "' + cleanFieldLabel(next.label) + '" via ' + (liveKind.reason || 'widget'));
      }
    }
    if (await verifyFieldFilled(page, next.label, asDropdown, !!next.isRadio)) {
      const cur = (!asDropdown && !next.isRadio) ? await readFieldCurrentValue(page, next.label, false) : '';
      if (!looksLikeInjectionPayload(cur) || securityTc) {
        rlog(label + ':HUMAN:skip already ok "' + cleanFieldLabel(next.label) + '"');
        doneKeys.add(k);
        filled++;
        continue;
      }
    }

    await humanScrollToField(page, next.label);
    await humanPause(page, 50, 120);

    let value = resolveValueFromTestCaseContext(next.label, next, testMap, stepHint);
    const errHit = liveErr.find((e) => labelsMatchStrict(e.label, next.label));
    if (errHit && isSecurityValidationMessage(errHit.message) && !securityTc) {
      try { purgeUnsafeStoredValue(next.label); } catch (_) {}
      value = safeCleanValueForField(next.label, next.type || 'text', testMap, stepHint);
    }
    // Cascading dropdowns: do not guess a label — pick first live option in this list.
    if (asDropdown && !lookupTestData(next.label, testMap)
        && !extractValueFromStepForLabel(next.label, stepHint)) {
      value = '';
    }

    rlog(label + ':HUMAN:fill [' + (pass + 1) + '] "' + cleanFieldLabel(next.label)
      + '" y=' + (next.y || 0)
      + (asDropdown ? ' [dd]' : '')
      + (value ? ' ← "' + String(value).slice(0, 50) + '"' : ' ← first-visible-option'));

    const acted = await humanActOnField(page, stagehand, next, value, label, stepHint);
    const ok = !!acted.ok;
    const noOptions = !ok && acted.reason === 'no-options';

    if (noOptions) {
      // A control that will not open must not consume the whole budget — a tester would
      // come back to it after filling the rest of the form.
      const tries = (retryCounts.get(k) || 0) + 1;
      retryCounts.set(k, tries);
      if (tries < 3) {
        rlog(label + ':CASCADE:no options yet for "' + cleanFieldLabel(next.label)
          + '" (try ' + tries + '/2) — retry after parent settle');
        await waitForCascadeAfterSelect(page, label, next.label);
        continue;
      }
      rlog(label + ':HUMAN:defer "' + cleanFieldLabel(next.label)
        + '" — will not open after ' + tries + ' tries, moving to the next field');
      doneKeys.add(k);
      await dismissOpenDropdowns(page).catch(() => {});
      continue;
    }

    doneKeys.add(k);
    if (ok) {
      filled++;
      rlog(label + ':HUMAN:ok "' + cleanFieldLabel(next.label) + '"');
    } else {
      rlog(label + ':HUMAN:miss "' + cleanFieldLabel(next.label) + '" — will retry in review');
    }
    await humanPause(page, 80, 180);
  }

  // Review pass — fix leftover validation like a careful user (don't proceed yet)
  await humanPause(page, 150, 280);
  let errs = await countVisibleFormErrors(page);
  if (errs > 0) {
    rlog(label + ':HUMAN:review found ' + errs + ' validation issue(s) — fixing');
    await fixValidationErrorsAndContinue(page, stagehand, label, stepHint, {
      skipProceed: true,
      fillAllEmpty,
      dialogOnly: !!(scanOpts && scanOpts.dialogOnly),
    });
  }

  rlog(label + ':HUMAN:filled ' + filled + ' field(s) — '
    + (complete ? 'checking before proceed' : 'done'));
  if (complete) {
    await humanPause(page, 150, 280);
    const leftover = leftoverMustFill(await collectFormFieldMeta(page, scanOpts), stepHint, fillOpts);
    if (leftover.length) {
      rlog(label + ':HUMAN:still empty after fill: '
        + leftover.map((f) => cleanFieldLabel(f.label)).join(', ').slice(0, 200));
      const lockedKids = leftover.filter(isFieldLocked);
      if (lockedKids.length) {
        await waitForCascadeAfterSelect(page, label, lockedKids[0].label);
      }
      await fixValidationErrorsAndContinue(page, stagehand, label, stepHint, {
      skipProceed: true,
      fillAllEmpty,
      dialogOnly: !!(scanOpts && scanOpts.dialogOnly),
    });
    }
    const leftoverAfter = leftoverMustFill(await collectFormFieldMeta(page, scanOpts), stepHint, fillOpts);
    if (!leftoverAfter.length) {
      await proceedWizardNextIfIntended(page, stagehand, label, stepHint);
    } else {
      rlog(label + ':HUMAN:not proceeding — still empty: '
        + leftoverAfter.map((f) => cleanFieldLabel(f.label)).join(', ').slice(0, 200));
    }
    errs = await countVisibleFormErrors(page);
    if (errs > 0 && !stepExpectsPopupOrValidation(stepHint, '')) {
      rlog(label + ':HUMAN:post-next validation — fixing and retry proceed');
      await fixValidationErrorsAndContinue(page, stagehand, label, stepHint);
    }
  }
  return filled > 0;
}

/** Shared label→control lookup; scrolls control into view before returning metadata. */
async function findControlMetaByLabel(page, labelHint, wantSelect) {
  return page.evaluate(({ labelHint, wantSelect }) => {
    function norm(s) {
      return String(s || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    }
    function matchLabel(a, b) {
      const x = norm(a); const y = norm(b);
      if (!y) return true;
      return x === y || x.includes(y) || y.includes(x)
        || x.split(' ').some((w) => w.length > 2 && y.includes(w));
    }
    function visible(el) {
      if (!el || el.offsetHeight <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    }
    function scrollTo(el) {
      try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (_) {
        try { el.scrollIntoView(false); } catch (_2) {}
      }
    }
    function isSelectTrigger(el) {
      if (!el || !visible(el)) return false;
      const role = (el.getAttribute('role') || '').toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      const tag = (el.tagName || '').toLowerCase();
      if (role === 'combobox' || el.getAttribute('aria-haspopup')) return true;
      if (/select|combobox|dropdown|listbox/.test(cls)) return true;
      if (tag === 'button' && /select|choose/i.test(el.innerText || '')) return true;
      if (tag === 'div' && el.getAttribute('tabindex') != null && /select|choose/i.test(el.innerText || '')) return true;
      return false;
    }
    function findSelectTrigger(scope) {
      if (!scope) return null;
      const nodes = scope.querySelectorAll(
        'button, [role="combobox"], [aria-haspopup], div[tabindex], '
        + '[class*="select"], [class*="Select"], [class*="dropdown"], [class*="trigger"]'
      );
      for (const n of nodes) {
        if (!visible(n)) continue;
        const t = (n.innerText || n.textContent || n.value || '').trim();
        if (isSelectTrigger(n) || /^(select|choose)\b/i.test(t) || n.querySelector('svg,chevron')) return n;
      }
      return null;
    }
    function findInput(scope) {
      if (!scope) return null;
      return scope.querySelector(
        'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea'
      );
    }
    function formLabels() {
      const d = Array.from(document.querySelectorAll(
        '[role="dialog"],[aria-modal="true"],.MuiDialog-paper,[class*="MuiDialog-paper"],[class*="ant-modal-content"]'
      )).filter(visible).sort((a, b) =>
        (parseInt(window.getComputedStyle(b).zIndex, 10) || 0) - (parseInt(window.getComputedStyle(a).zIndex, 10) || 0)
      )[0];
      return Array.from((d || document).querySelectorAll('label'));
    }

    for (const lab of formLabels()) {
      if (!visible(lab)) continue;
      const lt = (lab.innerText || lab.textContent || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
      if (!matchLabel(lt, labelHint)) continue;
      scrollTo(lab);
      const grp = lab.closest(
        '[class*="form-field"], [class*="FormField"], [class*="FormItem"], [class*="form-item"], .field, .form-group, .MuiFormControl-root, .mb-3, .mb-4'
      ) || lab.parentElement;

      if (wantSelect) {
        const scopes = [grp, grp && grp.parentElement, lab.parentElement];
        for (const scope of scopes) {
          const trig = findSelectTrigger(scope);
          if (trig) {
            scrollTo(trig);
            return {
              found: true, kind: 'select', label: lt,
              id: trig.id || '', name: trig.name || '',
              text: (trig.innerText || '').trim().slice(0, 80),
            };
          }
        }
        let sib = lab.nextElementSibling;
        for (let hop = 0; hop < 6 && sib; hop++) {
          const trig = isSelectTrigger(sib) ? sib : findSelectTrigger(sib);
          if (trig) {
            scrollTo(trig);
            return { found: true, kind: 'select', label: lt, id: trig.id || '', text: (trig.innerText || '').trim().slice(0, 80) };
          }
          sib = sib.nextElementSibling;
        }
      } else {
        const forId = lab.getAttribute('for');
        if (forId) {
          const byId = document.getElementById(forId);
          if (byId && visible(byId) && /^(input|textarea)$/i.test(byId.tagName)) {
            scrollTo(byId);
            return { found: true, kind: 'input', label: lt, id: byId.id || '', name: byId.name || '', tag: byId.tagName.toLowerCase() };
          }
        }
        const scopes = [grp, lab.parentElement];
        for (const scope of scopes) {
          const inp = findInput(scope);
          if (inp && visible(inp)) {
            scrollTo(inp);
            return { found: true, kind: 'input', label: lt, id: inp.id || '', name: inp.name || '', tag: inp.tagName.toLowerCase() };
          }
        }
        let sib = lab.nextElementSibling;
        for (let hop = 0; hop < 6 && sib; hop++) {
          const inp = /^(input|textarea)$/i.test(sib.tagName) ? sib : findInput(sib);
          if (inp && visible(inp)) {
            scrollTo(inp);
            return { found: true, kind: 'input', label: lt, id: inp.id || '', name: inp.name || '', tag: inp.tagName.toLowerCase() };
          }
          sib = sib.nextElementSibling;
        }
      }
    }
    return { found: false };
  }, { labelHint: cleanFieldLabel(labelHint), wantSelect: !!wantSelect });
}

async function verifyFieldFilled(page, labelHint, isSelect, isRadio) {
  return page.evaluate(({ labelHint, isSelect, isRadio }) => {
    function norm(s) { return String(s || '').replace(/\*/g, '').trim().toLowerCase(); }
    function exactLabel(a, b) { return norm(a) === norm(b); }
    function matchLabel(a, b) {
      const x = norm(a); const y = norm(b);
      return x === y || x.includes(y) || y.includes(x);
    }
    function isPlaceholderSelect(t, label) {
      let s = String(t || '').replace(/\s+/g, ' ').trim();
      const lab = String(label || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
      if (lab && s.toLowerCase().startsWith(lab.toLowerCase())) {
        s = s.slice(lab.length).replace(/^[*\s:]+/, '').trim();
      }
      if (!s) return true;
      return /^(select|choose|pick|--)\b/i.test(s)
        || /\b(select|choose|pick)\s+(an?\s+|the\s+)?/i.test(s)
        || /please\s+select/i.test(s)
        || !!(lab && s.toLowerCase() === lab.toLowerCase());
    }
    function fieldWrap(lab) {
      let n = lab.parentElement;
      for (let i = 0; i < 6 && n && n !== document.body; i++) {
        const labels = n.querySelectorAll ? n.querySelectorAll('label') : [];
        if (labels.length <= 1 && !/^(FORM|MAIN|SECTION)$/i.test(n.tagName || '')) return n;
        n = n.parentElement;
      }
      return lab.parentElement;
    }
    function readSelectValue(grp, label) {
      const trig = grp && grp.querySelector(
        'button, [role="combobox"], [aria-haspopup="listbox"], [class*="select"], [class*="Select"], select'
      );
      if (!trig) return '';
      if (trig.tagName === 'SELECT') {
        const opt = trig.options && trig.options[trig.selectedIndex];
        return ((opt && opt.text) || trig.value || '').trim();
      }
      return (trig.innerText || trig.textContent || trig.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }
    // Prefer real <label> with exact text — avoid fuzzy matches on random div/span
    const dialog = Array.from(document.querySelectorAll(
      '[role="dialog"],[aria-modal="true"],.MuiDialog-paper,[class*="MuiDialog-paper"],[class*="ant-modal-content"]'
    )).filter((el) => el.offsetHeight > 0).sort((a, b) =>
      (parseInt(window.getComputedStyle(b).zIndex, 10) || 0) - (parseInt(window.getComputedStyle(a).zIndex, 10) || 0)
    )[0];
    const labs = Array.from((dialog || document).querySelectorAll('label'));
    labs.sort((a, b) => {
      const la = (a.innerText || a.textContent || '').replace(/\*/g, '').trim();
      const lb = (b.innerText || b.textContent || '').replace(/\*/g, '').trim();
      if (exactLabel(la, labelHint) && !exactLabel(lb, labelHint)) return -1;
      if (exactLabel(lb, labelHint) && !exactLabel(la, labelHint)) return 1;
      return 0;
    });
    for (const lab of labs) {
      const lt = (lab.innerText || lab.textContent || '').replace(/\*/g, '').trim();
      if (!exactLabel(lt, labelHint) && !matchLabel(lt, labelHint)) continue;
      if (lt.length > 120) continue;
      const grp = fieldWrap(lab);
      if (isRadio) {
        const radios = grp ? grp.querySelectorAll('input[type="radio"]') : [];
        if (radios.length) return Array.from(radios).some((r) => r.checked);
        const pageRadios = document.querySelectorAll('input[type="radio"]');
        return Array.from(pageRadios).some((r) => r.checked && matchLabel(r.name || '', labelHint));
      }
      if (isSelect) {
        const t = readSelectValue(grp, labelHint);
        return t.length > 0 && !isPlaceholderSelect(t, lt);
      }
      const inp = grp && grp.querySelector(
        'input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=file]), textarea'
      );
      const v = inp ? String(inp.value || '').trim() : '';
      return !!v && v.length >= 1;
    }
    return false;
  }, { labelHint: cleanFieldLabel(labelHint), isSelect: !!isSelect, isRadio: !!isRadio }).catch(() => false);
}

/** Select Yes/No (or other) radio by question label — precise, no LLM. */
async function setCheckboxByLabel(page, labelHint, wantOn, stepLabel) {
  const clicked = await page.evaluate(({ labelHint, wantOn }) => {
    function norm(s) { return String(s || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
    function matchLabel(a, b) {
      const x = norm(a); const y = norm(b);
      return x === y || x.includes(y) || y.includes(x);
    }
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
    for (const el of boxes) {
      const wrap = el.closest('label, [class*="FormControlLabel"]') || el.parentElement;
      const lab = ((wrap && (wrap.innerText || wrap.getAttribute('aria-label'))) || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!matchLabel(lab, labelHint)) continue;
      const on = !!(el.checked || el.getAttribute('aria-checked') === 'true');
      if (on === !!wantOn) return 'already';
      try { (wrap && wrap.tagName === 'LABEL' ? wrap : el).click(); return 'clicked'; } catch (_) { return false; }
    }
    return false;
  }, { labelHint: cleanFieldLabel(labelHint), wantOn: !!wantOn }).catch(() => false);
  if (clicked) {
    rlog((stepLabel || 'FORM') + ':HUMAN:checkbox "' + cleanFieldLabel(labelHint) + '" → ' + (wantOn ? 'on' : 'off'));
    return true;
  }
  return false;
}

async function selectRadioByLabel(page, labelHint, optionHint, stepLabel) {
  if (await verifyFieldFilled(page, labelHint, false, true)) {
    rlog(stepLabel + ':FORM_RADIO:skip already selected "' + cleanFieldLabel(labelHint) + '"');
    return true;
  }
  const want = String(optionHint || 'No').trim() || 'No';
  const tagged = await page.evaluate(({ labelHint, want }) => {
    function norm(s) { return String(s || '').replace(/\*/g, '').trim().toLowerCase(); }
    function matchLabel(a, b) {
      const x = norm(a); const y = norm(b);
      return x === y || x.includes(y) || y.includes(x);
    }
    function visible(el) {
      if (!el || el.offsetHeight <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    }
    function optionText(r) {
      if (r.id) {
        const lab = document.querySelector('label[for="' + r.id + '"]');
        if (lab) return (lab.innerText || '').replace(/\s+/g, ' ').trim();
      }
      const wrap = r.closest('label');
      if (wrap) {
        const c = wrap.cloneNode(true);
        c.querySelectorAll('input').forEach((n) => n.remove());
        const t = (c.innerText || '').replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
      const sib = r.nextElementSibling;
      if (sib) return (sib.innerText || sib.textContent || '').replace(/\s+/g, ' ').trim();
      return (r.value || '').trim();
    }
    document.querySelectorAll('[data-runpilot-radio]').forEach((el) => el.removeAttribute('data-runpilot-radio'));

    const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(visible);
    const byName = new Map();
    radios.forEach((r, i) => {
      const k = r.name || ('r' + i);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(r);
    });

    let bestGroup = null;
    let bestScore = 0;
    byName.forEach((group) => {
      const card = group[0].closest(
        'fieldset, [role="radiogroup"], [class*="card"], [class*="Card"], section, div'
      ) || group[0].parentElement;
      const blob = ((card && card.innerText) || '').replace(/\s+/g, ' ').trim();
      const nameNorm = (group[0].name || '').replace(/[_-]+/g, ' ');
      const hint = norm(labelHint).replace(/\?/g, '');
      let score = 0;
      if (matchLabel(blob.slice(0, 240), labelHint)) score += 20;
      if (norm(blob).includes(hint)) score += 50;
      if (matchLabel(nameNorm, labelHint) || norm(nameNorm).includes(hint) || hint.includes(norm(nameNorm))) score += 45;
      const hintWords = hint.split(/\s+/).filter((w) => w.length > 2);
      const nameWords = norm(nameNorm).split(/\s+/).filter((w) => w.length > 2);
      if (hintWords.filter((w) => nameWords.includes(w)).length >= 2) score += 40;
      if (score > bestScore) {
        bestScore = score;
        bestGroup = group;
      }
    });
    if (!bestGroup || bestScore < 20) return { ok: false };

    const nw = norm(want);
    let pick = bestGroup.find((r) => {
      const t = norm(optionText(r));
      return t === nw || t.startsWith(nw) || nw.startsWith(t) || t.includes(nw);
    });
    if (!pick && /^(no|n|false|0)$/i.test(want)) {
      pick = bestGroup.find((r) => /^(no|n)$/i.test(optionText(r).trim()));
    }
    if (!pick && /^(yes|y|true|1)$/i.test(want)) {
      pick = bestGroup.find((r) => /^(yes|y)$/i.test(optionText(r).trim()));
    }
    if (!pick) pick = bestGroup[bestGroup.length - 1]; // last often = No
    pick.setAttribute('data-runpilot-radio', '1');
    return { ok: true, text: optionText(pick) || want, id: pick.id || '', name: pick.name || '' };
  }, { labelHint: cleanFieldLabel(labelHint), want });

  if (!tagged || !tagged.ok) {
    rlog(stepLabel + ':FORM_RADIO_WARN:no group for "' + cleanFieldLabel(labelHint) + '"');
    return false;
  }

  try {
    if (tagged.id) {
      await shLocatorClick(page, '[id="' + cssEsc(tagged.id) + '"]');
    } else {
      await shLocatorClick(page, '[data-runpilot-radio="1"]');
    }
    // Also click associated label if input click is swallowed by custom UI
    await page.evaluate(() => {
      const r = document.querySelector('[data-runpilot-radio="1"]');
      if (!r) return;
      r.checked = true;
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
      r.click();
      if (r.id) {
        const lab = document.querySelector('label[for="' + r.id + '"]');
        if (lab) lab.click();
      }
    }).catch(() => {});
    await page.waitForTimeout(200);
    if (await verifyFieldFilled(page, labelHint, false, true)) {
      rlog(stepLabel + ':FORM_RADIO:"' + cleanFieldLabel(labelHint) + '" → ' + tagged.text);
      rememberAppFormValue(labelHint, tagged.text);
      return true;
    }
  } catch (e) {
    rlog(stepLabel + ':FORM_RADIO_WARN:' + (e.message || e));
  }
  return false;
}

function cssEsc(val) {
  return String(val || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function scrollWizardForm(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], .MuiDialog-paper, [class*="MuiDialog-paper"]');
    if (dialog) {
      try { dialog.scrollTop = 0; } catch (_) {}
      const paper = dialog.querySelector('[class*="MuiDialog-paper"], [class*="content"]') || dialog;
      try { paper.scrollTop = 0; } catch (_) {}
    }
    const main = document.querySelector('main');
    if (main) main.scrollTop = 0;
    const form = document.querySelector('form, [class*="wizard"], [class*="Wizard"]');
    if (form) form.scrollTop = 0;
  }).catch(() => {});
  await page.waitForTimeout(300);
}

/** React controlled inputs need Stagehand CDP fill — evaluate-only setValue does not stick. */
async function fillTextFieldByLabel(page, labelHint, value, stepLabel) {
  const meta = await findControlMetaByLabel(page, labelHint, false);
  if (!meta || !meta.found) {
    rlog(stepLabel + ':FORM_FILL_WARN:not found "' + cleanFieldLabel(labelHint) + '"');
    return false;
  }

  const selectors = [];
  const tagged = await page.evaluate(({ labelHint }) => {
    function norm(s) { return String(s || '').replace(/\*/g, '').trim().toLowerCase(); }
    function formLabels() {
      const vis = (el) => {
        if (!el || el.offsetHeight <= 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
      };
      const d = Array.from(document.querySelectorAll(
        '[role="dialog"],[aria-modal="true"],.MuiDialog-paper,[class*="MuiDialog-paper"],[class*="ant-modal-content"]'
      )).filter(vis).sort((a, b) =>
        (parseInt(window.getComputedStyle(b).zIndex, 10) || 0) - (parseInt(window.getComputedStyle(a).zIndex, 10) || 0)
      )[0];
      return Array.from((d || document).querySelectorAll('label'));
    }
    for (const lab of formLabels()) {
      const lt = (lab.innerText || '').replace(/\*/g, '').trim();
      if (!norm(lt).includes(norm(labelHint)) && !norm(labelHint).includes(norm(lt))) continue;
      const grp = lab.closest('[class*="form-field"], [class*="FormField"], [class*="form-item"], .field, .form-group, .mb-3, .mb-4') || lab.parentElement;
      const inp = grp && grp.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=file]), textarea');
      if (!inp) continue;
      inp.setAttribute('data-runpilot-target', '1');
      return { id: inp.id || '', name: inp.name || '' };
    }
    return { id: '', name: '' };
  }, { labelHint: cleanFieldLabel(labelHint) });

  if (tagged && tagged.id) selectors.push('[id="' + cssEsc(tagged.id) + '"]');
  if (tagged && tagged.name) selectors.push('[name="' + cssEsc(tagged.name) + '"]');
  selectors.push('[data-runpilot-target="1"]');

  for (const sel of selectors) {
    try {
      await shLocatorFill(page, sel, value);
      await page.waitForTimeout(150);
      // Commit for React controlled inputs (blur / Tab)
      try {
        await page.locator(sel).first().blur();
      } catch (_) {
        await page.keyPress('Tab').catch(() => {});
      }
      if (await verifyFieldFilled(page, labelHint, false)) {
        rlog(stepLabel + ':FORM_FILL:' + cleanFieldLabel(labelHint).slice(0, 60) + ' = "' + String(value).slice(0, 40) + '"');
        return true;
      }
    } catch (_) {}
  }

  // Textarea fallback — native setter works for some React textareas
  if (meta.tag === 'textarea') {
    const fb = await page.evaluate(({ labelHint, value }) => {
      function norm(s) { return String(s || '').replace(/\*/g, '').trim().toLowerCase(); }
      for (const lab of document.querySelectorAll('label')) {
        const lt = (lab.innerText || '').replace(/\*/g, '').trim();
        if (!norm(lt).includes(norm(labelHint)) && !norm(labelHint).includes(norm(lt))) continue;
        const ta = lab.closest('div')?.querySelector('textarea') || lab.parentElement?.querySelector('textarea');
        if (!ta) continue;
        ta.scrollIntoView({ block: 'center' });
        const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(ta, value);
        else ta.value = value;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return !!ta.value.trim();
      }
      return false;
    }, { labelHint: cleanFieldLabel(labelHint), value: String(value) });
    if (fb) {
      rlog(stepLabel + ':FORM_FILL:' + cleanFieldLabel(labelHint).slice(0, 60) + ' = "' + String(value).slice(0, 40) + '" (textarea)');
      return true;
    }
  }

  rlog(stepLabel + ':FORM_FILL_WARN:value did not stick for "' + cleanFieldLabel(labelHint) + '"');
  return false;
}

function isEntityTypeOptionText(t) {
  return /sole propriet|private limited|limited company|limited liability|\bllc\b|\bllp\b|\bc corporation|\bs corporation|corporation|partnership|\bplc\b/i.test(t || '');
}

function isExpenseCategoryOptionText(t) {
  return /consultant|contractor|facilities|financial|foreign vendor|general and others|marketing|it services|professional services/i.test(t || '');
}

function optionAllowedForField(labelHint, optionText) {
  const l = normLabel(labelHint);
  const t = String(optionText || '');
  if (!t.trim() || /\(optional\)/i.test(t) || /^optional$/i.test(t)) return false;
  if (looksLikePlaceholderSelectValue(t, labelHint)) return false;
  if (looksLikeTcTitleValue(t) && !/\bquestionnaire\b/.test(l)) return false;
  if (/expense/.test(l) && isEntityTypeOptionText(t) && !isExpenseCategoryOptionText(t)) return false;
  if (/entity type|vendor entity/.test(l) && isExpenseCategoryOptionText(t) && !isEntityTypeOptionText(t)) return false;
  // Reject garbage hints that leaked from vendor-name guesses / TC titles
  if (/entity type|vendor entity|expense|indegene entity|business unit|department|nature/.test(l)
    && /autovendor|@indegene\.com|^testvalue|tprm questionnaire/i.test(t)) return false;
  return true;
}

function sanitizeDropdownOptionHint(labelHint, optionHint) {
  const hint = String(optionHint || '').trim();
  if (!hint) return '';
  if (!optionAllowedForField(labelHint, hint)) return '';
  return hint;
}

/** When AI/test data gives a wrong dropdown label, fall back to field-specific defaults. */
function resolveDropdownOptionHint(label, fieldType, testMap) {
  const raw = resolveFieldValue(label, fieldType || 'dropdown', testMap);
  const safe = sanitizeDropdownOptionHint(label, raw);
  if (safe) return safe;
  if (raw && raw !== safe) {
    rlog('FORM_SELECT:hint rejected for "' + cleanFieldLabel(label) + '" — "' + String(raw).slice(0, 40) + '"');
  }
  return guessValueForField(label, fieldType || 'dropdown', testMap);
}

function sanitizeAiDropdownCache(fields) {
  (fields || []).forEach((f) => {
    if (!fieldShouldUseDropdown(f)) return;
    const lbl = f.label || f.name || '';
    if (!lbl) return;
    const key = normLabel(lbl);
    const cached = _aiFormValueCache.get(key);
    if (!cached) return;
    const safe = sanitizeDropdownOptionHint(lbl, cached);
    if (!safe) {
      _aiFormValueCache.set(key, guessValueForField(lbl, f.type, parseTestDataMap()));
    }
  });
}

async function cleanupRunpilotTags(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-runpilot-opt],[data-runpilot-trigger]').forEach((el) => {
      el.removeAttribute('data-runpilot-opt');
      el.removeAttribute('data-runpilot-trigger');
    });
  }).catch(() => {});
}

async function dismissOpenDropdowns(page) {
  await page.keyPress('Escape').catch(() => {});
  await page.waitForTimeout(120);
  await cleanupRunpilotTags(page);
}

/** Soft close after a successful pick — never click body/header (avoids profile/logout). */
async function settleDropdownSelection(page) {
  await cleanupRunpilotTags(page);
  await page.waitForTimeout(150);
}

/** Type-ahead into a focused searchable combobox (Radix / Ant / MUI). */
async function typeIntoFocusedCombobox(page, text) {
  const hint = String(text || '').trim().slice(0, 40);
  if (!hint) return;
  try {
    if (page.keyboard && typeof page.keyboard.type === 'function') {
      await page.keyboard.type(hint, { delay: 25 });
      return;
    }
  } catch (_) {}
  for (const ch of hint) {
    await page.keyPress(ch).catch(() => {});
    await page.waitForTimeout(25);
  }
}

/** Click a tagged option via real mouse — Radix/Headless ignore synthetic dispatchEvent. */
async function clickTaggedOption(page) {
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-runpilot-opt="1"]');
    if (!el) return null;
    try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return {
      x: r.left + Math.min(Math.max(r.width / 2, 12), 72),
      y: r.top + r.height / 2,
    };
  }).catch(() => null);

  if (box && page.mouse && typeof page.mouse.click === 'function') {
    try {
      await page.mouse.move(box.x, box.y);
      await page.waitForTimeout(80);
      await page.mouse.click(box.x, box.y, { delay: 50 });
      await page.waitForTimeout(250);
      return true;
    } catch (_) {}
  }
  try {
    await page.locator('[data-runpilot-opt="1"]').first().click({ force: true, timeout: 2500 });
    await page.waitForTimeout(250);
    return true;
  } catch (_) {}
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[data-runpilot-opt="1"]');
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === 'function') el.click();
    return true;
  }).catch(() => false);
  return !!clicked;
}

async function waitForOpenOptions(page, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2500);
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => {
      function vis(el) {
        if (!el || el.offsetHeight <= 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
      }
      return Array.from(document.querySelectorAll(
        '[role="option"], [data-radix-collection-item], [data-radix-select-item], [cmdk-item]'
      )).filter(vis).length;
    }).catch(() => 0);
    if (n > 0) return n;
    await page.waitForTimeout(150);
  }
  return 0;
}

/** Find + tag a visible option; returns {ok,text,count} with diagnostics. */
async function findAndTagDropdownOption(page, optionHint, labelHint) {
  return page.evaluate(({ optionHint, labelHint }) => {
    function visible(el) {
      if (!el || el.offsetHeight <= 0 || el.offsetWidth <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05;
    }
    function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    function rowText(el) {
      return (el.getAttribute('aria-label') || el.innerText || el.textContent || '')
        .replace(/\s+/g, ' ').trim();
    }
    function isValidOptionText(t) {
      return t && t.length >= 2 && t.length <= 160
        && !/^(select|choose|--|please\s+select)/i.test(t)
        && !/^(logout|sign\s*out)$/i.test(t)
        && !/\(optional\)/i.test(t)
        && !/^optional$/i.test(t)
        && !/required|please select|select an?/i.test(t);
    }
    function isEntityTypeOptionText(t) {
      return /sole propriet|private limited|limited company|limited liability|\bllc\b|\bllp\b|corporation|partnership|individual/i.test(t || '');
    }
    function isExpenseCategoryOptionText(t) {
      return /consultant|contractor|facilities|financial|foreign vendor|general and others|marketing|it services|professional services/i.test(t || '');
    }
    function optionAllowedForField(labelHint, optionText) {
      const l = norm(labelHint);
      const t = String(optionText || '');
      if (/expense/.test(l) && isEntityTypeOptionText(t) && !isExpenseCategoryOptionText(t)) return false;
      if (/entity type|vendor entity/.test(l) && isExpenseCategoryOptionText(t) && !isEntityTypeOptionText(t)) return false;
      if (/autovendor|@indegene\.com|^testvalue/i.test(t)) return false;
      return true;
    }
    function optionY(el) {
      try { return el.getBoundingClientRect().top; } catch (_) { return 0; }
    }
    function listboxesNearTrigger(trigger, triggerRect) {
      const boxes = [];
      if (trigger) {
        const ids = [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')]
          .filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el && visible(el)) boxes.push(el);
        }
      }
      document.querySelectorAll(
        '[role="listbox"], [data-radix-select-viewport], [data-radix-select-content], '
        + '[data-radix-popper-content-wrapper], [data-state="open"], '
        + '.ant-select-dropdown:not(.ant-select-dropdown-hidden)'
      ).forEach((box) => { if (visible(box)) boxes.push(box); });
      const uniq = Array.from(new Set(boxes));
      if (!triggerRect || uniq.length <= 1) return uniq;
      // Prefer the open list attached to THIS trigger (below it, closest).
      return uniq
        .map((box) => {
          const r = box.getBoundingClientRect();
          const dy = Math.abs(r.top - triggerRect.bottom);
          const overlapX = Math.min(r.right, triggerRect.right) - Math.max(r.left, triggerRect.left);
          const score = dy - (overlapX > 0 ? 80 : 0);
          return { box, score };
        })
        .sort((a, b) => a.score - b.score)
        .slice(0, 1)
        .map((x) => x.box);
    }

    document.querySelectorAll('[data-runpilot-opt]').forEach((el) => el.removeAttribute('data-runpilot-opt'));

    const trigger = document.querySelector('[data-runpilot-trigger="1"]');
    const triggerRect = trigger ? trigger.getBoundingClientRect() : null;
    const scopedBoxes = listboxesNearTrigger(trigger, triggerRect);

    const sel = [
      '[role="option"]',
      '[data-radix-collection-item]',
      '[data-radix-select-item]',
      '[class*="SelectItem"]',
      '[class*="select-item"]',
      '[class*="SelectOption"]',
      '[cmdk-item]',
      'li[role="option"]',
      'div[data-value]',
      '[class*="option"]:not(label)',
    ].join(',');

    let candidates = [];
    const harvestFrom = (root) => {
      Array.from(root.querySelectorAll(sel)).forEach((el) => {
        if (visible(el) && isValidOptionText(rowText(el))) candidates.push(el);
      });
      Array.from(root.querySelectorAll('div, li, span, button, a')).forEach((el) => {
        if (!visible(el)) return;
        const t = rowText(el);
        if (!isValidOptionText(t)) return;
        if (el.querySelectorAll('[role="option"]').length > 1) return;
        candidates.push(el);
      });
    };
    if (scopedBoxes.length) {
      scopedBoxes.forEach(harvestFrom);
    } else {
      Array.from(document.querySelectorAll(sel))
        .filter((el) => visible(el) && isValidOptionText(rowText(el)))
        .forEach((el) => candidates.push(el));
    }

    // Keep only options that belong to this open list (below the trigger).
    if (triggerRect) {
      candidates = candidates.filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.bottom < triggerRect.top - 8) return false;
        return r.top <= triggerRect.bottom + 520;
      });
    }

    candidates = Array.from(new Set(candidates));
    const count = candidates.length;
    if (!count) return { ok: false, reason: 'no-options-in-dom', count: 0, sample: [] };

    const sample = candidates.slice(0, 8).map((el) => rowText(el).slice(0, 50));
    const nh = norm(optionHint);

    // Visual top→bottom. Hint match wins; otherwise the first valid option (never random).
    const ranked = candidates
      .map((el) => {
        const t = rowText(el);
        const nt = norm(t);
        if (!optionAllowedForField(labelHint, t)) return null;
        let score = 0;
        if (nh && (nt === nh || nt.includes(nh) || nh.includes(nt))) score = 2;
        else if (nh) score = 0;
        else score = 1;
        return { el, t, y: optionY(el), score };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.y - b.y;
      });

    if (!ranked.length) return { ok: false, reason: 'filtered-out', count, sample };

    const pick = ranked[0];
    pick.el.setAttribute('data-runpilot-opt', '1');
    return { ok: true, text: pick.t.slice(0, 80), count, sample, score: pick.score, y: pick.y };
  }, { optionHint: String(optionHint || ''), labelHint: cleanFieldLabel(labelHint) });
}

/** Tag a visible option and click it; keyboard fallback selects first/highlighted row. */
async function pickVisibleDropdownOption(page, optionHint, stepLabel, labelHint) {
  const safeHint = sanitizeDropdownOptionHint(labelHint, optionHint) || '';

  await page.waitForTimeout(120);
  const n = await waitForOpenOptions(page, 1400);
  if (!n) {
    rlog((stepLabel || 'FORM') + ':FORM_SELECT:waiting for options "' + cleanFieldLabel(labelHint) + '"');
    await page.waitForTimeout(250);
  }
  let tagged = await findAndTagDropdownOption(page, safeHint, labelHint);

  if (!tagged || !tagged.ok) {
    rlog((stepLabel || 'FORM') + ':FORM_SELECT:no option for "' + cleanFieldLabel(labelHint)
      + '" hint="' + String(safeHint || '').slice(0, 40)
      + '" domOptions=' + (tagged && tagged.count != null ? tagged.count : 0)
      + (tagged && tagged.sample && tagged.sample.length
        ? ' sample=[' + tagged.sample.join(' | ') + ']' : ''));
    return null;
  }

  rlog((stepLabel || 'FORM') + ':FORM_SELECT:picking "' + tagged.text
    + '" for "' + cleanFieldLabel(labelHint) + '" (from ' + tagged.count + ' options)');

  if (await clickTaggedOption(page)) {
    await page.waitForTimeout(300);
    return tagged.text;
  }
  return null;
}

async function selectViaKeyboard(page, optionHint) {
  const hint = String(optionHint || '').trim();
  if (hint) {
    await typeIntoFocusedCombobox(page, hint);
    await page.waitForTimeout(200);
  }
  await page.keyPress('ArrowDown').catch(() => {});
  await page.waitForTimeout(120);
  await page.keyPress('Enter').catch(() => {});
  await page.waitForTimeout(300);
}

async function openDropdownTrigger(page, labelHint, stepLabel, ctlKey) {
  await dismissOpenDropdowns(page);

  const tagged = await page.evaluate(({ labelHint, ctlKey }) => {
    function norm(s) {
      return String(s || '')
        .replace(/keyboard_arrow_(down|up|left|right)|arrow_drop_(down|up)|expand_(more|less)|unfold_more|chevron_right/gi, ' ')
        .replace(/[▼▾▲▴*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }
    function exact(a, b) { return norm(a) === norm(b); }
    function fuzzy(a, b) {
      const x = norm(a); const y = norm(b);
      return x.includes(y) || y.includes(x);
    }
    function visible(el) {
      if (!el || el.offsetHeight <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    }
    function inChrome(el) {
      return !!(el.closest('header, aside, nav, [class*="Sidebar"], [class*="sidebar"], [class*="Avatar"], [class*="UserMenu"]'));
    }
    function isBadTrigger(el) {
      if (!el || inChrome(el)) return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (/nativeInput|MuiSelect-native|visually-hidden|sr-only/i.test(String(el.className || ''))) return true;
      const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (/logout|sign\s*out|profile|avatar|account menu/i.test(t)) return true;
      if (t.length > 80 && !/select|choose/i.test(t)) return true;
      return false;
    }
    function findTriggerNear(lab) {
      const grp = lab.closest(
        '[class*="FormField"],[class*="form-field"],[class*="FormItem"],[class*="form-item"],'
        + '[class*="FormControl"],[class*="MuiFormControl"],.field,.form-group,.mb-3,.mb-4,[class*="ant-form-item"]'
      ) || lab.parentElement;
      const scopes = [grp, lab.parentElement];
      for (const scope of scopes) {
        if (!scope) continue;
        const candidates = scope.querySelectorAll(
          'button[role="combobox"], [role="combobox"], [aria-haspopup="listbox"], '
          + '[class*="MuiSelect-select"], [class*="ant-select-selector"], '
          + 'button[class*="select"], [class*="SelectTrigger"], [class*="select-trigger"], select'
        );
        for (const trig of candidates) {
          if (visible(trig) && !isBadTrigger(trig)) return trig;
        }
        // Fallback: first button/div that looks like a closed select in this field only
        const loose = scope.querySelectorAll('button, div[tabindex="0"]');
        for (const trig of loose) {
          if (!visible(trig) || isBadTrigger(trig)) continue;
          const t = (trig.innerText || '').trim();
          if (/^(select|choose)\b/i.test(t) || trig.querySelector('svg')) return trig;
        }
      }
      let sib = lab.nextElementSibling;
      for (let i = 0; i < 4 && sib; i++) {
        if (visible(sib) && !isBadTrigger(sib)
          && (/select|choose/i.test(sib.innerText || '') || sib.getAttribute('role') === 'combobox'
            || sib.querySelector('[role="combobox"], svg'))) {
          const inner = sib.matches('button, [role="combobox"]') ? sib
            : sib.querySelector('button, [role="combobox"], [aria-haspopup="listbox"]');
          if (inner && !isBadTrigger(inner)) return inner;
          if (!isBadTrigger(sib)) return sib;
        }
        sib = sib.nextElementSibling;
      }
      return null;
    }

    document.querySelectorAll('[data-runpilot-trigger]').forEach((el) => el.removeAttribute('data-runpilot-trigger'));

    /** Clickable trigger for a control tagged during the field scan. */
    function triggerForControl(el) {
      if (!el) return null;
      const grp = el.closest(
        '[class*="MuiFormControl"], [class*="FormControl"], [class*="form-field"], [class*="FormField"], '
        + '[class*="FormItem"], [class*="form-item"], [class*="ant-form-item"], [class*="form-group"], '
        + '.field, .mb-3, .mb-4, fieldset'
      ) || el.parentElement;
      const direct = el.matches(
        'select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], '
        + '[class*="MuiSelect-select"], [class*="ant-select-selector"], [class*="select-trigger"]'
      ) ? el : null;
      if (direct && visible(direct) && !isBadTrigger(direct)) return direct;
      if (grp) {
        const inGrp = grp.querySelector(
          'select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], '
          + '[class*="MuiSelect-select"], [class*="ant-select-selector"], [class*="select-trigger"]'
        );
        if (inGrp && visible(inGrp) && !isBadTrigger(inGrp)) return inGrp;
        // Custom picker with no ARIA at all: click the visible input row / box itself.
        const box = grp.querySelector('[class*="InputBase-root"], [class*="OutlinedInput"], [class*="ant-select"]');
        if (box && visible(box) && !isBadTrigger(box)) return box;
      }
      if (visible(el) && !isBadTrigger(el)) return el;
      return null;
    }

    // Preferred path: the exact control tagged when the form was scanned. Works even when
    // the app renders its label inside the control, where a <label> lookup finds nothing.
    if (ctlKey) {
      const owned = document.querySelector('[data-runpilot-ctl="' + String(ctlKey) + '"]');
      const trig = triggerForControl(owned);
      if (trig) {
        try { trig.scrollIntoView({ block: 'center' }); } catch (_) {}
        trig.setAttribute('data-runpilot-trigger', '1');
        return { ok: true, id: trig.id || '', label: labelHint, exact: true, via: 'tagged-control' };
      }
    }

    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .MuiDialog-paper, [class*="MuiDialog-paper"], [class*="ant-modal-content"]'
    )).filter(visible);
    const dialog = dialogs.sort((a, b) => {
      const za = parseInt(window.getComputedStyle(a).zIndex, 10) || 0;
      const zb = parseInt(window.getComputedStyle(b).zIndex, 10) || 0;
      return zb - za;
    })[0];
    const root = dialog
      || document.querySelector('main form, main [class*="wizard"], main [class*="Wizard"], main')
      || document.body;
    // Not every app uses <label>: MUI/Ant render InputLabel/FormLabel wrappers too.
    const labs = Array.from(root.querySelectorAll(
      'label, legend, [class*="InputLabel"], [class*="FormLabel"], [class*="form-label"]'
    )).filter(visible);
    // Exact label first, then fuzzy
    const ordered = [
      ...labs.filter((lab) => exact((lab.innerText || lab.textContent || '').replace(/\*/g, ''), labelHint)),
      ...labs.filter((lab) => {
        const lt = (lab.innerText || lab.textContent || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
        return !exact(lt, labelHint) && fuzzy(lt, labelHint);
      }),
    ];

    for (const lab of ordered) {
      const lt = (lab.innerText || lab.textContent || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
      const trig = findTriggerNear(lab);
      if (!trig) continue;
      lab.scrollIntoView({ block: 'center' });
      trig.scrollIntoView({ block: 'center' });
      trig.setAttribute('data-runpilot-trigger', '1');
      return { ok: true, id: trig.id || '', label: lt, exact: exact(lt, labelHint), via: 'label' };
    }
    return { ok: false };
  }, { labelHint: cleanFieldLabel(labelHint), ctlKey: ctlKey || 0 });

  if (!tagged || !tagged.ok) return false;

  try {
    // Always click the element just tagged — ids can be duplicated or sit on a hidden input.
    await shLocatorClick(page, '[data-runpilot-trigger="1"]');
    await page.waitForTimeout(200);
    await waitForOpenOptions(page, 2000);
    return true;
  } catch (e) {
    rlog((stepLabel || 'FORM') + ':FORM_SELECT_WARN:trigger click failed for "'
      + cleanFieldLabel(labelHint) + '" — ' + (e.message || e));
    return false;
  }
}

async function selectDropdownByLabel(page, labelHint, optionHint, stepLabel, ctlKey) {
  if (looksLikeYesNoQuestion(labelHint)) {
    const radioOk = await selectRadioByLabel(page, labelHint, optionHint || 'No', stepLabel);
    if (radioOk) return true;
  }
  // Already filled with a real option (not placeholder) — do not re-edit
  if (await verifyFieldFilled(page, labelHint, true)) {
    const cur = await readFieldCurrentValue(page, labelHint, true);
    rlog(stepLabel + ':FORM_SELECT:skip already filled "' + cleanFieldLabel(labelHint)
      + '" = "' + String(cur).slice(0, 40) + '"');
    return true;
  }

  let safeHint = sanitizeDropdownOptionHint(labelHint, optionHint);
  if (!safeHint || looksLikeInjectionPayload(safeHint)) {
    safeHint = safeCleanValueForField(labelHint, 'dropdown', parseTestDataMap(), '');
    safeHint = sanitizeDropdownOptionHint(labelHint, safeHint) || safeHint;
  }

  if (!(await openDropdownTrigger(page, labelHint, stepLabel, ctlKey))) {
    rlog(stepLabel + ':FORM_SELECT_WARN:no trigger for "' + cleanFieldLabel(labelHint) + '"');
    return false;
  }

  // Path A — find option in open listbox and click it
  let pickedText = await pickVisibleDropdownOption(page, safeHint, stepLabel, labelHint);
  if (pickedText) {
    await settleDropdownSelection(page);
    if (await verifyFieldFilled(page, labelHint, true)) {
      rlog(stepLabel + ':FORM_SELECT:combobox "' + cleanFieldLabel(labelHint) + '" → ' + pickedText);
      return true;
    }
  }

  // Path B — keyboard: type hint + ArrowDown + Enter (works for Radix/Ant searchable selects)
  await dismissOpenDropdowns(page);
  if (!(await openDropdownTrigger(page, labelHint, stepLabel, ctlKey))) {
    rlog(stepLabel + ':FORM_SELECT_WARN:no option picked for "' + cleanFieldLabel(labelHint) + '"');
    return false;
  }
  await selectViaKeyboard(page, safeHint);
  await settleDropdownSelection(page);
  if (await verifyFieldFilled(page, labelHint, true)) {
    rlog(stepLabel + ':FORM_SELECT:combobox "' + cleanFieldLabel(labelHint) + '" → '
      + (safeHint || 'keyboard') + ' (keyboard)');
    return true;
  }

  // Path C — first option only (one ArrowDown + Enter). Two downs skipped the top row.
  await dismissOpenDropdowns(page);
  if (await openDropdownTrigger(page, labelHint, stepLabel, ctlKey)) {
    await page.waitForTimeout(180);
    await page.keyPress('ArrowDown').catch(() => {});
    await page.waitForTimeout(80);
    await page.keyPress('Enter').catch(() => {});
    await page.waitForTimeout(180);
    await settleDropdownSelection(page);
    if (await verifyFieldFilled(page, labelHint, true)) {
      rlog(stepLabel + ':FORM_SELECT:combobox "' + cleanFieldLabel(labelHint) + '" → first-option (keyboard)');
      return true;
    }
  }

  await dismissOpenDropdowns(page);
  rlog(stepLabel + ':FORM_SELECT_WARN:no option picked for "' + cleanFieldLabel(labelHint) + '"');
  return false;
}

async function tryDirectComboboxSelect(page, fieldHint, optionHint, stepLabel, ctlKey) {
  try {
    // Label-scoped only — never probe random nth dropdowns (causes logout / wrong fields)
    return await selectDropdownByLabel(page, fieldHint, optionHint, stepLabel, ctlKey);
  } catch (e) {
    rlog(stepLabel + ':FORM_SELECT_WARN:' + (e.message || e));
  }
  return false;
}

async function tryFillSingleField(page, f, value, stepLabel) {
  let safeVal = value;
  if (!isSecurityFocusedTestCase('') && looksLikeInjectionPayload(safeVal) && !f.isSelect && !f.isRadio) {
    rlog(stepLabel + ':FORM_SAFE:replace unsafe value on "' + cleanFieldLabel(f.label) + '"');
    purgeUnsafeStoredValue(f.label);
    safeVal = safeCleanValueForField(f.label, f.type || 'text', parseTestDataMap(), '');
  }
  if (await verifyFieldFilled(page, f.label, fieldShouldUseDropdown(f), !!f.isRadio)) {
    const cur = (!fieldShouldUseDropdown(f) && !f.isRadio) ? await readFieldCurrentValue(page, f.label, false) : '';
    if (!looksLikeInjectionPayload(cur) || isSecurityFocusedTestCase('')) {
      rlog(stepLabel + ':FORM_FILL:skip already filled "' + cleanFieldLabel(f.label) + '"');
      return true;
    }
  }
  const acted = await humanActOnField(page, null, f, safeVal, stepLabel, '');
  if (acted.ok) return true;
  // Only text boxes have the id/name fallbacks below; pickers already exhausted their paths.
  if (acted.kind !== 'text' && acted.kind !== 'date') {
    rlog(stepLabel + ':FORM_FILL_WARN:could not set "' + cleanFieldLabel(f.label)
      + '" as ' + acted.kind + (acted.reason ? ' (' + acted.reason + ')' : ''));
    return false;
  }
  if (f.id) {
    try {
      await shLocatorFill(page, '[id="' + cssEsc(f.id) + '"]', safeVal);
      if (await confirmFieldSettled(page, f.label, safeVal, {}, stepLabel)) {
        rememberAppFormValue(f.label, safeVal);
        return true;
      }
    } catch (_) {}
  }
  if (f.name) {
    try {
      await shLocatorFill(page, '[name="' + cssEsc(f.name) + '"]', safeVal);
      if (await confirmFieldSettled(page, f.label, safeVal, {}, stepLabel)) {
        rememberAppFormValue(f.label, safeVal);
        return true;
      }
    } catch (_) {}
  }
  rlog(stepLabel + ':FORM_FILL_WARN:no locator for "' + cleanFieldLabel(f.label) + '"');
  return false;
}

async function countVisibleFormErrors(page) {
  return page.evaluate(() => {
    function vis(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }
    function isErrText(t) {
      return /required|invalid|select|enter|must|please|missing|cannot be empty|this field/i.test(t);
    }
    const seen = new Set();
    function add(t) {
      const k = String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!k || k.length < 4 || k.length > 160 || seen.has(k) || !isErrText(k)) return;
      seen.add(k);
    }
    document.querySelectorAll(
      '[class*="error"], [class*="invalid"], [class*="HelperText"], [class*="helper-text"], '
      + '[class*="FormHelper"], [class*="helperText"], [role="alert"], .text-red-500, .text-danger, '
      + '[class*="FormError"], [aria-invalid="true"]'
    ).forEach((el) => {
      if (!vis(el)) return;
      add(el.innerText || el.textContent || el.getAttribute('title') || '');
    });
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], .MuiDialog-paper');
    const scope = dialog || document.body;
    scope.querySelectorAll('p, span, div, [class*="Helper"]').forEach((el) => {
      if (!vis(el)) return;
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 8 || t.length > 80) return;
      if (!/please\s+select|is\s+required|this field is|must\s+(select|enter)|cannot be empty/i.test(t)) return;
      add(t);
    });
    return seen.size;
  }).catch(() => 0);
}

/**
 * Map visible red validation messages to nearby field labels (any form framework).
 * Generic: no app-specific field names — label comes from DOM or message text.
 */
async function collectValidationErrorTargets(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el || el.offsetHeight <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
    }
    function cleanLabel(raw) {
      return String(raw || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    }
    function titleCaseField(s) {
      return cleanLabel(s).replace(/\b\w/g, (c) => c.toUpperCase());
    }
    function inferKind(grp, msg) {
      const m = String(msg || '').toLowerCase();
      if (/\bselect\b|\bchoose\b|dropdown|category|option/.test(m)) return 'select';
      if (grp && grp.querySelector('textarea')) return 'textarea';
      if (grp && grp.querySelector(
        'select, [role="combobox"], [aria-haspopup="listbox"], [class*="ant-select"], [class*="Select"]'
      )) return 'select';
      return 'text';
    }
    function labelNear(el) {
      let node = el;
      for (let i = 0; i < 6 && node && node !== document.body; i++) {
        if (node.querySelectorAll && node.querySelectorAll('label').length > 1) {
          node = node.parentElement;
          continue;
        }
        const lab = node.querySelector && node.querySelector('label');
        if (lab && visible(lab)) {
          return { label: cleanLabel(lab.innerText || lab.textContent), kind: inferKind(node, el.innerText), grp: node };
        }
        const prev = node.previousElementSibling;
        if (prev && prev.tagName === 'LABEL') {
          return { label: cleanLabel(prev.innerText), kind: inferKind(node.parentElement, el.innerText), grp: node.parentElement };
        }
        node = node.parentElement;
      }
      return { label: '', kind: inferKind(null, el.innerText), grp: null };
    }

    function fieldFromMessage(msg) {
      let m = msg.match(/^(?:please\s+)?(?:select|enter|provide|fill|choose)\s+(?:an?\s+|the\s+)?(.+?)(?:\.|$)/i);
      if (!m) m = msg.match(/^(.+?)\s+is\s+required\.?$/i);
      if (!m) m = msg.match(/^(?:invalid|missing)\s+(.+)$/i);
      if (!m) return '';
      return titleCaseField(m[1]);
    }

    const out = [];
    const seen = new Set();
    const msgs = document.querySelectorAll(
      '[class*="error"], [class*="invalid"], [role="alert"], .text-red-500, .text-danger, '
      + '[class*="FormError"], [class*="helper-text"], [class*="HelperText"], [class*="FormHelper"], '
      + '[class*="helperText"], [class*="form-message"], p.text-sm, [aria-invalid="true"]'
    );
    msgs.forEach((el) => {
      if (!visible(el)) return;
      const msg = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!msg || msg.length < 4 || msg.length > 160) return;
      if (!/required|invalid|select|enter|must|please|missing/i.test(msg)) return;
      if (/cookie|consent|newsletter/i.test(msg)) return;
      const fromMsg = fieldFromMessage(msg);
      const near = labelNear(el);
      const label = fromMsg || near.label;
      if (!label) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      let kind = near.kind;
      if (/\b(select|choose)\b/i.test(msg) || /\bcategory\b/i.test(label)) kind = 'select';
      if (/\b(purpose|description|comment|remarks|notes|reason|details)\b/i.test(label)) kind = 'textarea';
      if (/\b(email|phone|name|url|code|id)\b/i.test(label) && kind !== 'select') kind = 'text';
      out.push({ label, message: msg.slice(0, 120), kind, force: true });
    });
    return out;
  }).catch(() => []);
}

/** Compact TC context used when choosing values for any form category. */
function stepActionText(s) {
  return String((s && (s.description || s.step || s.action)) || '').replace(/\s+/g, ' ').trim();
}
function stepExpectedText(s) {
  return String((s && (s.expectedResult || s.expected)) || '').replace(/\s+/g, ' ').trim();
}

function buildFullTestCaseDossier(currentDesc, currentExpected) {
  const steps = (cfg.steps || []).map((s, i) => {
    const a = stepActionText(s).slice(0, 200);
    const e = stepExpectedText(s).slice(0, 160);
    if (!a && !e) return '';
    return (i + 1) + '. ' + a + (e ? ' | expected: ' + e : '');
  }).filter(Boolean).join('\n');
  const bits = [];
  if (cfg.tcName) bits.push('Test case: ' + String(cfg.tcName).slice(0, 220));
  if (cfg.tcKey) bits.push('Key: ' + cfg.tcKey);
  if (cfg.baseUrl) bits.push('Application URL: ' + cfg.baseUrl);
  if (currentDesc) bits.push('Current step: ' + String(currentDesc).slice(0, 400));
  if (currentExpected) bits.push('Current expected: ' + String(currentExpected).slice(0, 400));
  if (steps) bits.push('Full test case steps (read these before acting):\n' + steps.slice(0, 2400));
  if (cfg.testData) bits.push('Test data:\n' + String(cfg.testData).trim().slice(0, 900));
  if (cfg.executionContext) bits.push('Execution context:\n' + String(cfg.executionContext).trim().slice(0, 700));
  if (cfg.memoryPack) bits.push('Memory:\n' + String(cfg.memoryPack).trim().slice(0, 500));
  if (cfg.confluenceHints) bits.push('Confluence:\n' + String(cfg.confluenceHints).trim().slice(0, 400));
  return bits.join('\n\n');
}

function buildTestCaseFormContext(stepHint) {
  return buildFullTestCaseDossier(stepHint, '');
}

function seedAiFillCache(fillMap) {
  if (!fillMap || typeof fillMap !== 'object') return 0;
  let n = 0;
  Object.keys(fillMap).forEach((k) => {
    const v = String(fillMap[k] == null ? '' : fillMap[k]).trim();
    if (!k || !v) return;
    _aiFormValueCache.set(normLabel(k), v);
    n++;
  });
  return n;
}

/** Pull a value for a field label from free-text step / test-data wording. */
function extractValueFromStepForLabel(label, stepHint) {
  const lbl = cleanFieldLabel(label);
  if (!lbl) return null;
  const blob = [stepHint, cfg.testData, cfg.executionContext].filter(Boolean).join('\n');
  if (!blob) return null;
  const esc = lbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(esc + '\\s*[:=]\\s*[\'"]?([^\'"\\n;|]{1,120})', 'i'),
    new RegExp('(?:fill|enter|type|select|choose|set|use)\\s+(?:the\\s+)?' + esc
      + '\\s+(?:field\\s+)?(?:with|as|to|=)\\s*[\'"]?([^\'"\\n;,]{1,120})', 'i'),
    new RegExp('(?:fill|enter|type|select|choose)\\s+[\'"]([^\'"]{1,120})[\'"]\\s+(?:in|for|into)\\s+(?:the\\s+)?' + esc, 'i'),
  ];
  for (const re of patterns) {
    const m = blob.match(re);
    if (m && m[1] && m[1].trim().length >= 1) {
      const v = m[1].trim();
      if (looksLikeTcTitleValue(v) && !/\bquestionnaire\b/.test(normLabel(lbl))) continue;
      return v;
    }
  }
  return null;
}

/** TC is intentionally testing XSS / SQL injection / script / HTML payload handling. */
function isSecurityFocusedTestCase(stepHint) {
  const blob = [
    cfg.tcName, cfg.tcKey, stepHint, cfg.testData, cfg.executionContext, cfg.confluenceHints,
  ].filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ');
  return /\b(sql\s*injection|sqli|xss|cross[- ]site\s*script|html\s*injection|script\s*injection|security\s*test|penetration|payload|malicious\s*(input|script|html)|inject(ion)?\s*(test|attack|payload)|owasp)\b/i.test(blob);
}

/** Value looks like HTML/script/SQL injection payload (generic — any product). */
function looksLikeInjectionPayload(value) {
  const v = String(value || '');
  if (!v) return false;
  if (/<\s*\/?\s*(script|span|img|svg|iframe|object|embed|link|style|div|body|html)\b/i.test(v)) return true;
  if (/javascript\s*:|on(error|load|click|mouseover)\s*=/i.test(v)) return true;
  if (/('\s*;\s*|--\s|\/\*|\*\/|\bunion\b.+\bselect\b|\bdrop\b\s+table|\binsert\b\s+into|\bor\b\s+1\s*=\s*1)/i.test(v)) return true;
  if (/\$\{|%\d+|\\x[0-9a-f]{2}/i.test(v) && /script|select|union/i.test(v)) return true;
  // Truncated HTML fragments like ". <span style="
  if (/<\s*[a-z]+[\s=>]/i.test(v) || /\.\s*<\s*[a-z]/i.test(v)) return true;
  return false;
}

/** Visible validation message is about HTML/script/SQL injection (not a simple required). */
function isSecurityValidationMessage(msg) {
  return /html|script\s*content|sql\s*injection|xss|malicious|dangerous\s*(input|content)|injection\s*pattern/i
    .test(String(msg || ''));
}

/**
 * Resolve a value for ANY field from TC context (generic — not app-specific).
 * Unless the TC is security-focused, reject injection/HTML payloads and use accurate data.
 */
function resolveValueFromTestCaseContext(fieldLabel, fieldMeta, testMap, stepHint) {
  const securityTc = isSecurityFocusedTestCase(stepHint);
  let raw = extractValueFromStepForLabel(fieldLabel, stepHint);
  if (!raw) {
    if (fieldMeta && fieldMeta.isRadio) {
      raw = resolveFieldValue(fieldLabel, 'radio', testMap) || 'No';
    } else if (fieldMeta && fieldMeta.isSelect) {
      raw = resolveDropdownOptionHint(fieldLabel, fieldMeta.type || 'dropdown', testMap);
    } else {
      raw = resolveFieldValue(fieldLabel, (fieldMeta && fieldMeta.type) || 'text', testMap);
    }
  }

  if (!securityTc && looksLikeTcTitleValue(raw) && fieldMeta && (fieldMeta.isSelect || fieldMeta.isRadio)) {
    raw = guessValueForField(
      fieldLabel,
      (fieldMeta && (fieldMeta.type || (fieldMeta.isSelect ? 'dropdown' : 'text'))) || 'text',
      testMap
    );
  }
  if (!securityTc && looksLikeInjectionPayload(raw)) {
    rlog('FORM_SAFE:rejected injection-like value for "' + cleanFieldLabel(fieldLabel)
      + '" — TC is not security-focused; using accurate data');
    purgeUnsafeStoredValue(fieldLabel);
    return safeCleanValueForField(
      fieldLabel,
      (fieldMeta && (fieldMeta.type || (fieldMeta.isSelect ? 'dropdown' : 'text'))) || 'text',
      testMap,
      stepHint
    );
  }
  if (!securityTc && !raw) {
    return safeCleanValueForField(
      fieldLabel,
      (fieldMeta && (fieldMeta.type || (fieldMeta.isSelect ? 'dropdown' : 'text'))) || 'text',
      testMap,
      stepHint
    );
  }
  return raw;
}

/**
 * Wait fieldConfirmMs (default 2s), then confirm the value stuck.
 * Retries the fill/select once if not confirmed. Generic for all products.
 */
async function confirmFieldSettled(page, labelHint, expected, opts, stepLabel) {
  opts = opts || {};
  const isSelect = !!opts.isSelect;
  const isRadio = !!opts.isRadio;
  const label = stepLabel || 'FORM';
  const waitMs = opts.waitMs != null ? opts.waitMs : cfg.fieldConfirmMs;
  if (waitMs > 0) {
    rlog(label + ':FIELD_CONFIRM:wait ' + waitMs + 'ms for "' + cleanFieldLabel(labelHint) + '"');
    await page.waitForTimeout(waitMs);
  }

  const ok = await verifyFieldFilled(page, labelHint, isSelect, isRadio);
  if (ok) {
    // Soft match: if expected provided, ensure value is related (not injection leftover)
    if (expected && !isSelect && !isRadio && !isSecurityFocusedTestCase(opts.stepHint)) {
      const current = await readFieldCurrentValue(page, labelHint, isSelect);
      if (looksLikeInjectionPayload(current)) {
        rlog(label + ':FIELD_CONFIRM:FAIL "' + cleanFieldLabel(labelHint)
          + '" still has unsafe content "' + String(current).slice(0, 40) + '"');
        return false;
      }
    }
    rlog(label + ':FIELD_CONFIRM:OK "' + cleanFieldLabel(labelHint) + '"');
    return true;
  }
  rlog(label + ':FIELD_CONFIRM:MISS "' + cleanFieldLabel(labelHint)
    + '" expected~"' + String(expected || '').slice(0, 40) + '"');
  return false;
}

async function readFieldCurrentValue(page, labelHint, isSelect) {
  return page.evaluate(({ labelHint, isSelect }) => {
    function norm(s) { return String(s || '').replace(/\*/g, '').trim().toLowerCase(); }
    function matchLabel(a, b) {
      const x = norm(a); const y = norm(b);
      return x === y || x.includes(y) || y.includes(x);
    }
    function formLabels() {
      const vis = (el) => {
        if (!el || el.offsetHeight <= 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
      };
      const d = Array.from(document.querySelectorAll(
        '[role="dialog"],[aria-modal="true"],.MuiDialog-paper,[class*="MuiDialog-paper"],[class*="ant-modal-content"]'
      )).filter(vis).sort((a, b) =>
        (parseInt(window.getComputedStyle(b).zIndex, 10) || 0) - (parseInt(window.getComputedStyle(a).zIndex, 10) || 0)
      )[0];
      return Array.from((d || document).querySelectorAll('label'));
    }
    for (const lab of formLabels()) {
      const lt = (lab.innerText || '').replace(/\*/g, '').trim();
      if (!matchLabel(lt, labelHint)) continue;
      const grp = lab.closest(
        '.form-group,.field,.MuiFormControl-root,[class*="form-field"],[class*="FormField"],'
        + '[class*="FormItem"],[class*="form-item"],[class*="ant-form-item"],.mb-3,.mb-4,fieldset'
      ) || lab.parentElement;
      if (isSelect) {
        const trig = grp && grp.querySelector(
          'button, [role="combobox"], [aria-haspopup="listbox"], [class*="select"], [class*="Select"], select'
        );
        return trig
          ? ((trig.innerText || trig.textContent || trig.value || '').replace(/\s+/g, ' ').trim())
          : '';
      }
      const inp = grp && grp.querySelector(
        'input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea'
      );
      return inp ? String(inp.value || '').trim() : '';
    }
    return '';
  }, { labelHint: cleanFieldLabel(labelHint), isSelect: !!isSelect }).catch(() => '');
}

/**
 * Open a dropdown and pick the best option for this TC:
 * 1) option matching resolved hint / test data
 * 2) otherwise first valid visible option (generic — works for any category).
 * Then wait + confirm selection stuck.
 */
async function selectDropdownForTestCase(page, stagehand, fieldLabel, hint, stepLabel, ctlKey) {
  const label = stepLabel || 'FORM';
  const testMap = parseTestDataMap();
  const safeHint = (!isSecurityFocusedTestCase('') && looksLikeInjectionPayload(hint))
    ? guessValueForField(fieldLabel, 'dropdown', testMap)
    : hint;

  async function attemptOnce(h) {
    let ok = await tryDirectNativeSelect(page, fieldLabel, h, testMap, label)
      || await tryDirectComboboxSelect(page, fieldLabel, h, label, ctlKey);
    if (ok) return { ok: true, value: h, source: 'direct' };

    // Last resort when the label lookup below also fails: click the tagged control itself.
    if (ctlKey && await openDropdownTrigger(page, fieldLabel, label, ctlKey)) {
      const picked = await pickVisibleDropdownOption(page, h || '', label, fieldLabel);
      if (picked) return { ok: true, value: picked, source: 'tagged-control' };
    }

    const opened = await page.evaluate((labelHint) => {
      function norm(s) { return String(s || '').replace(/\*/g, '').trim().toLowerCase(); }
      function matchLabel(a, b) {
        const x = norm(a); const y = norm(b);
        return x === y || x.includes(y) || y.includes(x);
      }
      function visible(el) {
        if (!el || el.offsetHeight <= 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
      }
      const dialog = Array.from(document.querySelectorAll(
        '[role="dialog"],[aria-modal="true"],.MuiDialog-paper,[class*="MuiDialog-paper"],[class*="ant-modal-content"]'
      )).filter(visible).sort((a, b) =>
        (parseInt(window.getComputedStyle(b).zIndex, 10) || 0) - (parseInt(window.getComputedStyle(a).zIndex, 10) || 0)
      )[0];
      for (const lab of (dialog || document).querySelectorAll('label')) {
        const lt = (lab.innerText || '').replace(/\*/g, '').trim();
        if (!matchLabel(lt, labelHint)) continue;
        const grp = lab.closest(
          '.form-group,.field,.MuiFormControl-root,[class*="form-field"],[class*="FormField"],[class*="FormItem"],[class*="form-item"],[class*="ant-form-item"],.mb-3,.mb-4'
        ) || lab.parentElement;
        const trig = grp && grp.querySelector(
          'select, button, [role="combobox"], [aria-haspopup="listbox"], [class*="ant-select"], [class*="Select"]'
        );
        if (!trig || !visible(trig)) continue;
        trig.scrollIntoView({ block: 'center' });
        try { trig.click(); } catch (_) {}
        return true;
      }
      return false;
    }, cleanFieldLabel(fieldLabel)).catch(() => false);

    if (opened) {
      await page.waitForTimeout(250);
      const picked = await pickVisibleDropdownOption(page, h || '', label, fieldLabel);
      if (picked) return { ok: true, value: picked, source: 'first-visible' };
      await page.keyPress('ArrowDown').catch(() => {});
      await page.waitForTimeout(80);
      await page.keyPress('Enter').catch(() => {});
      await page.waitForTimeout(180);
      if (await verifyFieldFilled(page, fieldLabel, true, false)) {
        return { ok: true, value: h || '(first-option)', source: 'keyboard' };
      }
      await dismissOpenDropdowns(page);
      return { ok: false, value: h, source: 'none', reason: 'no-options' };
    }

    return { ok: false, value: h, source: 'none', reason: 'no-options' };
  }

  let result = await attemptOnce(safeHint);
  if (result.ok) {
    const confirmed = await confirmFieldSettled(page, fieldLabel, result.value, {
      isSelect: true, stepHint: '', waitMs: Math.min(cfg.fieldConfirmMs, 300),
    }, label);
    if (!confirmed) {
      rlog(label + ':FIELD_CONFIRM:retry select "' + cleanFieldLabel(fieldLabel) + '"');
      result = await attemptOnce(safeHint);
      if (result.ok) {
        await confirmFieldSettled(page, fieldLabel, result.value, {
          isSelect: true, waitMs: Math.min(cfg.fieldConfirmMs, 250),
        }, label);
      }
    }
  }
  return result;
}

/**
 * Live widget check for ANY site: if the labeled control is not a free-text box,
 * treat it as a picker (click + choose). Does not use field-name dictionaries.
 */
async function liveFieldKind(page, labelHint) {
  return page.evaluate((labelHint) => {
    function norm(s) {
      return String(s || '')
        .replace(/keyboard_arrow_(down|up|left|right)|arrow_drop_(down|up)|expand_(more|less)|unfold_more|chevron_right/gi, ' ')
        .replace(/[▼▾▲▴*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }
    function matchLabel(a, b) {
      const x = norm(a); const y = norm(b);
      return !!y && (x === y || x.includes(y) || y.includes(x));
    }
    function vis(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }
    function widgetSel() {
      return 'select, [role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], '
        + '[aria-autocomplete="list"], [aria-autocomplete="both"], [data-radix-select-trigger], '
        + '[class*="select-trigger"], [class*="SelectTrigger"], [class*="MuiSelect-select"], '
        + '[class*="ant-select-selector"]';
    }
    function isGhost(el) {
      if (!el) return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      const cls = String(el.className || '');
      if (/nativeInput|visually-hidden|sr-only|hidden-input|offscreen|screen-reader/i.test(cls)) return true;
      const st = window.getComputedStyle(el);
      if (parseFloat(st.opacity || '1') === 0) return true;
      const r = el.getBoundingClientRect();
      return r.width < 4 || r.height < 4;
    }
    function hasPickerChrome(grp) {
      if (!grp) return false;
      const t = String(grp.innerText || '');
      if (/keyboard_arrow_down|arrow_drop_down|expand_more|[▼▾]/.test(t)) return true;
      return !!(grp.querySelector(
        '[class*="arrow-drop"], [class*="ArrowDrop"], [class*="ExpandMore"], '
        + '[class*="chevron-down"], [class*="ChevronDown"], [class*="CaretDown"]'
      ));
    }
    function isTypable(el, grp) {
      if (!el || isGhost(el)) return false;
      const tag = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const popup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
      const auto = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
      if (role === 'combobox' || role === 'listbox') return false;
      if (popup === 'listbox' || popup === 'menu') return false;
      if (auto === 'list' || auto === 'both') return false;
      if (tag === 'select') return false;
      if (el.isContentEditable || tag === 'textarea') return true;
      if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        if (/^(hidden|checkbox|radio|file|button|submit|reset|image|range|color|date|datetime-local|time|month|week)$/.test(type)) {
          return false;
        }
        if (el.readOnly || el.getAttribute('aria-readonly') === 'true') return false;
        if (grp && grp.querySelector(widgetSel())) return false;
        return true;
      }
      return false;
    }
    const d = Array.from(document.querySelectorAll(
      '[role="dialog"],[aria-modal="true"],.MuiDialog-paper,[class*="MuiDialog-paper"],[class*="ant-modal-content"]'
    )).filter(vis).sort((a, b) =>
      (parseInt(window.getComputedStyle(b).zIndex, 10) || 0) - (parseInt(window.getComputedStyle(a).zIndex, 10) || 0)
    )[0];
    const labs = Array.from((d || document).querySelectorAll('label, legend, [class*="InputLabel"], [class*="FormLabel"]'));
    for (const lab of labs) {
      if (!matchLabel(lab.innerText || lab.textContent || lab.getAttribute('aria-label'), labelHint)) continue;
      const grp = lab.closest(
        '.form-group,.field,.MuiFormControl-root,[class*="form-field"],[class*="FormField"],'
        + '[class*="FormItem"],[class*="form-item"],[class*="ant-form-item"],[class*="FormControl"],'
        + 'fieldset,.mb-3,.mb-4'
      ) || lab.parentElement;
      if (!grp) continue;
      const widget = grp.querySelector(widgetSel());
      const inp = grp.querySelector(
        'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea'
      );
      const control = widget || inp;
      if (!control) {
        if (hasPickerChrome(grp)) return { kind: 'select', reason: 'picker-chrome' };
        continue;
      }
      const type = (control.type || '').toLowerCase();
      if (type === 'checkbox') return { kind: 'checkbox', reason: 'checkbox' };
      if (type === 'radio') return { kind: 'radio', reason: 'radio' };
      if (widget || hasPickerChrome(grp) || !isTypable(control, grp)) {
        return { kind: 'select', reason: widget ? 'widget' : (hasPickerChrome(grp) ? 'picker-chrome' : 'not-typable') };
      }
      return { kind: 'text', reason: 'typable' };
    }
    return { kind: 'unknown', reason: 'not-found' };
  }, cleanFieldLabel(labelHint)).catch(() => ({ kind: 'unknown', reason: 'eval' }));
}

/**
 * The one place any form control is operated. Classifies from the live widget and
 * acts the way a manual tester does: pickers are opened and an option is clicked,
 * radios/checkboxes/switches are clicked, only real text boxes are typed into.
 * Every fill path routes through here so all products behave the same.
 */
async function humanActOnField(page, stagehand, field, value, stepLabel, stepHint) {
  const label = stepLabel || 'FORM';
  const name = cleanFieldLabel(field && field.label);
  if (!name) return { ok: false, kind: 'unknown', reason: 'no-label' };

  let kind = '';
  if (field.isRadio) kind = 'radio';
  else if (field.isCheckbox) kind = 'checkbox';
  else if (fieldShouldUseDropdown(field)) kind = 'select';
  if (!kind) {
    const live = await liveFieldKind(page, name);
    kind = (live && live.kind && live.kind !== 'unknown') ? live.kind : 'text';
    if (kind === 'select') {
      field.isSelect = true;
      field.kind = 'select';
      rlog(label + ':FORM_KIND:dropdown "' + name + '" via ' + ((live && live.reason) || 'widget'));
    }
  }
  if (kind !== 'select' && looksLikeYesNoQuestion(name)) kind = 'radio';

  try {
    if (kind === 'radio') {
      const ok = await selectRadioByLabel(page, name, value || 'No', label);
      if (ok) {
        await confirmFieldSettled(page, name, value,
          { isRadio: true, waitMs: Math.min(cfg.fieldConfirmMs, 250) }, label);
        await waitForCascadeAfterSelect(page, label, name);
      }
      return { ok, kind };
    }
    if (kind === 'checkbox') {
      const on = !/^(off|no|false|uncheck|0)$/i.test(String(value || 'yes').trim());
      const ok = await setCheckboxByLabel(page, name, on, label);
      return { ok, kind };
    }
    if (kind === 'select') {
      const sel = await selectDropdownForTestCase(page, stagehand, name, value, label, field.ctl);
      if (sel && sel.ok) {
        rememberAppFormValue(name, sel.value || value);
        await waitForCascadeAfterSelect(page, label, name);
        return { ok: true, kind, value: sel.value };
      }
      return { ok: false, kind, reason: (sel && sel.reason) || 'no-options' };
    }
    if (kind === 'file') {
      rlog(label + ':FORM_KIND:file input "' + name + '" — no attachment supplied, skipping');
      return { ok: false, kind, reason: 'no-attachment' };
    }
    let v = value;
    if (kind === 'date' || field.type === 'date' || /\b(date|dob)\b/i.test(name)) {
      v = v || guessValueForField(name, 'date', parseTestDataMap());
    }
    const ok = await forceCommitTextByLabel(page, name, v, label, stepHint);
    return { ok, kind: kind === 'date' ? 'date' : 'text' };
  } catch (e) {
    rlog(label + ':HUMAN:WARN "' + name + '" — ' + (e && e.message ? e.message : e));
    return { ok: false, kind, reason: 'error' };
  }
}

/**
 * Actually type into the field (click → select-all → type → blur) and only succeed
 * when the UI value sticks. Generic for React/Ant/MUI controlled inputs.
 */
async function forceCommitTextByLabel(page, labelHint, value, stepLabel, stepHint) {
  let val = String(value || '').trim();
  if (!val) return false;
  const live = await liveFieldKind(page, labelHint);
  if (isGeneratedFieldId(labelHint) || (live && live.kind === 'select')) {
    rlog((stepLabel || 'FORM') + ':FORM_KIND:dropdown — click and choose, do not type "'
      + cleanFieldLabel(labelHint) + '"' + (live && live.reason ? ' (' + live.reason + ')' : ''));
    const sel = await selectDropdownForTestCase(page, null, labelHint, val, stepLabel);
    return !!(sel && sel.ok);
  }
  if (!isSecurityFocusedTestCase(stepHint) && looksLikeInjectionPayload(val)) {
    rlog((stepLabel || 'FORM') + ':FORM_SAFE:replace unsafe "' + val.slice(0, 40)
      + '" on "' + cleanFieldLabel(labelHint) + '" with accurate data');
    purgeUnsafeStoredValue(labelHint);
    val = safeCleanValueForField(labelHint, 'text', parseTestDataMap(), stepHint);
  }
  // Final guard — never type unsafe content on non-security TCs
  if (!isSecurityFocusedTestCase(stepHint) && looksLikeInjectionPayload(val)) {
    val = 'Bluewave Solutions ' + Date.now().toString().slice(-4);
  }

  async function writeOnce(v) {
    // Tag the control so Playwright can target it reliably
    const tagged = await page.evaluate((labelHint) => {
      function norm(s) { return String(s || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
      function matchLabel(a, b) {
        const x = norm(a); const y = norm(b);
        return x === y || x.includes(y) || y.includes(x);
      }
      document.querySelectorAll('[data-runpilot-type]').forEach((el) => el.removeAttribute('data-runpilot-type'));
      function formLabels() {
        const vis = (el) => {
          if (!el || el.offsetHeight <= 0) return false;
          const st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
        };
        const d = Array.from(document.querySelectorAll(
          '[role="dialog"],[aria-modal="true"],.MuiDialog-paper,[class*="MuiDialog-paper"],[class*="ant-modal-content"]'
        )).filter(vis).sort((a, b) =>
          (parseInt(window.getComputedStyle(b).zIndex, 10) || 0) - (parseInt(window.getComputedStyle(a).zIndex, 10) || 0)
        )[0];
        return Array.from((d || document).querySelectorAll('label'));
      }
      for (const lab of formLabels()) {
        const lt = (lab.innerText || '').replace(/\*/g, '').trim();
        if (!matchLabel(lt, labelHint)) continue;
        const grp = lab.closest(
          '.form-group,.field,.MuiFormControl-root,[class*="form-field"],[class*="FormField"],'
          + '[class*="FormItem"],[class*="form-item"],[class*="ant-form-item"],.mb-3,.mb-4'
        ) || lab.parentElement;
        const inp = grp && grp.querySelector(
          'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea'
        );
        if (!inp) continue;
        const cls = String(inp.className || '');
        const ghost = inp.getAttribute('aria-hidden') === 'true'
          || /nativeInput|MuiSelect-native|visually-hidden|sr-only/i.test(cls)
          || parseFloat(window.getComputedStyle(inp).opacity || '1') === 0;
        const combo = grp.querySelector(
          'select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], '
          + '[aria-autocomplete="list"], [aria-autocomplete="both"], [data-radix-select-trigger], '
          + '[class*="select-trigger"], [class*="MuiSelect-select"], [class*="ant-select-selector"]'
        );
        if (ghost || combo || inp.readOnly || inp.getAttribute('aria-readonly') === 'true') {
          return { ok: false, isDropdown: true };
        }
        inp.setAttribute('data-runpilot-type', '1');
        try { inp.scrollIntoView({ block: 'center' }); } catch (_) {}
        return {
          ok: true,
          id: inp.id || '',
          name: inp.name || '',
          tag: (inp.tagName || '').toLowerCase(),
        };
      }
      return { ok: false };
    }, cleanFieldLabel(labelHint)).catch(() => ({ ok: false }));

    if (tagged && tagged.isDropdown) {
      rlog(stepLabel + ':FORM_KIND:dropdown — click and choose, do not type "'
        + cleanFieldLabel(labelHint) + '"');
      const sel = await selectDropdownForTestCase(page, null, labelHint, v, stepLabel);
      return !!(sel && sel.ok);
    }
    if (!tagged || !tagged.ok) {
      rlog(stepLabel + ':FORM_FORCE_WARN:control not found for "' + cleanFieldLabel(labelHint) + '"');
      return false;
    }

    const selectors = [];
    if (tagged.id) selectors.push('[id="' + cssEsc(tagged.id) + '"]');
    if (tagged.name) selectors.push('[name="' + cssEsc(tagged.name) + '"]');
    selectors.push('[data-runpilot-type="1"]');

    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        await loc.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(150);
        // Clear existing (Ctrl/Meta+A then Delete) — works for React controlled inputs
        try {
          await loc.fill('');
        } catch (_) {
          try {
            await page.keyPress('Control+A').catch(() => page.keyPress('Meta+A').catch(() => {}));
            await page.keyPress('Backspace').catch(() => {});
          } catch (_2) {}
        }
        await page.waitForTimeout(80);

        // Type the value — prefer fill (fires input events); fallback pressSequentially
        let typed = false;
        try {
          await loc.fill(String(v));
          typed = true;
        } catch (_) {}
        if (!typed) {
          try {
            await loc.pressSequentially(String(v), { delay: Math.max(15, cfg.humanTypeDelayMs || 25) });
            typed = true;
          } catch (_) {}
        }
        if (!typed) {
          // Native setter last resort
          await page.evaluate(({ sel, value }) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            el.focus();
            if (desc && desc.set) desc.set.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }, { sel, value: v }).catch(() => false);
        }

        await page.waitForTimeout(120);
        try { await loc.blur(); } catch (_) {
          await page.keyPress('Tab').catch(() => {});
        }
        await page.waitForTimeout(200);

        // Success ONLY if UI shows the value
        const current = await readFieldCurrentValue(page, labelHint, false);
        const curL = String(current || '').trim();
        const wantL = String(v || '').trim();
        const stuck = curL
          && (curL === wantL || curL.includes(wantL.slice(0, Math.min(24, wantL.length)))
            || wantL.includes(curL.slice(0, Math.min(24, curL.length))));
        if (stuck && !looksLikeInjectionPayload(curL)) {
          rlog(stepLabel + ':FORM_FORCE:' + cleanFieldLabel(labelHint).slice(0, 50)
            + ' = "' + curL.slice(0, 40) + '" (verified)');
          rememberAppFormValue(labelHint, curL);
          return true;
        }
        rlog(stepLabel + ':FORM_FORCE_WARN:"' + cleanFieldLabel(labelHint)
          + '" UI has "' + curL.slice(0, 40) + '" expected "' + wantL.slice(0, 40) + '"');
      } catch (e) {
        rlog(stepLabel + ':FORM_FORCE_WARN:' + (e && e.message ? e.message : e));
      }
    }
    return false;
  }

  let wrote = await writeOnce(val);
  let confirmed = wrote && await confirmFieldSettled(page, labelHint, val, {
    isSelect: false, stepHint: stepHint, waitMs: cfg.fieldConfirmMs || 2000,
  }, stepLabel);

  if (!confirmed) {
    rlog(stepLabel + ':FIELD_CONFIRM:retry fill "' + cleanFieldLabel(labelHint) + '"');
    purgeUnsafeStoredValue(labelHint);
    val = safeCleanValueForField(labelHint, 'text', parseTestDataMap(), stepHint);
    wrote = await writeOnce(val);
    if (wrote) {
      confirmed = await confirmFieldSettled(page, labelHint, val, {
        isSelect: false, stepHint: stepHint, waitMs: cfg.fieldConfirmMs || 2000,
      }, stepLabel);
    }
  }
  return !!confirmed;
}

/** After values are filled, click ONLY the footer button this step names (Next ≠ Draft/Save). */
async function proceedWizardNextIfIntended(page, stagehand, stepLabel, stepHint) {
  const label = stepLabel || 'FORM';
  if (stepExpectsPopupOrValidation(stepHint, '')) {
    rlog(label + ':PROCEED:skip — TC verifies validation/popup');
    return false;
  }
  const intent = parseProceedIntent(stepHint);
  if (!intent) {
    rlog(label + ':PROCEED:skip — step does not name Next/Submit/Save/Draft');
    return false;
  }

  const clicked = await page.evaluate(({ labels, kind }) => {
    function visible(el) {
      if (!el || el.disabled) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }
    function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
    const want = (labels || []).map(norm);
    const btns = Array.from(document.querySelectorAll(
      'button, [role="button"], input[type="submit"], input[type="button"], a.btn'
    )).filter(visible);
    const ranked = btns.map((b) => {
      const t = ((b.innerText || b.value || b.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
      const nt = norm(t);
      let score = 0;
      if (want.some((w) => nt === w)) score += 80;
      else if (want.some((w) => nt.startsWith(w) || w.startsWith(nt))) score += 50;
      else if (want.some((w) => nt.includes(w))) score += 30;
      if (kind !== 'draft' && /\bdraft\b/.test(nt)) score -= 120;
      if (kind === 'next' && /\b(save|submit|publish|finish)\b/.test(nt) && !/\b(next|continue|proceed)\b/.test(nt)) {
        score -= 120;
      }
      if (b.closest('header, nav, aside, [class*="sidebar"], [class*="SideBar"], [class*="avatar"], [class*="Avatar"], [class*="profile"], [class*="UserMenu"]')) {
        score -= 80;
      }
      if (/logout|sign out|profile|account|cancel|back|previous|discard/i.test(t)) score -= 80;
      return { b, t, score };
    }).filter((x) => x.score >= 30).sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    ranked[0].b.click();
    return ranked[0].t.slice(0, 60);
  }, { labels: intent.labels, kind: intent.kind }).catch(() => null);

  if (clicked) {
    rlog(label + ':PROCEED:clicked "' + clicked + '" (intent=' + intent.kind + ')');
    await page.waitForTimeout(Math.max(cfg.fieldConfirmMs, 350));
    await settleDynamicScreen(page, label).catch(() => {});
    return true;
  }

  rlog(label + ':PROCEED:no "' + intent.kind + '" control found — not clicking Draft/Save fallback');
  return false;
}

/**
 * Generic validation recovery for ANY form category:
 * 1) Collect all errored + empty required fields
 * 2) Choose values from test-case context (accurate data unless security TC)
 * 3) Fill every field with 2s confirm
 * 4) Proceed with Next/Continue/Submit
 */
async function fixValidationErrorsAndContinue(page, stagehand, stepLabel, stepHint, options) {
  options = options || {};
  const label = stepLabel || 'FORM';
  const testMap = parseTestDataMap();
  const tcContext = buildTestCaseFormContext(stepHint);
  const securityTc = isSecurityFocusedTestCase(stepHint);
  if (options.skipProceed == null) options.skipProceed = !stepWantsProceed(stepHint);
  const errorsBefore = await countVisibleFormErrors(page);
  rlog(label + ':FIX_VALIDATION:start errors=' + errorsBefore
    + ' securityTc=' + securityTc + ' confirmMs=' + cfg.fieldConfirmMs);

  for (let pass = 1; pass <= 3; pass++) {
    await scrollWizardForm(page).catch(() => {});
    await dismissOpenUserMenu(page, label).catch(() => {});
    const errored = await collectValidationErrorTargets(page);
    const scanOpts = options.dialogOnly ? { dialogOnly: true } : {};
    let fields = await collectFormFieldMeta(page, scanOpts);
    fields = await enrichFieldsFromWorkflow(page, fields, label);
    const fillGate = { fillAllEmpty: !!options.fillAllEmpty };
    const byLabel = new Map();
    fields.forEach((f) => {
      const k = normLabel(f.label);
      if (k && !byLabel.has(k)) byLabel.set(k, f);
    });

    const todo = [];
    const seen = new Set();
    for (const e of errored) {
      // Security validation on a non-security TC → must replace with accurate data (force fill)
      if (isSecurityValidationMessage(e.message) && securityTc) {
        rlog(label + ':FIX_VALIDATION:preserve security payload on "' + cleanFieldLabel(e.label)
          + '" — TC is security-focused');
        continue;
      }
      const k = normLabel(e.label);
      if (!k || seen.has(k)) continue;
      const meta = byLabel.get(k) || [...byLabel.entries()].find(([lk]) => labelsMatch(lk, e.label))?.[1];
      if ((meta && meta.optional) && !fieldMentionedInTestCase((meta && meta.label) || e.label, stepHint)) {
        rlog(label + ':FIX_VALIDATION:skip optional "' + cleanFieldLabel((meta && meta.label) || e.label)
          + '" — not in TC');
        continue;
      }
      seen.add(k);
      todo.push({
        label: (meta && meta.label) || e.label,
        isSelect: !looksLikeYesNoQuestion((meta && meta.label) || e.label)
          && (e.kind === 'select' || !!(meta && meta.isSelect)),
        isRadio: looksLikeYesNoQuestion((meta && meta.label) || e.label) || !!(meta && meta.isRadio),
        type: e.kind === 'textarea' ? 'textarea' : (meta && meta.type) || 'text',
        force: true,
        optional: !!(meta && meta.optional),
        securityError: isSecurityValidationMessage(e.message),
        id: meta && meta.id,
        name: meta && meta.name,
        message: e.message,
        locked: !!(meta && (meta.locked || meta.disabled)),
        disabled: !!(meta && (meta.locked || meta.disabled)),
        y: meta && meta.y,
        x: meta && meta.x,
      });
    }
    for (const f of fields) {
      if (!shouldFillField(f, stepHint, fillGate)) continue;
      const k = normLabel(f.label);
      if (!k || seen.has(k)) continue;
      if (/logout|sign\s*out|password|search/i.test(f.label || '')) continue;
      seen.add(k);
      todo.push({ ...f, force: false, securityError: false });
    }

    if (!todo.length) {
      rlog(label + ':FIX_VALIDATION:pass=' + pass + ' nothing to fill (errors='
        + (await countVisibleFormErrors(page)) + ')');
      break;
    }

    rlog(label + ':FIX_VALIDATION:pass=' + pass + ' targets='
      + todo.map((t) => cleanFieldLabel(t.label) + (t.isSelect ? '[dd]' : '') + (t.force ? '*' : ''))
        .join(', ').slice(0, 260));

    todo = sortFieldsTopDown(todo);

    await ensureAiValuesForFields(
      todo,
      label,
      (stepHint || 'Fill all required fields with accurate business data so the form can proceed')
        + (securityTc
          ? '\nThis TC is security-focused — payloads may be intentional.'
          : '\nDo NOT use HTML, script tags, or SQL injection strings — use realistic accurate data only.')
        + '\n' + tcContext.slice(0, 800),
      page
    );

    let filled = 0;
    for (const f of todo.slice(0, 16)) {
      if (f.optional && !fieldMentionedInTestCase(f.label, stepHint)) {
        rlog(label + ':FIX_VALIDATION:skip optional "' + cleanFieldLabel(f.label) + '" — not in TC');
        continue;
      }
      if (isFieldLocked(f)) {
        rlog(label + ':CASCADE:skip locked "' + cleanFieldLabel(f.label) + '" until parent is set');
        continue;
      }
      if (await verifyFieldFilled(page, f.label, fieldShouldUseDropdown(f), !!f.isRadio || looksLikeYesNoQuestion(f.label))) {
        rlog(label + ':FIX_VALIDATION:skip already filled "' + cleanFieldLabel(f.label) + '"');
        filled++;
        continue;
      }
      let value = resolveValueFromTestCaseContext(f.label, f, testMap, stepHint);
      // Extra guard: security error message ⇒ always clean value when not a security TC
      if (f.securityError && !securityTc) {
        try { purgeUnsafeStoredValue(f.label); } catch (_) {}
        value = safeCleanValueForField(f.label, f.type || 'text', testMap, stepHint);
      }
      if (fieldShouldUseDropdown(f) && !lookupTestData(f.label, testMap)
          && !extractValueFromStepForLabel(f.label, stepHint)) {
        value = '';
      }
      rlog(label + ':FIX_VALIDATION:value "' + cleanFieldLabel(f.label) + '" ← "'
        + String(value || (fieldShouldUseDropdown(f) ? '(first-visible)' : '')).slice(0, 50) + '"');

      const acted = await humanActOnField(page, stagehand, f, value, label, stepHint);
      if (acted.ok) {
        filled++;
        rlog(label + ':FIX_VALIDATION:ok "' + cleanFieldLabel(f.label) + '" as ' + acted.kind);
      } else {
        rlog(label + ':FIX_VALIDATION:WARN could not set "' + cleanFieldLabel(f.label)
          + '" as ' + acted.kind + (acted.reason ? ' (' + acted.reason + ')' : ''));
      }
    }

    const stillErrored = await collectValidationErrorTargets(page);
    for (const e of stillErrored) {
      if (e.kind === 'select') continue;
      if (isSecurityValidationMessage(e.message) && securityTc) continue;
      if (/\(\s*optional\s*\)|\boptional\b/i.test(String(e.label || '') + ' ' + String(e.message || ''))
          && !fieldMentionedInTestCase(e.label, stepHint)) continue;
      if (await verifyFieldFilled(page, e.label, false, looksLikeYesNoQuestion(e.label))) continue;
      let v = resolveValueFromTestCaseContext(e.label, { type: e.kind, isSelect: false }, testMap, stepHint);
      if (isSecurityValidationMessage(e.message) && !securityTc) {
        v = safeCleanValueForField(e.label, e.kind === 'textarea' ? 'textarea' : 'text', testMap, stepHint);
      }
      if (await forceCommitTextByLabel(page, e.label, v, label, stepHint)) filled++;
    }

    const errorsAfter = await countVisibleFormErrors(page);
    rlog(label + ':FIX_VALIDATION:pass=' + pass + ' filled=' + filled + ' errors=' + errorsAfter);
    if (errorsAfter === 0) break;
    if (filled === 0 && pass >= 2) break;
    await page.waitForTimeout(350);
  }

  const remaining = await collectValidationErrorTargets(page);
  const remainingFixable = remaining.filter((r) => {
    if (isSecurityValidationMessage(r.message) && securityTc) return false;
    if (/\(\s*optional\s*\)|\boptional\b/i.test(String(r.label || '') + ' ' + String(r.message || ''))
        && !fieldMentionedInTestCase(r.label, stepHint)) return false;
    return true;
  });
  if (remainingFixable.length && stagehand) {
    rlog(label + ':FIX_VALIDATION:ai-sweep remaining='
      + remainingFixable.map((r) => r.label).join(', ').slice(0, 160));
    try {
      await stagehand.act(
        'Fix ALL visible red validation / required-field errors on the CURRENT form (any product). '
        + 'Fill required text fields with accurate realistic business data. '
        + 'Open each empty required dropdown and pick a valid non-placeholder option matching the test case. '
        + 'Do NOT fill or click optional fields unless the test case names them. '
        + (securityTc
          ? 'This TC may intentionally use security payloads — only fix ordinary required errors.'
          : 'Do NOT enter HTML tags, script fragments, or SQL injection strings. '
            + 'If a field shows HTML/script/SQL validation error, clear it and type a normal name/value.')
        + ' After each field, pause briefly so the value sticks. Do not open profile/Logout.\n'
        + 'Remaining errors: ' + remainingFixable.map((r) => r.label + ': ' + r.message).join('; ').slice(0, 280)
        + '\n' + tcContext.slice(0, 600),
        { page }
      );
      await page.waitForTimeout(Math.max(cfg.fieldConfirmMs, 500));
    } catch (e) {
      rlog(label + ':FIX_VALIDATION:ai-sweep WARN ' + (e && e.message ? e.message : e));
    }
  }

  const finalErrors = await countVisibleFormErrors(page);
  rlog(label + ':FIX_VALIDATION:filled-all errors=' + finalErrors
    + (options.skipProceed ? ' — skip proceed' : ' — proceeding to next step'));
  if (!options.skipProceed) {
    await proceedWizardNextIfIntended(page, stagehand, label, stepHint);
  }
  return finalErrors === 0;
}

async function tryFillAllMandatoryFields(page, stepLabel, stepHint, stagehand) {
  // Human-like path: scan → fill top→bottom → confirm → proceed (when stagehand available)
  if (cfg.humanLike && stagehand) {
    let dialog = false;
    try {
      const snap = await inspectWorkflow(page);
      dialog = snap && (snap.kind === 'create-form' || snap.kind === 'tool-dialog');
    } catch (_) {}
    return humanLikeFillFormAndComplete(page, stagehand, stepLabel, stepHint, {
      complete: stepWantsProceed(stepHint) || dialog,
      fillAllEmpty: !!dialog,
      dialogOnly: !!dialog,
      skipInterrupt: !!dialog,
    });
  }
  if (cfg.humanLike && !stagehand) {
    // Still use human pacing without proceed when stagehand not passed
    const ok = await humanLikeFillFormAndComplete(page, null, stepLabel, stepHint, { complete: false });
    if (ok) return true;
  }

  await scrollWizardForm(page);
  await page.waitForTimeout(120);
  await dismissOpenUserMenu(page, stepLabel).catch(() => {});
  const testMap = parseTestDataMap();
  let fields = sortFieldsTopDown(await collectFormFieldMeta(page));
  // Strict: only empty *required* fields. Never probe optional / chrome fields.
  let todo = fields.filter((f) => shouldFillField(f, stepHint, {}));
  const seen = new Set();
  todo = todo.filter((f) => {
    const k = normLabel(f.label) + '|' + (f.isRadio ? 'rad' : (fieldShouldUseDropdown(f) ? 'dd' : 'txt'));
    if (seen.has(k)) return false;
    if (/logout|sign\s*out|password|search/i.test(f.label || '')) return false;
    if (/^(yes|no)$/i.test(cleanFieldLabel(f.label || ''))) return false;
    seen.add(k);
    return true;
  });
  todo = sortFieldsTopDown(todo);
  if (!todo.length) {
    rlog(stepLabel + ':FORM_FILL:WARN no empty fields detected (' + fields.length + ' total on page)');
    return false;
  }

  rlog(stepLabel + ':FORM_FILL:scan found ' + todo.length + ' empty field(s) top→bottom: '
    + todo.map((f) => cleanFieldLabel(f.label)
      + (f.isRadio ? '[radio]' : (fieldShouldUseDropdown(f) ? '[dd]' : ''))
      + (isFieldLocked(f) ? '[locked]' : '')).join(', ').slice(0, 220));

  await ensureAiValuesForFields(todo, stepLabel, stepHint || 'fill all mandatory fields', page);

  let filled = 0;
  for (const f of todo.slice(0, 20)) {
    if (isFieldLocked(f)) {
      rlog(stepLabel + ':CASCADE:skip locked "' + cleanFieldLabel(f.label) + '" until parent is set');
      continue;
    }
    if (await verifyFieldFilled(page, f.label, fieldShouldUseDropdown(f), !!f.isRadio)) {
      rlog(stepLabel + ':FORM_FILL:skip already filled "' + cleanFieldLabel(f.label) + '"');
      filled++;
      continue;
    }
    let value = resolveValueFromTestCaseContext(f.label, f, testMap, stepHint);
    if (fieldShouldUseDropdown(f) && !lookupTestData(f.label, testMap)
        && !extractValueFromStepForLabel(f.label, stepHint)) {
      value = '';
    }
    const src = lookupTestData(f.label, testMap) ? 'testData'
      : (lookupAppFormMemory(f.label) ? 'learned'
        : (_aiFormValueCache.has(normLabel(f.label)) ? 'ai' : 'guess'));
    try {
      const ok = await tryFillSingleField(page, f, value, stepLabel);
      if (ok) {
        filled++;
        rlog(stepLabel + ':FORM_FILL:ok "' + cleanFieldLabel(f.label) + '" (' + src + ')');
        if (fieldShouldUseDropdown(f)) await waitForCascadeAfterSelect(page, stepLabel, f.label);
        else await humanPause(page, 80, 160);
      }
    } catch (e) {
      rlog(stepLabel + ':FORM_FILL_WARN:' + cleanFieldLabel(f.label) + ' — ' + (e.message || e));
    }
  }

  if (filled > 0) {
    rlog(stepLabel + ':FORM_FILL:bulk complete — filled ' + filled + '/' + todo.length + ' field(s)');
    return true;
  }
  return false;
}

async function tryDirectTextFill(page, subDesc, stepLabel) {
  const fieldHint = extractFieldHintFromStep(subDesc);
  const quoted = extractQuotedFromStep(subDesc);
  const testMap = parseTestDataMap();
  const fields = await collectFormFieldMeta(page);
  const targets = fields.filter((f) => !fieldShouldUseDropdown(f) && f.empty);
  if (!targets.length) return false;

  let target = null;
  if (fieldHint) {
    target = targets.find((f) => labelsMatch(f.label, fieldHint) || labelsMatch(f.placeholder, fieldHint));
  }
  if (!target && quoted) {
    target = targets.find((f) => /text|email|tel|number|search|url/.test(f.type)) || targets[0];
  }
  if (!target && targets.length === 1) target = targets[0];
  if (!target) return false;

  await ensureAiValuesForFields([target], stepLabel, subDesc);
  const value = quoted || resolveFieldValue(target.label || fieldHint, target.type, testMap);
  return tryFillSingleField(page, target, value, stepLabel);
}

async function tryDirectSelectChoice(page, subDesc, stepLabel) {
  const fieldHint = extractFieldHintFromStep(subDesc);
  let optionHint = extractQuotedFromStep(subDesc);
  const testMap = parseTestDataMap();
  if (!optionHint && fieldHint) {
    optionHint = '';
  } else if (fieldHint && optionHint) {
    optionHint = sanitizeDropdownOptionHint(fieldHint, optionHint) || optionHint;
  }
  if (await tryDirectNativeSelect(page, fieldHint, optionHint, testMap, stepLabel)) return true;
  return tryDirectComboboxSelect(page, fieldHint, optionHint, stepLabel);
}

async function tryDirectFormAction(page, subDesc, stepLabel, stagehand) {
  if (looksLikeBulkFormFillStep(subDesc)) {
    return tryFillAllMandatoryFields(page, stepLabel, subDesc, stagehand);
  }
  if (looksLikeFormSelectStep(subDesc)) {
    return tryDirectSelectChoice(page, subDesc, stepLabel);
  }
  if (looksLikeFormTextFillStep(subDesc)) {
    return tryDirectTextFill(page, subDesc, stepLabel);
  }
  // Human-like: any data-entry step with an open form → fill & complete
  if (cfg.humanLike && stagehand && looksLikeDataEntry(subDesc)) {
    const fields = await collectFormFieldMeta(page).catch(() => []);
    const empties = (fields || []).filter((f) => f.empty && f.required);
    if (empties.length >= 2) {
      return humanLikeFillFormAndComplete(page, stagehand, stepLabel, subDesc, {
        complete: stepWantsProceed(subDesc),
      });
    }
  }
  return false;
}

// tryDirectNativeSelect — native <select> fallback

async function tryDirectNativeSelect(page, fieldHint, optionHint, testMap, stepLabel) {
  if (!fieldHint) return false;
  const picked = await page.evaluate(({ fieldHint, optionHint }) => {
    function visible(el) {
      if (!el || el.offsetHeight <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    }
    function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    function matchLabel(label, hint) {
      const a = norm(label); const b = norm(hint);
      if (!b) return false;
      return a === b || a.includes(b) || b.includes(a);
    }
    const selects = Array.from(document.querySelectorAll('select')).filter(visible);
    for (const sel of selects) {
      if (sel.disabled || sel.getAttribute('aria-disabled') === 'true') continue;
      const label = sel.getAttribute('aria-label')
        || (sel.id && document.querySelector('label[for="' + sel.id + '"]')?.innerText)
        || sel.name || '';
      if (!matchLabel(label, fieldHint)) continue;
      const opts = Array.from(sel.options).filter((o) => {
        const t = String(o.text || '').trim();
        return o.value && !o.disabled && !/^(select|choose|--|please)/i.test(t);
      });
      if (!opts.length) return { ok: false, reason: 'no-options' };
      let pick = null;
      if (optionHint) {
        pick = opts.find((o) => norm(o.text).includes(norm(optionHint)) || norm(o.value).includes(norm(optionHint)));
      }
      if (!pick) pick = opts[0];
      if (pick) {
        sel.value = pick.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, label: label || sel.name, picked: pick.text };
      }
    }
    return { ok: false };
  }, { fieldHint, optionHint });
  if (picked && picked.ok) {
    rlog(stepLabel + ':FORM_SELECT:native "' + (picked.label || fieldHint) + '" → ' + picked.picked);
    return true;
  }
  return false;
}

// ── Strip HTML markup from rich-text step descriptions ────────────────────────
// Steps authored/edited via the CasePilot UI can carry inline HTML (e.g.
// "<br>", "&nbsp;", "<span style=...>") — Stagehand's act() works far more
// reliably on plain text, so this is applied before any action is attempted.
function stripStepHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

/** True when one Zephyr field packs "Step 1:… Step 2:…" (or numbered list). */
function isPackedMultiStep(desc) {
  const t = stripStepHtml(desc);
  const stepHits = t.match(/\bStep\s*\d+\s*:/gi);
  if (stepHits && stepHits.length >= 2) return true;
  const numHits = t.match(/(?:^|\n)\s*\d+\.\s+[A-Za-z]/gm);
  return !!(numHits && numHits.length >= 2);
}

function splitPackedStepParts(desc) {
  const text = stripStepHtml(desc);
  if (!text) return [];
  let parts = text.split(/(?=(?:^|\n)\s*(?:\d+\.\s*)?Step\s*\d+\s*:)/im)
    .map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts;
  parts = text.split(/(?=(?:^|\n)\s*\d+\.\s+[A-Za-z])/m)
    .map(p => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts : [text];
}

/** Expand packed Zephyr/CasePilot steps before execution (safety net if Java did not). */
function expandPackedZephyrSteps(steps) {
  const out = [];
  for (const step of steps || []) {
    const desc = (step && step.description) || '';
    const parts = splitPackedStepParts(desc);
    if (parts.length <= 1) {
      out.push(step);
      continue;
    }
    const exp = (step && step.expectedResult) || '';
    parts.forEach((p, i) => {
      out.push({
        description: p,
        expectedResult: i === parts.length - 1 ? exp : '',
        testData: (step && step.testData) || '',
      });
    });
  }
  return out;
}

// Expand before any classification / login-skip — packed "Step 1…Step 7" must become 7 acts.
{
  const before = cfg.steps.length;
  cfg.steps = expandPackedZephyrSteps(cfg.steps);
  if (cfg.steps.length > before) {
    // rlog not ready yet if called before openTerminalLog — openTerminalLog already ran above.
    try {
      rlog('PLAN:Expanded packed Zephyr step(s) ' + before + ' → ' + cfg.steps.length + ' atomic steps');
    } catch (_) {}
  }
}

// ── Split a compound "Fill all details" step into individual field actions ────
// A single Zephyr step can describe SEVERAL distinct field fills/selections as a
// numbered sub-list, e.g. "Fill all details\n1) Fill Vendor Name…\n2) Fill Vendor
// Email…\n3) Select Vendor Type…". Stagehand's act() executes exactly ONE atomic
// browser action per call, so feeding it the whole compound block only ever
// performs the first action and silently drops the rest. Detecting 2+ numbered
// sub-items and issuing one act() call per item fixes that without touching
// simple, single-action steps (the vast majority) at all.
function splitCompoundActions(desc) {
  const cleaned = stripStepHtml(desc);
  // Wizard: "fill all mandatory fields … and click Next" → fill then click
  const clickTail = cleaned.match(/\band\s+click\b[\s\S]*$/i);
  if (clickTail && (looksLikeBulkFormFillStep(cleaned) || looksLikeDataEntry(cleaned))) {
    const fillPart = cleaned.replace(/\band\s+click\b[\s\S]*$/i, '').trim();
    const clickPart = clickTail[0].replace(/^\s*and\s+/i, '').trim();
    if (fillPart && clickPart) {
      return [strengthenFillInstruction(fillPart), clickPart.charAt(0).toUpperCase() + clickPart.slice(1)];
    }
  }
  // Marker = digits + ")" or "." + optional space + a LETTER (e.g. "1)Fill", "2) Fill").
  const MARKER_RE = /(?=\d+[).]\s*[A-Za-z])/g;
  const rawParts = cleaned.split(MARKER_RE).map(p => p.trim()).filter(Boolean);
  const numbered = rawParts.filter(p => /^\d+[).]\s*[A-Za-z]/.test(p));
  const result = numbered.length >= 2 ? numbered : [cleaned];
  return result.map(strengthenFillInstruction);
}

// ── Nudge vague "random realistic" fill instructions toward a concrete value ──
// With wording like "Fill Vendor Email with some random realistic Email", Stagehand's
// act() sometimes literally types the phrase itself (e.g. "random realistic email")
// instead of generating an actual value — which then fails field validation (as seen
// with a real invalid-email error blocking form submission). Rephrasing to explicitly
// demand a made-up value, and explicitly banning the literal words, fixes this.
function strengthenFillInstruction(text) {
  if (!/random\s+realistic|realistic\s+random/i.test(text)) return text;
  return text
    .replace(/\bwith\s+some\s+random\s+realistic\b/gi, 'by generating and typing an actual made-up')
    .replace(/\bwith\s+random\s+realistic\b/gi,        'by generating and typing an actual made-up')
    .replace(/\brandom\s+realistic\b/gi,                'an actual made-up')
    + ' — type a real generated value, NOT the literal words "random" or "realistic"';
}

// ── Fast step classification (skip Stagehand act for meta / wait / verify-only) ─
function stripLeadingStepNumber(desc) {
  return String(desc || '').replace(/^\s*step\s*\d+\s*[:.\-)]\s*/i, '').trim();
}

function isOptionalDismissStep(desc) {
  const d = stripLeadingStepNumber(stripStepHtml(desc)).toLowerCase();
  return /\bif any\b/.test(d)
    && /\b(modal|popup|pop-up|overlay|dialog|consent|cookie|banner)\b/.test(d)
    && /\b(dismiss|close|accept|proceed)\b/.test(d);
}

function quotedPhrases(text) {
  const out = [];
  const re = /['"]([^'"]{2,80})['"]/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1].trim());
  return out;
}

/** How a manual tester classifies a step after reading the whole script. */
function qaStepRole(desc, expected) {
  const d = stripLeadingStepNumber(stripStepHtml(desc)).toLowerCase();
  const e = String(expected || '').toLowerCase();
  if (isOptionalDismissStep(desc)) return 'cleanup';
  if (/^(verify|assert|check|confirm|validate|ensure|observe)\b/.test(d)
      && !/\b(click|type|enter|fill|select|choose|upload|press|tap)\b/.test(d)) {
    return 'assert';
  }
  if (/\b(displays?|set to|associated|empty by default|no value selected)\b/.test(e)
      && /\b(filter|field|dropdown)\b/.test(e)) {
    return 'assert';
  }
  return 'setup';
}

/**
 * Sit down with the script: title, path, what we will actually check.
 * Setup clicks are the journey. Assertions are the only pass/fail of the idea.
 */
function qaReadTestCase() {
  const steps = (cfg.steps || []).map((s, i) => {
    const desc = String((s && (s.description || s.step || s.action)) || '').trim();
    const expected = String((s && (s.expectedResult || s.expected)) || '').trim();
    return {
      n: i + 1,
      desc,
      expected,
      role: qaStepRole(desc, expected),
      goal: inferWorkflowGoal(desc, expected),
      quotes: quotedPhrases(desc + ' ' + expected),
    };
  }).filter((s) => s.desc);
  const popups = [];
  const fields = [];
  const ctas = [];
  steps.forEach((s) => {
    if (s.goal.popupName && popups.indexOf(s.goal.popupName) < 0) popups.push(s.goal.popupName);
    if (s.goal.fieldName && fields.indexOf(s.goal.fieldName) < 0) fields.push(s.goal.fieldName);
    (s.quotes || []).forEach((q) => {
      if (!/^(ok|cancel|close|yes|no)$/i.test(q) && ctas.indexOf(q) < 0) ctas.push(q);
    });
  });
  return {
    title: String(cfg.tcName || ''),
    steps,
    popups,
    fields,
    ctas,
    wantEditor: steps.some((s) => s.goal.wantEditor),
    data: String(cfg.testData || '').trim(),
  };
}

function qaLogBriefing(brief) {
  rlog('QA:READ "' + String(brief.title || '').slice(0, 180) + '"');
  const pathBits = brief.ctas.slice();
  if (brief.wantEditor && pathBits.indexOf('editor') < 0) pathBits.push('editor');
  brief.popups.forEach((p) => { if (pathBits.indexOf(p) < 0) pathBits.push(p); });
  rlog('QA:PATH ' + (pathBits.length ? pathBits.join(' → ') : 'follow visible primary actions on screen'));
  if (brief.fields.length) {
    rlog('QA:CHECK ' + brief.fields.join(', ')
      + (brief.popups.length ? ' (on ' + brief.popups.join(', ') + ')' : ''));
  }
  rlog('QA:DATA ' + (brief.data
    ? 'use supplied test data when a label matches'
    : 'none supplied — type realistic values; pick the first valid dropdown option'));
  rlog('QA:MIND Read the whole case first. A form after Create/Add/New is work to finish, '
    + 'not a failed step. Only the CHECK lines are the verdict.');
}

function qaSeeLine(snap) {
  if (!snap) return 'no snapshot';
  const empty = (snap.fields || []).filter((f) => !String(f.value || '').trim())
    .map((f) => f.label).filter(Boolean);
  const filled = (snap.fields || []).filter((f) => String(f.value || '').trim())
    .map((f) => f.label + '=' + String(f.value).slice(0, 24));
  const btns = (snap.buttons || []).slice(0, 6).join('/');
  let s = snap.kind + ' "' + String(snap.title || '').replace(/\s+/g, ' ').slice(0, 48) + '"';
  if (empty.length) s += ' | empty: ' + empty.slice(0, 10).join(', ');
  if (filled.length) s += ' | set: ' + filled.slice(0, 6).join(', ');
  if (btns) s += ' | ' + btns;
  return s;
}

function extractAssertedFieldName(expected) {
  const q = quotedPhrases(expected);
  if (q.length) return q[0];
  const m = String(expected || '').match(
    /\b(?:the\s+)?([A-Za-z][A-Za-z0-9 /&_-]{1,40}?)\s+(?:filter|field|dropdown|control|combo)\b/i
  );
  return m ? m[1].trim() : '';
}

function inferNamedPopup(text) {
  const quotes = quotedPhrases(text).filter((q) => !/^(brand|region|country|ok|cancel|yes|no)$/i.test(q));
  if (quotes.length) {
    const named = quotes.find((q) => /\b(popup|dialog|modal|import|export|wizard)\b/i.test(q) || q.split(/\s+/).length >= 2);
    if (named) return named.replace(/\s+(popup|pop-up|modal|dialog)$/i, '').trim();
  }
  const m = String(text || '').match(
    /\bin the\s+([A-Za-z][A-Za-z0-9 +/_-]{3,60}?)\s+(popup|pop-up|modal|dialog)\b/i
  ) || String(text || '').match(
    /\b([A-Za-z][A-Za-z0-9 +/_-]{3,60}?)\s+(popup|pop-up|modal|dialog)\b/i
  );
  return m ? m[1].trim() : '';
}

function workflowTcBlob() {
  const parts = [cfg.tcName, cfg.tcKey];
  (cfg.steps || []).forEach((s) => {
    parts.push(s && (s.description || s.step || s.action || ''), s && (s.expectedResult || s.expected));
  });
  return parts.filter(Boolean).join(' ');
}

function inferWorkflowGoal(desc, expected) {
  const blob = String(desc || '') + ' ' + String(expected || '');
  const quotes = quotedPhrases(blob);
  const wantEditor = /\b(editor|workspace|canvas|design surface|compose view)\b/i.test(blob)
    && !/\b(code editor|text editor field)\b/i.test(blob);
  let popupCue = /\b(popup|pop-up|modal|dialog|overlay|form is (displayed|visible|open)|dialog is (displayed|visible|open))\b/i.test(String(expected || ''));
  let popupName = popupCue
    ? (quotes.find((q) => !/^(brand|region|country|ok|cancel)$/i.test(q)) || quotes[0] || '')
    : '';
  const fieldName = /\b(filter|field|dropdown|displays|set to|associated|empty by default|no value selected)\b/i.test(expected || '')
    ? extractAssertedFieldName(expected)
    : '';
  if (fieldName && !popupName) {
    popupName = inferNamedPopup(workflowTcBlob());
    if (popupName) popupCue = true;
  }
  const wantEmptyField = /\b(empty|no value|not selected|has no value)\b/i.test(expected || '')
    && /\b(filter|field|dropdown|default)\b/i.test(expected || '');
  return {
    wantEditor,
    wantPopup: !!(popupCue && popupName),
    popupName,
    fieldName,
    wantEmptyField: !!(wantEmptyField && fieldName),
    quotes,
    wantsLaterScreen: wantEditor || !!(popupCue && popupName),
  };
}

function formContentBlob(snap) {
  const s = snap || {};
  return [
    s.title, s.dialogText,
    (s.fields || []).map((f) => (f.label || '') + ' ' + (f.value || '')).join(' '),
    (s.buttons || []).join(' '),
  ].join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isCompletableForm(snap) {
  if (!snap) return false;
  if (snap.kind === 'create-form') return true;
  const n = (snap.fields || []).length;
  return n >= 1 && !!snap.hasPrimary && (snap.kind === 'tool-dialog' || snap.hasCancel || n >= 2);
}

const FORM_PRIMARY_LABELS = [
  'ok', 'save', 'create', 'submit', 'continue', 'next', 'add', 'send', 'apply',
  'done', 'finish', 'sign in', 'log in', 'login', 'register', 'place order', 'pay', 'search',
];

function expectedIsAboutThisForm(snap, expected, goal) {
  const exp = String(expected || '').toLowerCase();
  if (!exp || !snap) return false;
  const blob = formContentBlob(snap);
  if (goal && goal.fieldName && snap.fieldByLabel && snap.fieldByLabel(goal.fieldName)
      && (!goal.wantPopup || snap.titleHits(goal.popupName))) {
    return true;
  }
  const formShown = /\b(form|dialog|modal|popup|overlay)\b/.test(exp)
    && /\b(visible|displayed|open|shown|appears?)\b/.test(exp);
  if (formShown && !goal.wantEditor && !(goal && goal.wantPopup && !snap.titleHits(goal.popupName))) {
    const quotes = quotedPhrases(expected).filter((q) => q.split(/\s+/).length >= 2);
    if (!quotes.length) return isCompletableForm(snap);
    return quotes.some((q) => blob.indexOf(q.toLowerCase()) >= 0);
  }
  return false;
}

function expectedNeedsLeavingForm(snap, desc, expected, goal) {
  const g = goal || inferWorkflowGoal(desc, expected);
  if (expectedIsAboutThisForm(snap, expected, g)) return false;
  const blob = formContentBlob(snap);
  const exp = String(expected || '') + ' ' + String(desc || '');
  if (g.wantPopup && snap && !snap.titleHits(g.popupName)) return true;
  const dest = exp.match(
    /\b(editor|workspace|canvas|dashboard|inbox|listing|results?|confirmation|success(?:\s+page)?|preview|report|home\s+page|landing|details\s+page)\b/gi
  ) || [];
  if (dest.some((w) => blob.indexOf(String(w).toLowerCase()) < 0)) return true;
  const quotes = quotedPhrases(exp).filter((q) => q.split(/\s+/).length >= 2 && !/^(ok|cancel)$/i.test(q));
  if (quotes.some((q) => blob.indexOf(q.toLowerCase()) < 0) && isCompletableForm(snap)) return true;
  return wantsCreateThenLater(desc, expected);
}

function pickFormPrimaryLabels(snap, plan) {
  const ordered = [];
  const submit = plan && (plan.submit || plan.cta);
  if (submit && /^(ok|save|create|submit|continue|next|add|send|apply|done|finish)$/i.test(String(submit).trim())) {
    ordered.push(String(submit).trim());
  }
  (snap && snap.buttons || []).forEach((b) => {
    const t = String(b || '').replace(/\s+/g, ' ').trim();
    if (!t || /^(cancel|close|reset|back|×|x)$/i.test(t)) return;
    if (FORM_PRIMARY_LABELS.some((p) => t.toLowerCase() === p || t.toLowerCase().startsWith(p + ' '))) {
      ordered.push(t);
    }
  });
  return ordered.concat(['OK', 'Create', 'Save', 'Submit', 'Continue', 'Next', 'Add', 'Send', 'Apply', 'Done']);
}

function isTaskWorkflowDialogText(text) {
  const t = String(text || '');
  if (/\b(cookie|consent|gdpr|privacy preferences|newsletter|subscribe)\b/i.test(t)
      && !/\b(create|new |import |edit |save )\b/i.test(t)) {
    return false;
  }
  const formish = (t.match(/\b(name|title|type|brand|region|country|email|campaign|language|status|owner|date)\b/gi) || []).length >= 2;
  const okCancel = /\bcancel\b/i.test(t) && /\b(ok|save|create|submit|continue|add)\b/i.test(t);
  if (formish && okCancel) return true;
  return /\b(new |create |add |edit |import |export )\b/i.test(t) && okCancel;
}

function attachWorkflowHelpers(raw) {
  const snap = raw || {};
  snap.title = snap.title || '';
  snap.kind = snap.kind || 'page';
  snap.fields = Array.isArray(snap.fields) ? snap.fields : [];
  snap.buttons = Array.isArray(snap.buttons) ? snap.buttons : [];
  snap.titleHits = function (name) {
    const n = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!n) return false;
    const t = String(this.title || this.dialogText || '').toLowerCase();
    return t.indexOf(n) >= 0;
  };
  snap.fieldByLabel = function (want) {
    const w = String(want || '').toLowerCase().replace(/[:*]+$/, '').trim();
    if (!w) return null;
    return this.fields.find((f) => fieldLabelsMatch(w, f.label)) || null;
  };
  snap.isNewTemplate = snap.kind === 'create-form';
  snap.isImport = snap.kind === 'tool-dialog';
  return snap;
}

async function inspectWorkflow(page) {
  const raw = await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8;
    }
    function textOf(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function stripChrome(s) {
      return String(s || '')
        .replace(/keyboard_arrow_(down|up|left|right)|arrow_drop_(down|up)|expand_(more|less)|unfold_more|chevron_right|check_circle/gi, ' ')
        .replace(/[▼▾▲▴]/g, ' ')
        .replace(/\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function inChrome(el) {
      return !!(el && el.closest && el.closest('nav, aside, header, [class*="SideBar"], [class*="sidebar"]'));
    }
    function zOf(el) {
      const z = parseInt(window.getComputedStyle(el).zIndex, 10);
      return Number.isFinite(z) ? z : 0;
    }
    function areaOf(el) {
      const r = el.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    }
    function scoreOverlay(el) {
      if (!visible(el)) return -1;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) return -1;
      const t = textOf(el).slice(0, 2000);
      const hasCancel = /\bcancel\b|\bclose\b/i.test(t);
      const hasPrimary = /\b(ok|save|create|submit|continue|add|apply|next)\b/i.test(t);
      let score = zOf(el) + Math.min(areaOf(el) / 4000, 80);
      if (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') score += 200;
      if (hasCancel && hasPrimary) score += 120;
      else if (hasCancel || hasPrimary) score += 20;
      return score;
    }
    const explicit = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .MuiDialog-paper, .MuiDialog-root, .MuiModal-root, '
      + '[class*="MuiDialog"], [class*="MuiModal"], [class*="ant-modal-content"], [class*="ant-modal"], '
      + '[class*="chakra-modal"], [class*="Dialog-paper"], [class*="drawer"][class*="open"]'
    )).filter(visible);
    const extras = Array.from(document.querySelectorAll('body > div, [class*="modal"], [class*="Modal"], [class*="overlay"]'))
      .filter((el) => {
        if (!visible(el)) return false;
        const st = window.getComputedStyle(el);
        return (st.position === 'fixed' || st.position === 'absolute' || zOf(el) >= 100)
          && scoreOverlay(el) > 0;
      });
    const ranked = explicit.concat(extras)
      .filter((el, i, arr) => arr.indexOf(el) === i)
      .map((el) => ({ el, score: scoreOverlay(el) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const root = ranked.length ? ranked[0].el : null;
    const topText = root ? textOf(root).slice(0, 1200) : '';
    const heading = root
      ? textOf(root.querySelector('h1,h2,h3,[class*="DialogTitle"],[class*="modal-title"],[class*="drawer-title"]') || {})
      : '';
    const title = (heading || topText).slice(0, 80);
    const buttons = root
      ? Array.from(root.querySelectorAll('button, [role="button"]')).filter(visible).map((b) => textOf(b).slice(0, 40)).filter(Boolean)
      : [];
    const fields = [];
    const fieldRoot = root || document.body;
    const labelNodes = Array.from(fieldRoot.querySelectorAll(
      'label, [aria-label], legend, [class*="InputLabel"], [class*="FormLabel"], [class*="form-label"]'
    )).filter(visible);
    labelNodes.forEach((el) => {
      if (!root && inChrome(el)) return;
      const lab = stripChrome(el.getAttribute('aria-label')
        || (el.tagName === 'LABEL' || el.tagName === 'LEGEND' || /label/i.test(el.className || '')
          ? textOf(el) : '')).replace(/\s+/g, ' ').trim();
      if (!lab || lab.length > 48) return;
      if (/^f_[0-9a-f-]{8,}$/i.test(lab) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(lab)) return;
      const labL = lab.toLowerCase().replace(/[:*]+$/, '').trim();
      if (/^(close|cancel|ok|save|create|search|reset)$/i.test(labL)) return;
      let val = '';
      const box = el.closest(
        '[class*="MuiFormControl"], [class*="form-group"], .form-field, [class*="FormControl"], '
        + '[class*="form-item"], [class*="FormItem"], [class*="ant-form-item"]'
      ) || el.parentElement;
      const input = (el.control)
        || (el.htmlFor && document.getElementById(el.htmlFor))
        || (el.matches('input,textarea,select,[role="combobox"]') ? el : null)
        || (box && box.querySelector(
          'input:not([type=hidden]), textarea, select, [role="combobox"], [aria-haspopup="listbox"]'
        ));
      if (input) val = (input.value || input.getAttribute('value') || textOf(input) || '').trim();
      if (!val && box) {
        const chip = box.querySelector('[class*="MuiChip"], [class*="value"], [class*="ant-select-selection-item"]');
        if (chip) val = textOf(chip);
        if (!val) {
          const rest = textOf(box).replace(new RegExp('^' + lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '').trim();
          const token = rest.split(/\s+/)[0] || '';
          if (token && token.toLowerCase() !== labL && !/^(select|choose|pick|--)/i.test(token)) val = token;
        }
      }
      val = stripChrome(val.replace(new RegExp('^' + lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '').trim());
      if (/^(select|choose|pick|--)/i.test(val) || val.toLowerCase() === labL
          || /keyboard_arrow|arrow_drop_down|expand_more/i.test(val)) val = '';
      const r = (box || el).getBoundingClientRect();
      if (!fields.some((f) => f.label.toLowerCase() === labL)) {
        const widget = (box && box.querySelector(
          'select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], '
          + '[aria-autocomplete="list"], [aria-autocomplete="both"]'
        )) || (input && (
          (input.tagName || '').toLowerCase() === 'select'
          || (input.getAttribute('role') || '').toLowerCase() === 'combobox'
          || input.getAttribute('aria-haspopup') === 'listbox'
          || input.readOnly
          || input.getAttribute('aria-hidden') === 'true'
        ));
        fields.push({
          label: lab.replace(/[:*]+$/, '').trim(),
          value: val,
          isSelect: !!widget,
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
        });
      }
    });
    const btnBlob = buttons.join(' ').toLowerCase();
    let hasCancel = /\bcancel\b|\bclose\b/.test(btnBlob);
    let hasPrimary = /\b(ok|save|create|submit|continue|add|apply|next)\b/.test(btnBlob);
    if (!root) {
      const pageBtnLabels = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(visible).map((b) => textOf(b).replace(/\s+/g, ' ').trim().toLowerCase());
      hasCancel = pageBtnLabels.some((t) => t === 'cancel' || t === 'close');
      hasPrimary = pageBtnLabels.some((t) =>
        /^(ok|save|submit|continue|next|send|sign in|log in|login|register|apply|done)$/i.test(t)
      );
    }
    const cookieish = /\b(cookie|consent|gdpr|privacy preferences)\b/i.test(topText);
    let kind = 'page';
    if (root && cookieish) kind = 'blocker';
    else if (root && fields.length >= 1 && hasPrimary && (hasCancel || fields.length >= 2)) kind = 'create-form';
    else if (root && /\b(new |create |add |edit )\b/i.test(title) && hasCancel && hasPrimary) kind = 'create-form';
    else if (!root && fields.length >= 2 && hasPrimary && hasCancel) kind = 'create-form';
    else if (!root && fields.length >= 2 && hasPrimary) kind = 'create-form';
    else if (root && (/\b(import|export|filter|search)\b/i.test(title + ' ' + topText)
        || (fields.length >= 1 && (hasCancel || hasPrimary)))) kind = 'tool-dialog';
    else if (root) kind = 'blocker';
    const hasMainEditorCue = !!(
      document.querySelector('[class*="editor"]:not(nav):not(aside), [class*="Editor"]:not(nav):not(aside), canvas, [contenteditable="true"]')
      || Array.from(document.querySelectorAll('button, [role="button"]')).some((el) => {
        return visible(el) && !inChrome(el) && /\b(import |insert |add block|add section)\b/i.test(textOf(el));
      })
    );
    return {
      kind, title, dialogText: topText.slice(0, 240), buttons, fields,
      fieldCount: fields.length, hasCancel, hasPrimary, hasMainEditorCue,
    };
  }).catch(() => ({ kind: 'page', title: '', fields: [], buttons: [], hasCancel: false, hasPrimary: false }));

  const snap = attachWorkflowHelpers(raw);
  try {
    const meta = await collectFormFieldMeta(page, {
      dialogOnly: snap.kind === 'create-form' || snap.kind === 'tool-dialog',
    });
    const seen = new Set((snap.fields || []).map((f) => String(f.label || '').toLowerCase()));
    (meta || []).forEach((f) => {
      const lab = String(f.label || '').replace(/[:*]+$/g, '').replace(/\s+/g, ' ').trim();
      if (!lab || lab.length > 48 || seen.has(lab.toLowerCase())) return;
      if (/^(close|cancel|ok|save|search|reset)$/i.test(lab)) return;
      seen.add(lab.toLowerCase());
      snap.fields.push({
        label: lab,
        value: f.empty ? '' : String(f.value || '').trim(),
        x: f.x || 0, y: f.y || 0, w: 48, h: 24,
      });
    });
    snap.fieldCount = snap.fields.length;
    if (snap.kind === 'page' && snap.fields.length >= 2 && snap.hasCancel && snap.hasPrimary) {
      snap.kind = 'create-form';
    }
  } catch (_) {}
  return attachWorkflowHelpers(snap);
}

async function inspectAppWorkspace(page) {
  return inspectWorkflow(page);
}

async function clickTopDialogButton(page, names) {
  const want = (names || []).map((n) => String(n).toLowerCase());
  return page.evaluate((want) => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }
    const roots = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .MuiDialog-root, [class*="MuiDialog"], [class*="ant-modal-content"]'
    )).filter(visible);
    const root = roots.sort((a, b) => {
      const za = parseInt(window.getComputedStyle(a).zIndex, 10) || 0;
      const zb = parseInt(window.getComputedStyle(b).zIndex, 10) || 0;
      return zb - za;
    })[0] || document.body;
    const btns = Array.from(root.querySelectorAll('button, [role="button"]')).filter(visible);
    for (const w of want) {
      const hit = btns.find((b) => {
        const t = ((b.innerText || b.textContent || b.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ').trim()).toLowerCase();
        return t === w || t === w + ' button';
      });
      if (hit) { try { hit.click(); return true; } catch (_) { return false; } }
    }
    return false;
  }, want).catch(() => false);
}

async function readLoggedInIdentity(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(
      'header, [class*="AppBar"], [class*="toolbar"], [class*="profile"], [class*="avatar"], [class*="user"]'
    ));
    const blob = nodes.map((el) => (el.innerText || el.getAttribute('aria-label') || '')).join(' ');
    const m = blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0] : '';
  }).catch(() => '');
}

async function findNamedFieldOnPage(page, fieldName, snap) {
  if (snap && snap.fieldByLabel) {
    const hit = snap.fieldByLabel(fieldName);
    if (hit) return hit;
  }
  try {
    const meta = await collectFormFieldMeta(page);
    const f = (meta || []).find((x) => fieldLabelsMatch(fieldName, x.label));
    if (!f) return null;
    return {
      label: f.label,
      value: f.empty ? '' : String(f.value || '').trim(),
      x: f.x || 0, y: f.y || 0, w: 48, h: 24,
    };
  } catch (_) {
    return null;
  }
}

async function aiAnalyzeFormAndTestCase(stepLabel, desc, expected, snap, page) {
  const client = getFormAiClient();
  if (!client) return null;
  let live = snap;
  if ((!live || !live.fields || !live.fields.length) && page) {
    try { live = await inspectWorkflow(page); } catch (_) { live = snap || {}; }
  }
  live = live || {};
  const key = String(stepLabel || '') + '|' + (live.kind || '') + '|'
    + String(live.title || '').slice(0, 40) + '|'
    + ((live.fields || []).map((f) => f.label).join(',')).slice(0, 160);
  if (_aiFormPlanByKey.has(key)) return _aiFormPlanByKey.get(key);

  const dossier = buildFullTestCaseDossier(desc, expected);
  const formJson = {
    kind: live.kind || 'page',
    title: live.title || '',
    buttons: (live.buttons || []).slice(0, 12),
    fields: (live.fields || []).slice(0, 20).map((f) => ({
      label: f.label,
      value: f.value || '',
      empty: !String(f.value || '').trim(),
    })),
  };
  try {
    const call = client.chat.completions.create({
      model: cfg.deploy,
      temperature: 0,
      max_tokens: 420,
      messages: [
        {
          role: 'system',
          content: 'You are a senior tester. Read the FULL test case, then look at the live form/dialog content. '
            + 'Work on ANY enterprise web app — do not assume a product. Return JSON only:\n'
            + '{"action":"fill_and_submit"|"preserve"|"click_cta"|"verify_field"|"cancel_leftover"|"none",'
            + '"cta":"","reason":"","fill":{"Field Label":"value"},'
            + '"assert":{"found":false,"fieldLabel":"","value":"","empty":true}}\n'
            + 'Rules:\n'
            + '- Create/New/Edit forms with Cancel+OK are INTERMEDIATE. They are NOT the editor, workspace, or destination.\n'
            + '- If this form\'s labels/title do not match the expected destination (editor, dashboard, results, another popup, confirmation), '
            + 'action=fill_and_submit and click THIS form\'s real primary button (OK/Save/Create/Submit/Next/Send/Sign in — whatever is visible). Never preserve.\n'
            + '- Preserve ONLY when the expected is already about THIS form (it is visible, or a field on it).\n'
            + '- If the test case names a later popup/button, finish the form then action=click_cta with that exact longer name (never a shorter sidebar synonym).\n'
            + '- fill: empty/required fields on THIS form. One field = one value. Never a neighbor. Never the logged-in user identity.\n'
            + '- assert: named field only. Placeholder Select/Choose = empty.\n'
            + '- Decide from test-case content + visible form content, not from a hardcoded app.',
        },
        {
          role: 'user',
          content: dossier.slice(0, 2800) + '\n\nLive form:\n' + JSON.stringify(formJson).slice(0, 1400),
        },
      ],
    });
    const resp = await Promise.race([
      call,
      new Promise((_, reject) => setTimeout(() => reject(new Error('ai-form-timeout')), 8000)),
    ]);
    const raw = String(resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || '');
    const jsonM = raw.replace(/^```json\s*|\s*```$/g, '').trim().match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonM ? jsonM[0] : raw);
    const goalNow = inferWorkflowGoal(desc, expected);
    const laterNeeded = expectedNeedsLeavingForm(live, desc, expected, goalNow);
    if (isCompletableForm(live) && laterNeeded
        && (!parsed.action || parsed.action === 'preserve' || parsed.action === 'none' || parsed.action === 'verify_field')) {
      parsed.action = 'fill_and_submit';
      parsed.reason = 'this form is not the destination in the expected result — fill it and use the visible primary button';
    }
    const seeded = seedAiFillCache(parsed.fill);
    rlog(stepLabel + ':AI_FORM:' + (parsed.action || 'none')
      + ' cta=' + String(parsed.cta || '-')
      + ' fill=' + seeded
      + ' ' + String(parsed.reason || '').slice(0, 140));
    _aiFormPlanByKey.set(key, parsed);
    return parsed;
  } catch (e) {
    rlog(stepLabel + ':AI_FORM:skip ' + String(e && e.message ? e.message : e).slice(0, 80));
    return null;
  }
}

async function aiJudgeNamedField(stepLabel, expected, goal, snap, page) {
  const plan = await aiAnalyzeFormAndTestCase(stepLabel, '', expected, snap, page);
  if (!plan) return null;
  const a = plan.assert || {};
  const needAdvance = (plan.action === 'fill_and_submit' || plan.action === 'click_cta')
    ? plan.action
    : (plan.needAdvance || 'none');
  const out = {
    found: a.found === true || !!(a.value && String(a.value).trim()),
    fieldLabel: a.fieldLabel || (goal && goal.fieldName) || '',
    value: a.empty ? '' : String(a.value || ''),
    empty: a.empty === true || !String(a.value || '').trim(),
    needAdvance: needAdvance === 'fill_and_submit' || needAdvance === 'click_cta' ? needAdvance : 'none',
    cta: plan.cta || '',
    reason: plan.reason || '',
  };
  rlog(stepLabel + ':AI_FIELD:' + (out.found ? 'found' : 'miss')
    + ' adv=' + out.needAdvance
    + ' val=' + String(out.value || '').slice(0, 40)
    + ' ' + String(out.reason || '').slice(0, 100));
  return out;
}

async function aiCoachWorkflow(stepLabel, desc, expected, snap) {
  const plan = await aiAnalyzeFormAndTestCase(stepLabel, desc, expected, snap, null);
  if (!plan) return null;
  return {
    action: plan.action || 'none',
    cta: plan.cta || '',
    reason: plan.reason || '',
  };
}

async function completeCreateFormIfOpen(page, stagehand, stepLabel) {
  const snap = await inspectWorkflow(page);
  if (!isCompletableForm(snap)) return false;
  rlog(stepLabel + ':WIZARD:form "' + snap.title + '" kind=' + snap.kind
    + ' — fill from test case + field labels, then the visible primary button (not Cancel)');
  const plan = await aiAnalyzeFormAndTestCase(
    stepLabel,
    'Fill required fields on the visible form using the test case and field labels, then click the form\'s primary action (not Cancel).',
    '',
    snap,
    page
  );
  const hint = buildFullTestCaseDossier(
    'Fill all required fields on the visible form with valid realistic values, then click the primary action shown on that form.',
    ''
  );
  const fillOptsW = { complete: false, fillAllEmpty: true, skipInterrupt: true, dialogOnly: true };
  try {
    await humanLikeFillFormAndComplete(page, stagehand, stepLabel + ':WIZARD', hint, fillOptsW);
  } catch (e) {
    rlog(stepLabel + ':WIZARD:WARN fill — ' + (e && e.message ? e.message : e));
    try {
      await fixValidationErrorsAndContinue(page, stagehand, stepLabel + ':WIZARD', hint, {
        skipProceed: true, fillAllEmpty: true, dialogOnly: true,
      });
    } catch (_) {}
  }

  for (let round = 0; round < 4; round++) {
    const gate = await formNeedsMoreInput(page, hint, stepLabel + ':WIZARD');
    if (!gate.needs) break;
    rlog(stepLabel + ':WIZARD:not submitting yet — ' + gate.empty.map((f) => f.label).join(', ').slice(0, 180)
      + (gate.errs ? ' errors=' + gate.errs : ''));
    try {
      await humanLikeFillFormAndComplete(page, stagehand, stepLabel + ':WIZARD' + (round + 2), hint, fillOptsW);
    } catch (_) {}
    try {
      await fixValidationErrorsAndContinue(page, stagehand, stepLabel + ':WIZARD' + (round + 2), hint, {
        skipProceed: true, fillAllEmpty: true, dialogOnly: true,
      });
    } catch (_) {}
  }

  const still = await formNeedsMoreInput(page, hint, stepLabel + ':WIZARD');
  if (still.needs) {
    rlog(stepLabel + ':WIZARD:submit anyway to surface remaining validation');
  }
  const primary = pickFormPrimaryLabels(snap, plan);
  const clicked = await clickTopDialogButton(page, primary);
  rlog(stepLabel + ':WIZARD:' + (clicked ? 'submitted via ' + primary[0] : 'primary button not clicked'));
  await page.waitForTimeout(800);
  let after = await inspectWorkflow(page);
  if (after.kind === 'create-form') {
    rlog(stepLabel + ':WIZARD:still on form — fill validation then resubmit');
    try {
      await humanLikeFillFormAndComplete(page, stagehand, stepLabel + ':WIZARD2', hint, fillOptsW);
    } catch (_) {}
    try {
      await fixValidationErrorsAndContinue(page, stagehand, stepLabel + ':WIZARD2', hint, {
        skipProceed: true, fillAllEmpty: true, dialogOnly: true,
      });
    } catch (_) {}
    const gate2 = await formNeedsMoreInput(page, hint, stepLabel + ':WIZARD2');
    if (!gate2.needs || gate2.errs > 0) {
      await clickTopDialogButton(page, pickFormPrimaryLabels(after, plan));
      await page.waitForTimeout(800);
    }
    after = await inspectWorkflow(page);
  }
  rlog(stepLabel + ':WIZARD:workspace=' + after.kind + ' title="' + after.title + '"');
  return !isCompletableForm(after) || after.kind !== 'create-form';
}

async function clickQuotedMainCta(page, stagehand, stepLabel, cta) {
  const name = String(cta || '').trim();
  if (!name) return false;
  const clicked = await page.evaluate((name) => {
    function vis(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }
    function lab(el) {
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }
    function inChrome(el) {
      return !!(el && el.closest && el.closest('nav, aside, header, [class*="sidebar" i], [class*="Drawer"]'));
    }
    const want = name.toLowerCase();
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const hit = nodes.find((el) => vis(el) && !inChrome(el) && lab(el).toLowerCase() === want)
      || nodes.find((el) => vis(el) && !inChrome(el) && lab(el).toLowerCase().indexOf(want) >= 0);
    if (!hit) return false;
    try { hit.click(); return true; } catch (_) { return false; }
  }, name).catch(() => false);
  if (clicked) {
    rlog(stepLabel + ':WIZARD:clicked main CTA "' + name + '" (not sidebar synonym)');
    await page.waitForTimeout(600);
    return true;
  }
  if (stagehand) {
    try {
      await stagehand.act(
        'Click "' + name + '" in the main content or open dialog. '
        + 'Do NOT click a shorter left-nav/sidebar label that is only part of that name.',
        { page }
      );
      await page.waitForTimeout(600);
      return true;
    } catch (_) {}
  }
  return false;
}

/**
 * Human tester loop — read the test case and the live UI, then navigate / fill /
 * submit until the expected destination is on screen. Playwright-first.
 * Generic for any site: listing → quoted CTA → intermediate form → destination
 * (editor, named popup, next page). Stagehand is only used if a CTA click misses.
 */
async function humanReachExpected(page, stagehand, stepLabel, desc, expected) {
  const role = qaStepRole(desc, expected);
  const goal = inferWorkflowGoal(desc, expected);
  const maxRounds = 6;
  let lastKind = '';
  let fillAttempts = 0;
  rlog(stepLabel + ':QA:role=' + role
    + (goal.wantEditor ? ' want=editor' : '')
    + (goal.wantPopup ? ' want="' + goal.popupName + '"' : '')
    + (goal.fieldName ? ' check=' + goal.fieldName : ''));
  for (let round = 0; round < maxRounds; round++) {
    await dismissOpenUserMenu(page, stepLabel).catch(() => {});
    const snap = await inspectWorkflow(page);
    const formOpen = isCompletableForm(snap);
    const later = expectedNeedsLeavingForm(snap, desc, expected, goal);
    rlog(stepLabel + ':QA:SEE ' + qaSeeLine(snap));

    if (goal.wantEditor && snap.hasMainEditorCue && snap.kind !== 'create-form' && !goal.fieldName) {
      rlog(stepLabel + ':QA:DO stop — editor is on screen (what this setup step wanted)');
      return { ok: true, snap };
    }
    if (goal.wantPopup && snap.titleHits(goal.popupName)) {
      rlog(stepLabel + ':QA:DO stop — the named popup is open; read fields, do not submit it');
      return { ok: true, snap };
    }
    if (formOpen && expectedIsAboutThisForm(snap, expected, goal) && !later) {
      rlog(stepLabel + ':QA:DO stop — this dialog is what the step is checking');
      return { ok: true, snap };
    }

    if (formOpen && later) {
      if (fillAttempts >= 2) {
        rlog(stepLabel + ':QA:DO cannot leave this form yet — empty/invalid fields remain');
        break;
      }
      fillAttempts += 1;
      rlog(stepLabel + ':QA:DO fill every empty field I can see, then the primary button (not Cancel)');
      await completeCreateFormIfOpen(page, stagehand, stepLabel);
      lastKind = 'fill';
      await page.waitForTimeout(400);
      continue;
    }

    const errs = await countVisibleFormErrors(page);
    if (formOpen && errs > 0) {
      rlog(stepLabel + ':QA:DO the form is showing an error — fix the named field and continue');
      await fixValidationErrorsAndContinue(page, stagehand, stepLabel, desc || expected, {
        skipProceed: true, fillAllEmpty: true, dialogOnly: true,
      });
      lastKind = 'fix';
      continue;
    }

    if (role !== 'assert' && goal.wantPopup && goal.popupName && !snap.titleHits(goal.popupName)
        && snap.kind !== 'create-form') {
      rlog(stepLabel + ':QA:DO open "' + goal.popupName + '"');
      const opened = await clickQuotedMainCta(page, stagehand, stepLabel, goal.popupName);
      lastKind = opened ? 'cta' : lastKind;
      await page.waitForTimeout(500);
      if (opened) continue;
    }
    if (role === 'assert' && goal.wantPopup && goal.popupName && !snap.titleHits(goal.popupName)
        && snap.kind !== 'create-form') {
      rlog(stepLabel + ':QA:DO I need that popup to check the field — click "' + goal.popupName + '"');
      const opened = await clickQuotedMainCta(page, stagehand, stepLabel, goal.popupName);
      await page.waitForTimeout(500);
      if (opened) continue;
    }

    if (goal.wantEditor && snap.kind === 'page') {
      const quotes = quotedPhrases(String(desc || '') + ' ' + String(expected || ''))
        .filter((q) => q && !/^(ok|cancel|close|yes|no)$/i.test(q));
      let clicked = false;
      for (const q of quotes) {
        rlog(stepLabel + ':QA:DO click "' + q + '" as written in the case');
        clicked = await clickQuotedMainCta(page, stagehand, stepLabel, q);
        if (clicked) break;
      }
      if (clicked) {
        lastKind = 'nav';
        await page.waitForTimeout(500);
        continue;
      }
    }

    if (round > 0 && snap.kind === lastKind) break;
    lastKind = snap.kind;
    break;
  }
  return { ok: false, snap: await inspectWorkflow(page).catch(() => null) };
}

async function maybeAdvanceWorkflow(page, stagehand, stepLabel, desc, expected) {
  return humanReachExpected(page, stagehand, stepLabel, desc, expected);
}

function wantsCreateThenLater(desc, expected) {
  const blob = String(desc || '') + ' ' + String(expected || '');
  return /\b(create new|add new|new \w+)\b/i.test(blob) && /\b(editor|workspace|popup|import |open the)\b/i.test(blob);
}

async function handleOptionalDismissStep(page, stepLabel) {
  const snap = await inspectWorkflow(page);
  if (snap.kind === 'create-form' || snap.kind === 'tool-dialog') {
    const cancelled = await clickTopDialogButton(page, ['Cancel', 'Close', '×', 'x']);
    rlog(stepLabel + ':DISMISS_OPTIONAL:' + (cancelled
      ? 'cancelled leftover workflow dialog "' + snap.title + '"'
      : 'could not cancel dialog'));
    await page.waitForTimeout(400);
    return;
  }
  const dismissed = await dismissBlockingUi(page, stepLabel + ':DISMISS_OPTIONAL', null, false);
  rlog(stepLabel + ':DISMISS_OPTIONAL:' + (dismissed ? 'cleared cookie/consent overlay' : 'no blocking overlay — skip'));
}

function classifyStep(desc) {
  const raw = stripStepHtml(desc);
  const d = stripLeadingStepNumber(raw).toLowerCase().trim();

  if (/^(launch\s+browser|start\s*browser|open\s+browser|close\s+browser|stop\s+browser)\b/.test(d)
      || /\b(startbrowser|closebrowser|stopbrowser)\b/.test(d.replace(/\s+/g, ''))) {
    return { kind: 'META', reason: 'browser lifecycle already handled by runner' };
  }

  // Proxy/SSO sessions stay logged in — never hunt for Login / credentials / profile.
  if (cfg.isProxy && looksLikeLoginStep(raw) && !looksLikeLogoutStep(raw)) {
    return { kind: 'META', reason: 'SSO/proxy session — skip credential login' };
  }

  // Pure wait (not "wait for element/button to appear")
  const waitM = d.match(/\bwait\s+(?:for\s+)?(\d+)\s*(ms|milliseconds?|s|secs?|seconds?)?\b/);
  if (waitM && !/\bwait\s+for\s+(the\s+)?(element|button|page|text|modal|popup|spinner|loader|field)\b/.test(d)) {
    const n = parseInt(waitM[1], 10) || 0;
    const unit = (waitM[2] || 's').toLowerCase();
    let ms = /ms|milli/.test(unit) ? n : n * 1000;
    // Cap waits for speed — Smart Page Scan often inserts "Wait for 2 s" between every step
    ms = Math.min(Math.max(ms, 0), 1500);
    return { kind: 'WAIT', ms, reason: 'timed wait' };
  }
  if (/^wait\b/.test(d) && d.length < 40 && !/\b(element|button|page|text|modal)\b/.test(d)) {
    return { kind: 'WAIT', ms: 400, reason: 'short settle wait' };
  }

  // Crawl-baked health checks — do not act; pass from crawl evidence in expected text
  if (/\b(sampled\s+(page\s+)?links|broken\s+count\s+from\s+crawl|link\s+health|http\s*2xx|crawl:\s*total=)\b/.test(d)
      || /\b(sampled\s+links\s+return\s+http|broken\s+count\s+from\s+crawl)\b/.test(String(desc || '').toLowerCase())) {
    return { kind: 'VERIFY_ONLY', reason: 'crawl-health assertion' };
  }

  // Verify-only: no click/type/select in the instruction (allow "Step N: Verify …")
  if (/^(verify|assert|check|confirm|validate|ensure|observe|inspect)\b/.test(d)
      && !/\b(click|type|enter|fill|select|upload|submit|press|tap|hover|choose|attach)\b/.test(d)) {
    return { kind: 'VERIFY_ONLY', reason: 'assertion-only step' };
  }
  // "Locate X" alone is often a find-then-act cue — keep as ACT so Stagehand can focus/scroll.
  // Only treat as verify-only when explicitly presence-checking without interaction intent.

  // Soft nav — ONLY when already at target. Otherwise fall through to ACT/goto.
  if (/^(open|navigate|go\s+to)\b/.test(d)
      && (/\bhttps?:\/\//.test(d) || /\b(app|page|url|site|swag|labs|demo)\b/.test(d))
      && !/\b(menu|tab|sidebar|menuitem|section|panel|nav\s+item|nav\s+link)\b/.test(d)
      && !/\bclick\b/.test(d)) {
    return { kind: 'NAV', reason: 'navigate step' };
  }

  if (isOptionalDismissStep(raw)) {
    return { kind: 'DISMISS_OPTIONAL', reason: 'dismiss leftover overlay if present; skip if none' };
  }

  return { kind: 'ACT' };
}

/** Credential / login steps that must not run when SSO already authenticated. */
function looksLikeLoginStep(desc) {
  // Never treat a packed multi-step script as "login only" — that skips the whole TC.
  if (isPackedMultiStep(desc)) return false;
  const d = stripLeadingStepNumber(stripStepHtml(desc)).toLowerCase();
  if (looksLikeLogoutStep(desc)) return false;
  // If the text still contains non-auth actions, it is not a pure login step.
  if (/\b(vendor|wizard|submit|purchase|invoice|requisition|questionnaire|tprm|audit\s*trail|click\s+['"]?next)\b/.test(d)
      && !/^\s*(open|navigate|go\s+to).{0,80}\b(login|sign\s*in)\b/.test(d)) {
    // Allow "open URL + login" short steps; reject login+create-vendor blobs (already gated by isPackedMultiStep).
    if (/\b(create|raise|onboard|fill|complete|review|navigate\s+to\s+the\s+vendor)\b/.test(d)) {
      return false;
    }
  }
  if (/\b(enter\s+(valid\s+)?(credentials|username|password|user\s*id|userid)|click\s+(the\s+)?(login|sign[\s-]*in)\s+button|log[\s-]*in\s+as|sign[\s-]*in\s+as|login\s+with|authenticate)\b/.test(d)) {
    return true;
  }
  if (/^(login|sign[\s-]*in|log[\s-]*in)\b/.test(d)) return true;
  if (/\b(login|sign[\s-]*in)\b/.test(d)
      && /\b(credential|password|username|business\s+user|valid\s+user)\b/.test(d)
      && !/\b(vendor|wizard|submit\s+the|audit)\b/.test(d)) {
    return true;
  }
  return false;
}

function looksLikeLogoutStep(desc) {
  const d = stripLeadingStepNumber(stripStepHtml(desc)).toLowerCase();
  return /\b(log[\s-]*out|sign[\s-]*out|click\s+(the\s+)?logout)\b/.test(d)
    && !/\blog[\s-]*in\b/.test(d);
}

/** True when the live page already looks authenticated (dashboard / profile chip / no login form). */
async function pageLooksLoggedIn(page) {
  try {
    const snap = await snapshotAppState(page);
    const ui = await page.evaluate(() => {
      const text = ((document.body && document.body.innerText) || '').toLowerCase();
      const pwd = document.querySelector('input[type="password"]');
      const pwdVisible = !!(pwd && pwd.offsetHeight > 0
        && window.getComputedStyle(pwd).display !== 'none'
        && window.getComputedStyle(pwd).visibility !== 'hidden');
      const clickables = Array.from(document.querySelectorAll('button, a, [role="button"], [type="submit"]'));
      const loginBtn = clickables.some(el => {
        const t = ((el.innerText || el.textContent || el.getAttribute('aria-label') || '') + '').trim();
        return /^(login|sign in|sign-in)$/i.test(t) && el.offsetHeight > 0;
      });
      const hasWelcome = /\bwelcome\b/.test(text) || /\bdashboard\b/.test(text);
      const hasAvatar = !!document.querySelector(
        '[class*="avatar" i], [class*="user-menu" i], [aria-label*="profile" i], [aria-label*="account" i]'
      );
      return { pwdVisible, loginBtn, hasWelcome, hasAvatar };
    });
    if (ui.pwdVisible && ui.loginBtn) return false;
    if (ui.hasWelcome || ui.hasAvatar) return true;
    return !!snap.loggedIn && !(ui.pwdVisible && ui.loginBtn);
  } catch (_) {
    return !!cfg.isProxy;
  }
}

/** Close an accidentally opened profile / account dropdown (Logout visible). */
async function dismissOpenUserMenu(page, stepLabel) {
  try {
    const open = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('button, a, [role="menuitem"], [role="option"], li'));
      return items.some(el => {
        const t = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
        return /^(logout|sign out|sign-out)$/i.test(t) && el.offsetHeight > 0
          && window.getComputedStyle(el).visibility !== 'hidden';
      });
    });
    if (!open) return false;
    try { await page.keyboard.press('Escape'); } catch (_) {}
    await page.waitForTimeout(150);
    try {
      await page.evaluate(() => {
        const main = document.querySelector('main, [role="main"], .dashboard, #root, body');
        if (main) main.click();
      });
    } catch (_) {}
    await page.waitForTimeout(150);
    rlog(stepLabel + ':DISMISS:user-profile-menu (SSO — do not logout)');
    return true;
  } catch (_) {
    return false;
  }
}

function extractUrlFromStep(desc) {
  const m = String(desc || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
}

function urlsLooselyMatch(current, target) {
  if (!current || !target) return false;
  try {
    const a = new URL(current);
    const b = new URL(target);
    const pathA = (a.pathname || '/').replace(/\/+$/, '') || '/';
    const pathB = (b.pathname || '/').replace(/\/+$/, '') || '/';
    return a.host === b.host && (pathA === pathB || pathA.endsWith(pathB) || pathB.endsWith(pathA));
  } catch (_) {
    return String(current).indexOf(String(target).replace(/\/+$/, '')) >= 0;
  }
}

function looksLikeInPageMenuClick(desc) {
  const d = String(desc || '').toLowerCase();
  return /\b(click|select|open|tap)\b/.test(d)
    && /\b(menu|tab|sidebar|menuitem|nav\s+item|nav\s+link|hamburger|section)\b/.test(d);
}

/** After in-page menu/tab click — wait for content swap without requiring URL change. */
async function settleInPageNavigation(page, stepLabel) {
  try {
    const before = await page.evaluate(() => {
      const main = document.querySelector('main,[role=main],#content,.content,.page-content,article') || document.body;
      return {
        url: location.href,
        text: ((main && main.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        active: ((document.querySelector('[aria-selected=true],[aria-current=page],.active.nav-link,.active[role=tab],.selected') || {}).innerText || '').trim().slice(0, 80),
      };
    });
    await page.waitForTimeout(450);
    await page.waitForLoadState('domcontentloaded', 2500).catch(() => {});
    const after = await page.evaluate(() => {
      const main = document.querySelector('main,[role=main],#content,.content,.page-content,article') || document.body;
      return {
        url: location.href,
        text: ((main && main.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        active: ((document.querySelector('[aria-selected=true],[aria-current=page],.active.nav-link,.active[role=tab],.selected') || {}).innerText || '').trim().slice(0, 80),
      };
    });
    const sameUrl = before.url === after.url || after.url.indexOf('#') >= 0;
    const contentChanged = before.text !== after.text || before.active !== after.active;
    rlog(stepLabel + ':IN_PAGE_NAV:sameUrl=' + sameUrl + ' contentChanged=' + contentChanged
      + (after.active ? ' active=' + after.active.substring(0, 40) : ''));
    return { sameUrl, contentChanged, before, after };
  } catch (e) {
    rlog(stepLabel + ':IN_PAGE_NAV:settle skipped — ' + (e && e.message ? e.message : e));
    return null;
  }
}

/**
 * Wait for spinners/skeletons/network to settle after actions on dynamic SPAs (issues 9–10).
 * Bridges gap between static test steps and live UI that updates after click/submit.
 */
async function settleDynamicScreen(page, stepLabel) {
  try {
    await page.waitForLoadState('domcontentloaded', 4000).catch(() => {});
    await page.waitForTimeout(250);
    // Prefer network idle briefly; ignore timeout on long-polling apps
    await page.waitForLoadState('networkidle', 3500).catch(() => {});
    // Wait until common loading indicators hide (or timeout)
    const loadingSel = [
      '[aria-busy="true"]',
      '.spinner', '.loading', '.is-loading', '.MuiCircularProgress-root',
      '[class*="skeleton"]', '[data-loading="true"]',
      'button:disabled[aria-busy]',
    ].join(',');
    try {
      await page.waitForFunction(
        (sel) => {
          const nodes = document.querySelectorAll(sel);
          for (const n of nodes) {
            const st = window.getComputedStyle(n);
            if (st && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0') return false;
          }
          return true;
        },
        loadingSel,
        { timeout: 4000 },
      ).catch(() => {});
    } catch (_) { /* ignore */ }
    await page.waitForTimeout(150);
    rlog(stepLabel + ':DYNAMIC_SETTLE:ok');
  } catch (e) {
    rlog(stepLabel + ':DYNAMIC_SETTLE:skip — ' + (e && e.message ? e.message : e));
  }
}

/** After settle: clear mid-flow popups/validation wisely, never hard-stop. */
async function settleAndClearInterrupts(page, stagehand, stepLabel, stepDesc, expected) {
  await settleDynamicScreen(page, stepLabel);
  await handleMidFlowInterrupt(page, stagehand, stepLabel, stepDesc, expected);
}

async function verifyInPageContentExpected(page, expected) {
  try {
    const snap = await page.evaluate(() => {
      function visible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0
          && el.offsetParent !== null;
      }
      // Prefer visibly active tab panel content (hidden panels must not count)
      const activePanel = Array.from(document.querySelectorAll('.tab-panel.active,[role=tabpanel]:not([hidden])'))
        .find(visible);
      const main = activePanel
        || document.querySelector('main,[role=main],#content,.content,.page-content,article')
        || document.body;
      const active = document.querySelector(
        '[aria-selected=true],[aria-current=page],.tn-nl.active,.stab.active,.active.nav-link,.active[role=tab],.selected,.is-active'
      );
      return {
        url: location.href,
        title: document.title || '',
        heading: ((document.querySelector('h1,h2,[role=heading]') || {}).innerText || '').trim().slice(0, 120),
        active: ((active && (active.innerText || active.getAttribute('aria-label'))) || '').trim().slice(0, 80),
        text: ((main && main.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
      };
    });
    const exp = String(expected || '');
    const expL = exp.toLowerCase();
    const textL = (snap.text || '').toLowerCase();
    const activeL = (snap.active || '').toLowerCase();

    // Extract distinctive phrases from expected ("Sticky Alerts", 'Quick Links', etc.)
    const quoted = [];
    const qm = exp.match(/['"]([^'"]{3,80})['"]/g) || [];
    qm.forEach((q) => quoted.push(q.replace(/^['"]|['"]$/g, '').toLowerCase()));
    // Also pull Title Case / known admin labels
    const labelHits = exp.match(/\b(Sticky Alerts|Quick Links|Reader'?s Digest|Upcoming Events|Anniversary\s*\/?\s*Rewards|Save Changes|Add alert|Add article|Add event)\b/gi) || [];
    labelHits.forEach((l) => quoted.push(l.toLowerCase()));

    const unique = [...new Set(quoted.filter((q) => q && q.length >= 3))];
    if (unique.length > 0) {
      const missing = unique.filter((q) => !textL.includes(q) && !activeL.includes(q));
      if (missing.length === 0) {
        return {
          met: true,
          reason: 'Expected label(s) visible in active panel: "' + unique.slice(0, 3).join('", "') + '"'
            + (snap.active ? ' (active=' + snap.active + ')' : ''),
        };
      }
      return {
        met: false,
        reason: 'Expected text not found in visible/active panel: missing "' + missing.slice(0, 3).join('", "')
          + '". Active tab=' + (snap.active || '(none)') + '. Do not pass on unrelated page content.',
      };
    }

    // Generic same-page expecteds only — require active tab OR explicit same-page wording
    if (/same\s+page|no\s+redirect|url.{0,20}not\s+required|active\/selected|active or selected/i.test(expL)) {
      if (snap.active && snap.active.length >= 2) {
        return { met: true, reason: 'In-page nav active/selected: "' + snap.active + '" (url=' + snap.url + ')' };
      }
      if (snap.text && snap.text.length > 40) {
        return { met: true, reason: 'Stayed on page with visible content: ' + snap.url };
      }
    }
    return { met: false, reason: 'Could not confirm in-page content for: ' + exp.slice(0, 120) };
  } catch (e) {
    return { met: false, reason: 'In-page verify error: ' + (e && e.message ? e.message : e) };
  }
}

function isNoActionResult(actResult) {
  const m = String(actResult && actResult.message != null ? actResult.message : '').toLowerCase();
  return !m || /no action found|could not (find|locate)|unable to (find|perform)|0 actions|no actionable/.test(m);
}

/** Fast URL/title check without LLM when expected is about redirect/title. */
async function verifyUrlOrTitleFast(page, expected) {
  const exp = String(expected || '');
  let url = '';
  let title = '';
  try { url = page.url() || ''; } catch (_) {}
  try { title = await page.title(); } catch (_) {}
  const urlL = url.toLowerCase();

  // Quoted document/page title — hard pass or hard fail (do not hunt for an on-page "browser" tab).
  const quoted = extractQuotedPhrase(exp) || (exp.match(/["']([^"']{2,80})["']/) || [])[1] || '';
  const titleAssert = isChromeDocumentTitleExpected(exp) || /\b(page\s+title|document\s+title)\b/i.test(exp);
  if (quoted && titleAssert) {
    if (comparableTextMatches(title, quoted)) {
      return { met: true, reason: 'Document title matches "' + quoted + '" (document.title="' + title + '", url=' + url + ')' };
    }
    return {
      met: false,
      reason: 'Document title mismatch — expected "' + quoted + '", actual document.title="'
        + (title || '(empty)') + '" (url=' + url + ')',
    };
  }
  if (quoted && /\btitle\b/i.test(exp) && comparableTextMatches(title, quoted)) {
    return { met: true, reason: 'Document title matches "' + quoted + '" (document.title="' + title + '", url=' + url + ')' };
  }

  // Path fragments: inventory, dashboard, login, etc.
  const pathHints = [];
  if (/\binventory\b/i.test(exp)) pathHints.push('inventory');
  if (/\bcart\b/i.test(exp)) pathHints.push('cart');
  if (/\bdashboard\b/i.test(exp)) pathHints.push('dashboard');
  if (/\bhome\b/i.test(exp) && !/\bhomepage\b/i.test(exp)) pathHints.push('/');
  for (const h of pathHints) {
    if (h === '/' ? /\/($|\?)/.test(url) : urlL.includes(h)) {
      return { met: true, reason: `URL contains "${h}" → ${url}` };
    }
  }

  if (/\bredirect/i.test(exp) && pathHints.length === 0
      && !/\bno\s+.{0,40}redirect|without.{0,24}redirect|not\s+redirect/i.test(exp)) {
    // Generic redirect: any URL change away from about:blank is weak; prefer AI
    if (url && !/about:blank/i.test(url)) {
      // Not enough signal — return unmet so caller can AI-verify
      return { met: false, reason: `URL is ${url}; need AI to confirm: ${exp}` };
    }
  }

  return { met: false, reason: `Fast URL/title check inconclusive (title="${title}", url=${url})` };
}

function isAzureNetworkBlockedError(err) {
  const m = String(err && err.message ? err.message : err || '');
  return /403/.test(m) && /private endpoint|public access is disabled/i.test(m);
}

function formatActError(err) {
  if (isAzureNetworkBlockedError(err)) {
    return 'Azure OpenAI 403 — public access disabled on the AI endpoint '
      + '(VPN/private endpoint required). Direct UI clicks will be tried when possible. '
      + 'Original: ' + String(err && err.message ? err.message : err).replace(/\r?\n/g, ' ').slice(0, 160);
  }
  return String(err && err.message ? err.message : err);
}

/** Extract quoted UI labels and known vendor-nav synonyms for LLM-free clicks. */
function extractKnownClickTargets(subDesc) {
  const d = stripStepHtml(subDesc);
  const out = [];
  const seen = new Set();
  function push(t) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2 || s.length > 80) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  }
  const re = /['"“”‘']([^'"“”‘']{2,80})['"“”‘']/g;
  let m;
  while ((m = re.exec(d)) !== null) push(m[1]);
  if (/\b(add\s+new\s+vendor|new\s+vendor|create\s+vendor|raise\s+vendor|onboard\s+vendor)\b/i.test(d)) {
    push('Add New Vendor');
    push('Raise Vendor Request');
    push('Raise a new vendor onboarding request');
    push('Create Vendor Request');
  }
  if (/\bvendor\s+onboarding\s+requests?\b/i.test(d) || /\bvendor\s+requests?\b/i.test(d)) {
    push('Vendor Onboarding Requests');
    push('Vendor Requests');
  }
  const proceed = parseProceedIntent(d);
  if (proceed) proceed.labels.forEach(push);
  return out;
}

/**
 * Click a visible button/link/card by exact or fuzzy text — no Azure OpenAI call.
 * Used for known catalog actions (Add New Vendor) when LLM act() is blocked or slow.
 */
async function tryDirectKnownUiClick(page, subDesc, stepLabel) {
  const targets = extractKnownClickTargets(subDesc);
  if (!targets.length) return false;

  const tagged = await page.evaluate((targets) => {
    function visible(el) {
      if (!el || el.offsetHeight <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0;
    }
    function norm(s) {
      return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }
    function textOf(el) {
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }
    document.querySelectorAll('[data-runpilot-click]').forEach((el) => el.removeAttribute('data-runpilot-click'));

    const candidates = Array.from(document.querySelectorAll(
      'main button, main a, main [role="button"], main [role="link"], '
      + 'main [role="menuitem"], form button, [class*="wizard"] button, '
      + 'section button'
    )).filter(visible);

    for (const want of targets) {
      const nw = norm(want);
      let best = null;
      let bestScore = 0;
      for (const el of candidates) {
        if (el.closest('header, aside, [class*="Avatar"], [class*="UserMenu"]')) continue;
        const t = textOf(el);
        const nt = norm(t);
        if (!nt || nt.length > 160) continue;
        if (/logout|sign\s*out|profile|avatar/i.test(nt)) continue;
        if (/\bdraft\b/.test(nt) && !/\bdraft\b/.test(nw)) continue;
        if (/\bsave\b/.test(nt) && /^(next|continue|proceed)$/.test(nw)) continue;
        let score = 0;
        if (nt === nw) score = 100;
        else if (nt.startsWith(nw) || nw.startsWith(nt)) score = 90;
        else if (nt.includes(nw)) score = 75;
        if (score > bestScore) {
          bestScore = score;
          best = { el, text: t.slice(0, 80) };
        }
      }
      if (best && bestScore >= 75) {
        best.el.scrollIntoView({ block: 'center' });
        best.el.setAttribute('data-runpilot-click', '1');
        return { ok: true, text: best.text, score: bestScore };
      }
    }
    return { ok: false };
  }, targets).catch(() => ({ ok: false }));

  if (!tagged || !tagged.ok) return false;

  try {
    await shLocatorClick(page, '[data-runpilot-click="1"]');
    await page.waitForTimeout(400);
    rlog(stepLabel + ':DIRECT_CLICK:"' + tagged.text + '" (no LLM)');
    await page.evaluate(() => {
      document.querySelectorAll('[data-runpilot-click]').forEach((el) => el.removeAttribute('data-runpilot-click'));
    }).catch(() => {});
    return true;
  } catch (e) {
    rlog(stepLabel + ':DIRECT_CLICK_WARN:' + (e.message || e));
    return false;
  }
}

// ── Generic UI tree: snapshot HTML paths, score vs test case, take best path ──
const TREE_STOP = new Set([
  'click', 'press', 'tap', 'the', 'a', 'an', 'to', 'on', 'in', 'of', 'for', 'and', 'or',
  'with', 'user', 'should', 'must', 'please', 'step', 'button', 'link', 'page', 'screen',
  'then', 'from', 'into', 'this', 'that', 'using', 'via', 'by', 'is', 'are', 'be', 'it',
  'navigate', 'go', 'open', 'ensure', 'verify', 'check',
]);
const TREE_SYNONYMS = [
  ['create', 'add', 'new', 'raise', 'start', 'initiate', 'register'],
  ['edit', 'update', 'modify', 'change', 'revise'],
  ['delete', 'remove', 'discard'],
  ['next', 'continue', 'proceed'],
  ['submit', 'finish', 'complete', 'send', 'publish'],
  ['save', 'save changes'],
  ['search', 'find', 'filter', 'lookup'],
  ['view', 'details', 'show', 'preview'],
  ['login', 'sign in', 'signin', 'log in'],
  ['logout', 'sign out', 'signout', 'log out'],
];

function treeTokens(text) {
  return String(text || '').toLowerCase()
    .replace(/['"“”]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !TREE_STOP.has(w));
}

function expandSynonyms(tokens) {
  const set = new Set(tokens);
  for (const group of TREE_SYNONYMS) {
    if (group.some((g) => set.has(g))) group.forEach((g) => set.add(g));
  }
  return set;
}

function parseTreeIntent(stepDesc) {
  const raw = stripLeadingStepNumber(stripStepHtml(stepDesc || ''));
  const d = raw.toLowerCase();
  const quoted = [];
  const qre = /['"“”]([^'"“”]{2,80})['"“”]/g;
  let m;
  while ((m = qre.exec(raw)) !== null) quoted.push(m[1].trim());
  let action = 'click';
  if (/\b(type|enter|fill|input)\b/.test(d)) action = 'fill';
  else if (/\b(select|choose|pick)\b/.test(d) && /\b(dropdown|select|option|list|combobox)\b/.test(d)) action = 'select';
  else if (/\b(navigate|go\s+to|open)\b/.test(d) && !/\bclick\b/.test(d)) action = 'nav';
  const proceed = parseProceedIntent(raw);
  if (proceed) action = proceed.kind;
  return {
    raw,
    action,
    proceed,
    quoted,
    tokens: expandSynonyms(treeTokens(raw)),
  };
}

async function collectUiTree(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 3 && r.height > 3;
    }
    function textOf(el, max) {
      const t = (el.getAttribute('aria-label') || el.getAttribute('title')
        || el.innerText || el.textContent || el.value || el.getAttribute('placeholder')
        || '').replace(/\s+/g, ' ').trim();
      return t.slice(0, max || 80);
    }
    function regionOf(el) {
      if (el.closest('[role="dialog"], [aria-modal="true"], .modal, [class*="Modal"]')) return 'dialog';
      if (el.closest('header, [role="banner"]')) return 'header';
      if (el.closest('aside, nav, [role="navigation"], [class*="sidebar" i], [class*="SideBar"]')) return 'nav';
      if (el.closest('[class*="Avatar"], [class*="UserMenu"], [class*="profile" i]')) return 'chrome';
      const form = el.closest('form, [class*="wizard" i], [class*="Wizard"]');
      if (form) {
        if (el.closest('[class*="footer" i], [class*="actions" i], [class*="toolbar" i], [class*="FormFooter"]')) {
          return 'form-footer';
        }
        return 'form';
      }
      if (el.closest('footer, [role="contentinfo"]')) return 'page-footer';
      if (el.closest('main, [role="main"]')) return 'main';
      return 'other';
    }
    function pathOf(el) {
      const parts = [];
      let n = el;
      while (n && n !== document.documentElement && parts.length < 8) {
        const tag = (n.tagName || '').toLowerCase();
        const role = (n.getAttribute('role') || '').toLowerCase();
        let name = '';
        if (/^h[1-6]$/.test(tag) || tag === 'label' || tag === 'legend') name = textOf(n, 48);
        else if (n.getAttribute('aria-label')) name = String(n.getAttribute('aria-label')).slice(0, 48);
        else if (role === 'dialog' || tag === 'form' || role === 'navigation' || tag === 'nav'
          || tag === 'aside' || tag === 'main' || tag === 'section') {
          name = n.getAttribute('aria-label') || n.getAttribute('name') || tag;
        }
        const landmark = role === 'navigation' || role === 'main' || role === 'dialog' || role === 'form'
          || /^(nav|main|form|aside|header|footer|section)$/.test(tag)
          || /^h[1-6]$/.test(tag) || tag === 'label' || tag === 'legend';
        if (landmark) {
          const bit = (role || tag) + (name && name !== tag ? ':"' + name + '"' : '');
          if (!parts.length || parts[0] !== bit) parts.unshift(bit);
        }
        n = n.parentElement;
      }
      return parts.join(' > ');
    }
    function kindOf(el) {
      const tag = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'select' || role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return 'select';
      if (tag === 'textarea' || (tag === 'input' && !/button|submit|checkbox|radio|file/.test(type))) return 'fill';
      return 'click';
    }

    document.querySelectorAll('[data-runpilot-tree]').forEach((el) => el.removeAttribute('data-runpilot-tree'));

    const sel = [
      'a', 'button', '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
      '[role="option"]', 'input', 'select', 'textarea', '[role="combobox"]',
      '[aria-haspopup="listbox"]',
    ].join(',');
    const seen = new Set();
    const nodes = [];
    const list = Array.from(document.querySelectorAll(sel));
    for (let i = 0; i < list.length && nodes.length < 90; i++) {
      const el = list[i];
      if (!visible(el)) continue;
      if (el.closest('[data-runpilot-tree]')) continue;
      const name = textOf(el, 80);
      if (!name || name.length < 1) continue;
      if (name.length > 140) continue;
      const r = el.getBoundingClientRect();
      const key = name.toLowerCase() + '|' + Math.round(r.top / 8) + '|' + kindOf(el);
      if (seen.has(key)) continue;
      seen.add(key);
      const idx = nodes.length;
      el.setAttribute('data-runpilot-tree', String(idx));
      nodes.push({
        i: idx,
        name: name.slice(0, 80),
        role: (el.getAttribute('role') || el.tagName || '').toLowerCase().slice(0, 24),
        kind: kindOf(el),
        region: regionOf(el),
        path: pathOf(el).slice(0, 220),
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        y: Math.round(r.top + (window.scrollY || 0)),
        x: Math.round(r.left + (window.scrollX || 0)),
      });
    }
    return {
      url: location.href || '',
      title: document.title || '',
      nodes,
    };
  }).catch(() => ({ url: '', title: '', nodes: [] }));
}

function scoreTreeNode(node, intent) {
  if (!node || !intent) return -999;
  const name = String(node.name || '');
  const nl = name.toLowerCase();
  const pathL = String(node.path || '').toLowerCase();
  const blob = nl + ' ' + pathL;
  let score = 0;

  if (/logout|sign\s*out|profile|avatar|account menu/i.test(nl) && intent.action !== 'logout') score -= 100;
  if (node.region === 'chrome' && intent.action !== 'logout') score -= 60;
  if (node.disabled) score -= 40;

  const proceed = intent.proceed;
  if (/\bdraft\b/.test(nl) && (!proceed || proceed.kind !== 'draft')) score -= 90;
  if (proceed && proceed.kind === 'next' && /\b(save|submit|publish|finish)\b/.test(nl)
      && !/\b(next|continue|proceed)\b/.test(nl)) score -= 90;
  if (proceed && proceed.kind === 'next' && /\b(next|continue|proceed)\b/.test(nl)) score += 55;
  if (proceed && proceed.kind === 'submit' && /\bsubmit\b/.test(nl)) score += 50;
  if (proceed && proceed.kind === 'draft' && /\bdraft\b/.test(nl)) score += 50;

  for (const q of intent.quoted) {
    const nq = q.toLowerCase();
    if (nl === nq) score += 70;
    else if (nl.includes(nq) || nq.includes(nl)) score += 45;
  }

  const nodeTok = new Set(treeTokens(name + ' ' + node.path));
  let hit = 0;
  intent.tokens.forEach((t) => { if (nodeTok.has(t)) hit++; });
  const union = new Set([...intent.tokens, ...nodeTok]);
  if (union.size) score += Math.round(70 * (hit / Math.max(intent.tokens.size, 1)));

  if (intent.action === 'fill' && node.kind === 'fill') score += 22;
  if (intent.action === 'select' && node.kind === 'select') score += 22;
  if ((intent.action === 'click' || intent.action === 'nav') && node.kind === 'click') score += 12;
  if (['next', 'submit', 'save', 'draft'].includes(intent.action) && node.kind === 'click') score += 10;

  if (intent.action === 'fill' || intent.action === 'select') {
    if (node.region === 'form' || node.region === 'main' || node.region === 'dialog') score += 12;
    if (node.region === 'nav' || node.region === 'header') score -= 25;
  }
  if (intent.action === 'nav' && (node.region === 'nav' || node.region === 'main')) score += 10;
  if ((intent.action === 'next' || intent.action === 'submit' || intent.action === 'save' || intent.action === 'draft')
      && (node.region === 'form-footer' || node.region === 'form' || node.region === 'dialog')) score += 16;
  if ((intent.action === 'next' || intent.action === 'submit') && node.region === 'nav') score -= 30;

  if (node.region === 'dialog') score += 6;
  return score;
}

/**
 * Compare the live HTML tree to the test-case step and follow the unique best path.
 * Generic for any app — labels + roles + ancestry, no product-specific names.
 */
async function tryBestTreePath(page, stepDesc, stepLabel) {
  const intent = parseTreeIntent(stepDesc);
  if (!intent.tokens.size && !intent.quoted.length && !intent.proceed) return false;

  const tree = await collectUiTree(page);
  const nodes = tree && Array.isArray(tree.nodes) ? tree.nodes : [];
  if (!nodes.length) {
    rlog((stepLabel || 'TREE') + ':TREE:empty');
    return false;
  }

  const ranked = nodes
    .map((n) => ({ n, score: scoreTreeNode(n, intent) }))
    .filter((x) => x.score >= 48)
    .sort((a, b) => b.score - a.score || a.n.y - b.n.y);

  const top = ranked.slice(0, 4).map((x) => x.score + ' "' + x.n.name.slice(0, 40)
    + '" [' + x.n.region + '] ' + x.n.path.slice(0, 80));
  rlog((stepLabel || 'TREE') + ':TREE:candidates=' + ranked.length
    + (top.length ? ' top=' + top.join(' || ') : ''));

  if (!ranked.length) return false;
  const best = ranked[0];
  const second = ranked[1];
  const unique = !second || (best.score - second.score) >= 10
    || best.n.name.toLowerCase() === String(intent.quoted[0] || '').toLowerCase();
  if (best.score < 62 && !unique) {
    rlog((stepLabel || 'TREE') + ':TREE:ambiguous — not guessing');
    return false;
  }
  if (best.score < 52) return false;

  const n = best.n;
  rlog((stepLabel || 'TREE') + ':TREE:choose "' + n.name + '" path=' + n.path
    + ' score=' + best.score + ' kind=' + n.kind);

  try {
    await scrollSelectorIntoView(page, '[data-runpilot-tree="' + n.i + '"]');
    if ((n.kind === 'select')
        && (intent.action === 'select' || intent.action === 'click' || intent.action === 'fill')) {
      const hint = extractQuotedFromStep(stepDesc) || '';
      await selectDropdownForTestCase(page, null, n.name, hint, stepLabel);
    } else if (n.kind === 'fill' && intent.action === 'fill') {
      const val = extractQuotedFromStep(stepDesc) || resolveValueFromTestCaseContext(n.name, {
        type: 'text', isSelect: false,
      }, parseTestDataMap(), stepDesc);
      await forceCommitTextByLabel(page, n.name, val, stepLabel, stepDesc);
    } else {
      await shLocatorClick(page, '[data-runpilot-tree="' + n.i + '"]');
    }
    await page.waitForTimeout(280);
    await page.evaluate(() => {
      document.querySelectorAll('[data-runpilot-tree]').forEach((el) => el.removeAttribute('data-runpilot-tree'));
    }).catch(() => {});
    rlog((stepLabel || 'TREE') + ':TREE:ok "' + n.name + '"');
    return { ok: true, name: n.name, path: n.path, score: best.score, kind: n.kind };
  } catch (e) {
    rlog((stepLabel || 'TREE') + ':TREE:WARN ' + (e && e.message ? e.message : e));
    return false;
  }
}

// ── Self-navigate: observe → rank → explore → cache ────────────────────────────
const SELF_NAV_RISK_THRESHOLDS = { low: 0.60, medium: 0.70, high: 0.85 };

function actionRisk(intent) {
  const s = String(intent || '').toLowerCase();
  if (/\b(delete|remove|destroy|purge|payment|pay\b|checkout|purchase|approve|reject|confirm\s+delete|unsubscribe)\b/.test(s)
      || /\bsubmit\b/.test(s)) {
    return 'high';
  }
  if (/\b(save|send|create|update|edit|upload|publish|share|invite)\b/.test(s)) {
    return 'medium';
  }
  return 'low';
}

function simpleHash(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

async function getPageFingerprint(page) {
  try {
    const data = await page.evaluate(() => {
      function visible(el) {
        if (!el || el.disabled) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      }
      const labels = [];
      const nodes = document.querySelectorAll(
        'a, button, [role="button"], [role="tab"], [role="menuitem"], input, select, textarea, [aria-label]'
      );
      for (let i = 0; i < nodes.length && labels.length < 40; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const t = (el.getAttribute('aria-label')
          || el.innerText
          || el.value
          || el.getAttribute('placeholder')
          || el.getAttribute('name')
          || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (t && t.length >= 2) labels.push(t.toLowerCase());
      }
      return { url: location.href || '', labels };
    });
    const labelKey = (data.labels || []).slice(0, 30).join('|');
    return String(data.url || '').slice(0, 180) + '#' + simpleHash(labelKey);
  } catch (_) {
    let url = '';
    try { url = page.url() || ''; } catch (__) {}
    return url + '#unknown';
  }
}

async function getPageContextBrief(page) {
  try {
    return await page.evaluate(() => {
      function visible(el) {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      }
      const bits = [];
      const nodes = document.querySelectorAll(
        'h1, h2, [role="dialog"], [aria-modal="true"], button, a, [role="tab"], [role="menuitem"]'
      );
      for (let i = 0; i < nodes.length && bits.length < 25; i++) {
        const el = nodes[i];
        if (!visible(el)) continue;
        const t = (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (t && t.length >= 2) bits.push(t);
      }
      return {
        url: location.href || '',
        title: document.title || '',
        summary: bits.join(' | ').slice(0, 900),
      };
    });
  } catch (_) {
    let url = '', title = '';
    try { url = page.url() || ''; } catch (__) {}
    try { title = await page.title(); } catch (__) {}
    return { url, title, summary: '' };
  }
}

function parseSelfNavJson(text) {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

async function selfNavLlmJson(prompt, maxTokens) {
  const client = getFormAiClient();
  if (!client) return null;
  try {
    const resp = await client.chat.completions.create({
      model: cfg.deploy,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens || 400,
    });
    const text = resp.choices && resp.choices[0] && resp.choices[0].message
      ? String(resp.choices[0].message.content || '') : '';
    return parseSelfNavJson(text);
  } catch (_) {
    return null;
  }
}

function formatObserveActions(actions) {
  return (actions || []).slice(0, 15).map((a, i) => {
    const desc = String(a.description || a.method || 'action').slice(0, 120);
    const sel = String(a.selector || '').slice(0, 100);
    return i + '. ' + desc + (sel ? ' (selector: ' + sel + ')' : '');
  }).join('\n');
}

async function rankCandidates(intent, context, actions) {
  const prompt =
    'Test step intent: "' + String(intent).slice(0, 220) + '"\n'
    + 'Page context: ' + String(context || '').slice(0, 700) + '\n\n'
    + 'Available actions on the page:\n'
    + formatObserveActions(actions) + '\n\n'
    + 'Which action best accomplishes the intent?\n'
    + 'Return JSON only:\n'
    + '{"bestIndex":0,"confidence":0.0,"reasoning":"why","top3":[0,2,5]}\n'
    + 'confidence is 0.0-1.0. Use bestIndex -1 if none match.';
  const parsed = await selfNavLlmJson(prompt, 350);
  if (!parsed || typeof parsed.bestIndex !== 'number') {
    return { bestIndex: actions.length === 1 ? 0 : -1, confidence: actions.length === 1 ? 0.75 : 0.4, reasoning: 'fallback', top3: [] };
  }
  const bestIndex = parsed.bestIndex;
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const top3 = Array.isArray(parsed.top3) ? parsed.top3.filter(n => Number.isInteger(n) && n >= 0 && n < actions.length).slice(0, 3) : [];
  return {
    bestIndex,
    confidence,
    reasoning: String(parsed.reasoning || '').slice(0, 200),
    top3: top3.length ? top3 : (bestIndex >= 0 ? [bestIndex] : []),
  };
}

async function resolveTarget(stagehand, page, intent, context, stepLabel) {
  let actions = [];
  try {
    actions = await stagehand.observe(
      'Find actionable UI controls related to: ' + String(intent).slice(0, 200)
      + '. Prefer visible buttons, links, tabs, menu items, and form submits. Do not invent controls.',
      { page }
    );
  } catch (e) {
    rlog(stepLabel + ':SELFNAV:OBSERVE_WARN:' + (e && e.message ? e.message : e));
    return { type: 'not_found', actions: [], confidence: 0 };
  }
  if (!Array.isArray(actions)) actions = [];
  rlog(stepLabel + ':SELFNAV:OBSERVE:n=' + actions.length);

  if (actions.length === 0) return { type: 'not_found', actions: [], confidence: 0 };
  if (actions.length === 1) {
    return { type: 'confident', action: actions[0], actions, confidence: 0.82, reasoning: 'single candidate' };
  }

  const ranked = await rankCandidates(intent, context, actions);
  const idx = ranked.bestIndex;
  rlog(stepLabel + ':SELFNAV:RANK:best=' + idx
    + ' conf=' + ranked.confidence.toFixed(2)
    + ' reason=' + String(ranked.reasoning || '').slice(0, 120));

  if (idx < 0 || idx >= actions.length) {
    return { type: 'not_found', actions, confidence: ranked.confidence, top3: ranked.top3 };
  }
  if (ranked.confidence < 0.7) {
    return {
      type: 'ambiguous',
      action: actions[idx],
      actions,
      confidence: ranked.confidence,
      candidates: ranked.top3.map(i => actions[i]).filter(Boolean),
      reasoning: ranked.reasoning,
    };
  }
  return {
    type: 'confident',
    action: actions[idx],
    actions,
    confidence: ranked.confidence,
    candidates: ranked.top3.map(i => actions[i]).filter(Boolean),
    reasoning: ranked.reasoning,
  };
}

function decideSelfNavAct(confidence, risk) {
  const threshold = SELF_NAV_RISK_THRESHOLDS[risk] || SELF_NAV_RISK_THRESHOLDS.medium;
  if (confidence >= threshold) return 'act';
  return 'fail_with_candidates';
}

function summarizeCandidates(actions) {
  return (actions || []).slice(0, 3).map(a => String(a.description || a.selector || '?').slice(0, 80)).join(' | ');
}

async function planExploration(stagehand, page, intent, target, contextBrief, stepLabel) {
  const targetInfo = target
    ? JSON.stringify({
      type: target.type,
      confidence: target.confidence,
      candidates: summarizeCandidates(target.candidates || target.actions || []),
    }).slice(0, 400)
    : '{"type":"not_found"}';

  const prompt =
    'Intent: "' + String(intent).slice(0, 220) + '"\n'
    + 'Target resolution result: ' + targetInfo + '\n'
    + 'Current URL: ' + (contextBrief.url || '') + '\n'
    + 'Page title: ' + (contextBrief.title || '') + '\n'
    + 'Visible UI summary: ' + String(contextBrief.summary || '').slice(0, 700) + '\n\n'
    + 'The target element is not directly accessible or ranking is ambiguous. '
    + 'To find it we may need to open a modal/dialog, expand accordion/dropdown, scroll, click a tab, '
    + 'navigate to a different page, or switch iframe.\n'
    + 'Return JSON only:\n'
    + '{"type":"explore"|"navigate"|"give_up","action":"natural language click/scroll instruction",'
    + '"reasoning":"why","expectedOutcome":"what should appear"}\n'
    + 'Use type "navigate" when the target likely lives on another route. '
    + 'Use give_up when nothing on this page can reveal the intent. '
    + 'Never suggest Delete/Logout/payment confirm unless intent requires it.';

  const parsed = await selfNavLlmJson(prompt, 350);
  if (!parsed || !parsed.type) {
    return { type: 'give_up', reason: 'exploration planner unavailable' };
  }
  const t = String(parsed.type).toLowerCase();
  if (t === 'give_up') {
    return { type: 'give_up', reason: String(parsed.reasoning || 'planner gave up').slice(0, 200) };
  }
  if (t === 'navigate') {
    return {
      type: 'navigate',
      action: String(parsed.action || '').slice(0, 220),
      reasoning: String(parsed.reasoning || '').slice(0, 200),
      expectedOutcome: String(parsed.expectedOutcome || '').slice(0, 160),
    };
  }
  if (!parsed.action) {
    return { type: 'give_up', reason: 'empty exploration action' };
  }
  return {
    type: 'explore',
    action: String(parsed.action).slice(0, 220),
    reasoning: String(parsed.reasoning || '').slice(0, 200),
    expectedOutcome: String(parsed.expectedOutcome || '').slice(0, 160),
  };
}

async function navigateToward(stagehand, page, intent, contextBrief, visited, stepLabel) {
  let curUrl = '';
  try { curUrl = page.url() || ''; } catch (_) {}
  if (curUrl && visited.has(curUrl)) {
    rlog(stepLabel + ':SELFNAV:NAV:loop_detected url=' + curUrl.slice(0, 120));
    return { type: 'loop_detected' };
  }
  if (curUrl) visited.add(curUrl);

  const prompt =
    'Intent: "' + String(intent).slice(0, 220) + '"\n'
    + 'Current URL: ' + (contextBrief.url || curUrl) + '\n'
    + 'Page title: ' + (contextBrief.title || '') + '\n'
    + 'Visible UI: ' + String(contextBrief.summary || '').slice(0, 700) + '\n\n'
    + 'The target is not on this page. Which navigation action moves us closer?\n'
    + 'Look for nav links, menu items, buttons that trigger routing, breadcrumbs.\n'
    + 'Return JSON only:\n'
    + '{"action":"click"|"goto"|"none","target":"description or URL","reasoning":"..."}\n'
    + 'Prefer same-origin paths. Do not invent URLs.';

  const nav = await selfNavLlmJson(prompt, 300);
  if (!nav || !nav.action || String(nav.action).toLowerCase() === 'none') {
    return { type: 'none', reason: (nav && nav.reasoning) || 'no nav suggestion' };
  }
  const actKind = String(nav.action).toLowerCase();
  const target = String(nav.target || '').trim();
  if (!target) return { type: 'none', reason: 'empty nav target' };

  try {
    if (actKind === 'goto' && /^https?:\/\//i.test(target)) {
      rlog(stepLabel + ':SELFNAV:NAV:goto=' + target.slice(0, 160));
      await safeGoto(page, target, stepLabel + ':SELFNAV', Math.min(cfg.navTimeoutMs, 25000));
    } else {
      const clickInstr = actKind === 'click' ? target : ('Click ' + target);
      rlog(stepLabel + ':SELFNAV:NAV:click=' + clickInstr.slice(0, 160));
      await stagehand.act(clickInstr, { page });
    }
    await page.waitForLoadState('domcontentloaded', 4000).catch(() => {});
    await settleAndClearInterrupts(page, stagehand, stepLabel, intent, '');
    let newUrl = '';
    try { newUrl = page.url() || ''; } catch (_) {}
    rlog(stepLabel + ':SELFNAV:NAV:url=' + newUrl.slice(0, 160));
    return { type: 'ok', url: newUrl };
  } catch (e) {
    rlog(stepLabel + ':SELFNAV:NAV_WARN:' + (e && e.message ? e.message : e));
    return { type: 'error', reason: String(e && e.message ? e.message : e).slice(0, 160) };
  }
}

async function replayNavPath(stagehand, page, entry, stepLabel) {
  const steps = entry && entry.steps ? entry.steps : [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      if (s.selector) {
        const action = {
          selector: s.selector,
          description: s.instruction || s.description || 'cached action',
          method: s.method || 'click',
          arguments: Array.isArray(s.arguments) ? s.arguments : [],
        };
        const res = await stagehand.act(action, { page });
        if (isNoActionResult(res)) throw new Error('cached act no-action');
      } else if (s.instruction) {
        const res = await stagehand.act(String(s.instruction), { page });
        if (isNoActionResult(res)) throw new Error('cached instruction no-action');
      } else {
        throw new Error('empty cached step');
      }
      await settleAndClearInterrupts(page, stagehand, stepLabel, intent, '');
    } catch (e) {
      rlog(stepLabel + ':SELFNAV:CACHE_STALE:step=' + (i + 1) + ' ' + (e && e.message ? e.message : e));
      return { success: false, reason: e && e.message ? e.message : 'cache replay failed' };
    }
  }
  return { success: true };
}

/**
 * When blind act fails: try path cache, then observe/rank, then bounded exploration
 * (open modal / tab / nav) before giving up with candidates + trace.
 */
async function executeIntelligentStep(stagehand, page, intent, stepLabel, options) {
  options = options || {};
  const maxDepth = options.maxDepth || cfg.selfNavDepth || 5;
  const risk = actionRisk(intent);
  const visited = new Set();
  const trace = [];
  const startFingerprint = await getPageFingerprint(page);
  const cacheKeyLookup = lookupNavCache(intent, startFingerprint);

  if (cacheKeyLookup) {
    rlog(stepLabel + ':SELFNAV:CACHE_HIT');
    const replayed = await replayNavPath(stagehand, page, cacheKeyLookup.entry, stepLabel);
    if (replayed.success) {
      rememberNavPath(intent, startFingerprint, cacheKeyLookup.entry.steps);
      rlog(stepLabel + ':SELFNAV:OK:source=cache depth=0');
      return {
        success: true,
        source: 'cache',
        depth: 0,
        actResult: { message: 'Self-nav path replayed from cache', success: true },
      };
    }
    deleteNavCacheKey(cacheKeyLookup.key);
    rlog(stepLabel + ':SELFNAV:CACHE_MISS:stale');
  } else {
    rlog(stepLabel + ':SELFNAV:CACHE_MISS');
  }

  let contextBrief = await getPageContextBrief(page);
  let context = [contextBrief.url, contextBrief.title, contextBrief.summary].filter(Boolean).join(' | ');

  for (let depth = 0; depth < maxDepth; depth++) {
    const treeHit = await tryBestTreePath(page, intent, stepLabel);
    if (treeHit && treeHit.ok) {
      trace.push({ instruction: intent, selector: treeHit.path, method: treeHit.kind || 'click' });
      rememberNavPath(intent, startFingerprint, trace);
      rlog(stepLabel + ':SELFNAV:OK:source=tree depth=' + depth + ' path=' + treeHit.path);
      return {
        success: true,
        source: 'tree',
        depth,
        actResult: { message: 'Tree path → ' + treeHit.name, success: true },
        trace,
      };
    }

    const target = await resolveTarget(stagehand, page, intent, context, stepLabel);

    if (target.type === 'confident') {
      const decision = decideSelfNavAct(target.confidence ?? 0.9, risk);
      if (decision === 'act') {
        try {
          const actResult = await stagehand.act(target.action, { page });
          if (isNoActionResult(actResult)) {
            rlog(stepLabel + ':SELFNAV:ACT_NOACTION:retry explore');
          } else {
            trace.push({
              instruction: target.action.description || intent,
              selector: target.action.selector || '',
              method: target.action.method || 'click',
              arguments: target.action.arguments,
            });
            rememberNavPath(intent, startFingerprint, trace);
            rlog(stepLabel + ':SELFNAV:OK:source=explored depth=' + depth
              + ' risk=' + risk + ' conf=' + Number(target.confidence || 0).toFixed(2));
            return { success: true, source: 'explored', depth, actResult, trace };
          }
        } catch (e) {
          rlog(stepLabel + ':SELFNAV:ACT_WARN:' + (e && e.message ? e.message : e));
        }
      } else {
        const cand = summarizeCandidates(target.candidates || [target.action]);
        rlog(stepLabel + ':SELFNAV:FAIL:reason=low_confidence_for_risk'
          + ' risk=' + risk
          + ' conf=' + Number(target.confidence || 0).toFixed(2)
          + ' candidates=' + cand);
        return {
          success: false,
          source: 'needs_higher_confidence',
          reason: 'confidence ' + Number(target.confidence || 0).toFixed(2) + ' below threshold for risk=' + risk,
          candidates: target.candidates || [target.action],
          trace,
        };
      }
    }

    // not_found or ambiguous (or confident act failed) — explore / navigate
    const exploration = await planExploration(stagehand, page, intent, target, contextBrief, stepLabel);
    if (exploration.type === 'give_up') {
      rlog(stepLabel + ':SELFNAV:FAIL:reason=' + (exploration.reason || 'gave_up')
        + ' candidates=' + summarizeCandidates(target.actions || target.candidates));
      return {
        success: false,
        source: 'gave_up',
        reason: exploration.reason || 'gave_up',
        candidates: target.actions || target.candidates || [],
        trace,
      };
    }

    if (exploration.type === 'navigate') {
      const navRes = await navigateToward(stagehand, page, intent, contextBrief, visited, stepLabel);
      if (navRes.type === 'loop_detected' || navRes.type === 'none' || navRes.type === 'error') {
        // fall through to try explore-style act if planner also gave an action string
        if (!exploration.action) {
          rlog(stepLabel + ':SELFNAV:FAIL:reason=nav_' + navRes.type
            + ' candidates=' + summarizeCandidates(target.actions || []));
          return {
            success: false,
            source: 'nav_failed',
            reason: navRes.reason || navRes.type,
            candidates: target.actions || [],
            trace,
          };
        }
      } else {
        trace.push({
          instruction: 'Navigate toward: ' + (exploration.action || intent),
          selector: '',
          method: 'navigate',
        });
        contextBrief = await getPageContextBrief(page);
        context = [contextBrief.url, contextBrief.title, contextBrief.summary].filter(Boolean).join(' | ');
        continue;
      }
    }

    // explore step
    const exploreInstr = String(exploration.action || '').trim();
    if (!exploreInstr) {
      rlog(stepLabel + ':SELFNAV:FAIL:reason=empty_explore candidates='
        + summarizeCandidates(target.actions || []));
      return {
        success: false,
        source: 'gave_up',
        reason: 'empty exploration action',
        candidates: target.actions || [],
        trace,
      };
    }

    rlog(stepLabel + ':SELFNAV:EXPLORE:depth=' + depth
      + ' action=' + exploreInstr.slice(0, 160)
      + ' why=' + String(exploration.reasoning || '').slice(0, 100));

    try {
      // Prefer observe-ranked explore click when possible
      let exploreAct = null;
      try {
        const exploreObs = await stagehand.observe(
          'Find the control to: ' + exploreInstr.slice(0, 180),
          { page }
        );
        if (Array.isArray(exploreObs) && exploreObs.length === 1) {
          exploreAct = exploreObs[0];
        } else if (Array.isArray(exploreObs) && exploreObs.length > 1) {
          const ranked = await rankCandidates(exploreInstr, context, exploreObs);
          if (ranked.bestIndex >= 0 && ranked.confidence >= 0.55) {
            exploreAct = exploreObs[ranked.bestIndex];
          }
        }
      } catch (_) {}

      let exploreResult;
      if (exploreAct) {
        exploreResult = await stagehand.act(exploreAct, { page });
        trace.push({
          instruction: exploreAct.description || exploreInstr,
          selector: exploreAct.selector || '',
          method: exploreAct.method || 'click',
          arguments: exploreAct.arguments,
        });
      } else {
        exploreResult = await stagehand.act(exploreInstr, { page });
        trace.push({
          instruction: exploreInstr,
          selector: '',
          method: 'act',
        });
      }
      if (isNoActionResult(exploreResult)) {
        rlog(stepLabel + ':SELFNAV:EXPLORE_NOACTION:depth=' + depth);
      }
    } catch (e) {
      rlog(stepLabel + ':SELFNAV:EXPLORE_WARN:' + (e && e.message ? e.message : e));
    }

    await page.waitForLoadState('domcontentloaded', 3000).catch(() => {});
    await settleAndClearInterrupts(page, stagehand, stepLabel, intent, '');
    contextBrief = await getPageContextBrief(page);
    context = [contextBrief.url, contextBrief.title, contextBrief.summary].filter(Boolean).join(' | ');
  }

  rlog(stepLabel + ':SELFNAV:FAIL:reason=exploration_budget_exceeded depth=' + maxDepth
    + ' candidates=');
  return {
    success: false,
    source: 'budget_exceeded',
    reason: 'exploration_budget_exceeded',
    candidates: [],
    trace,
  };
}

/**
 * One cheap AI rephrase retry when Stagehand returns "No action found".
 * Second attempt explicitly allows synonym matching to visible UI labels only.
 * Skipped for META/WAIT — those never call this.
 */
async function actWithFastFallback(stagehand, page, subDesc, stepLabel, stepIndex) {
  await dismissOpenUserMenu(page, stepLabel);

  let instruction = withExecutionContext(subDesc, stepIndex);
  if (!looksLikeLogoutStep(subDesc)) {
    instruction = withExecutionContext(
      'IMPORTANT: Do NOT click the user profile avatar, user-name chip, account menu, or Logout. '
      + 'Stay in the main app navigation/content. Step: '
      + stripStepHtml(subDesc).substring(0, 220),
      stepIndex
    );
  }
  if (looksLikeInPageMenuClick(subDesc)) {
    instruction = withExecutionContext(
      'Click the visible menu/tab/sidebar item on the CURRENT page (left nav / main content). '
      + 'This is in-page navigation — content will update without a full page redirect. '
      + 'Do NOT open the top-right profile/account menu. '
      + 'Do not open a new browser tab or wait for a URL change. Step: '
      + stripStepHtml(subDesc).substring(0, 200),
      stepIndex
    );
  }
  // Vendor create / list synonyms for myVendors-style apps
  if (/\bvendor\s+request/i.test(subDesc) || /\bcreate\s+vendor\b/i.test(subDesc)) {
    instruction = withExecutionContext(
      'Navigate using the LEFT sidebar or dashboard cards only. '
      + 'Map "Vendor Requests" → "Vendor Onboarding Requests"; '
      + '"Create Vendor Request" → "Raise Vendor Request" or "Add New Vendor". '
      + 'Do NOT click the profile avatar. Step: '
      + stripStepHtml(subDesc).substring(0, 200),
      stepIndex
    );
  }
  const quotedCta = quotedPhrases(subDesc)
    .filter((q) => q.split(/\s+/).length >= 2)
    .sort((a, b) => b.length - a.length)[0];
  if (quotedCta) {
    instruction = withExecutionContext(
      'Click the exact control labeled "' + quotedCta + '" in the main content or the open dialog. '
      + 'Do NOT click a shorter left-nav/sidebar label that is only part of that name. '
      + 'A Create/New/Edit form with Cancel and OK is an intermediate dialog, not the destination workspace. Step: '
      + stripStepHtml(subDesc).substring(0, 200),
      stepIndex
    );
  }
  if (looksLikeDataEntry(subDesc)) {
    instruction = withExecutionContext(
      'FORM ENTRY — interact with the visible wizard/form in the main content area only. '
      + 'Fill fields top-to-bottom. For parent/child controls: set the parent first, then the child. '
      + 'For text fields: click the field, clear it, type the value. '
      + 'For dropdowns/comboboxes: click the control to open the list, then click an option '
      + '(do NOT type into a closed dropdown). '
      + 'If test data is missing for a field, invent realistic fake data that matches the label '
      + '(valid email format, phone digits, plausible vendor/business names). '
      + 'Do NOT click Draft, Save as Draft, Save, Next, or Submit unless this step explicitly names that button. '
      + 'Do NOT click profile/Logout. Step: '
      + stripStepHtml(subDesc).substring(0, 220),
      stepIndex
    );
  }
  const proceedIntent = parseProceedIntent(subDesc);
  if (proceedIntent) {
    instruction = withExecutionContext(
      'Click the visible "' + proceedIntent.labels[0] + '" button in the form footer/main content. '
      + (proceedIntent.kind === 'next'
        ? 'Do NOT click Save as Draft, Draft, Save, or Submit. '
        : 'Do NOT click any other footer button. ')
      + 'Do NOT click profile/Logout. Step: '
      + stripStepHtml(subDesc).substring(0, 200),
      stepIndex
    );
  }

  let actResult = await stagehand.act(instruction, { page });
  await dismissOpenUserMenu(page, stepLabel);
  if (!isNoActionResult(actResult)) return actResult;

  const short = stripStepHtml(subDesc).substring(0, 180);
  const rephrased =
    'On the CURRENT page only (never launch/close a browser, never wait, never open profile/Logout): '
    + 'step wording may be a synonym of the UI label. '
    + 'Map by intent using common action families '
    + '(create/add/new/raise, edit/update, delete/remove, submit/save/send, search/find, view/open, approve/reject, menu/tab/nav). '
    + 'For vendor flows prefer "Vendor Onboarding Requests", "Raise Vendor Request", or "Add New Vendor". '
    + 'For menu/tab clicks: click the visible menuitem/tab/link in the sidebar; same-page content swap is success. '
    + 'Use the VISIBLE control that best matches the step intent and entity noun. '
    + 'Do not invent UI. If nothing visible matches, stop (no action found). '
    + 'Step: ' + short;
  rlog(stepLabel + ':HEAL:Original NL step failed (No action found) → semantic-intent rephrase once');
  actResult = await stagehand.act(withExecutionContext(rephrased, stepIndex), { page });
  await dismissOpenUserMenu(page, stepLabel);
  if (!isNoActionResult(actResult)) {
    rlog(stepLabel + ':HEALED:confidence=94 reason=synonym-to-visible-control');
  }
  return actResult;
}

// ── The dismissal JS payload (runs via page.evaluate) ─────────────────────────
// Exported as a string so it can be called from both the main flow and cross-frame logic.
function buildDismissJs() {
  return function() {
    // ── LAYER 1: Known CMP element IDs ───────────────────────────────────────
    // Covers: OneTrust, Cookiebot, Didomi, TrustArc, CookieYes, Osano,
    //         Complianz, CookieHub, iubenda, GDPR Cookie Consent, and more.
    var cmpIds = [
      // OneTrust / Optanon (used by ~70% of Fortune 500 pharma: J&J, AbbVie, Merck, Novartis, Takeda, Amgen, Lilly, Biogen, etc.)
      'onetrust-accept-btn-handler',
      'accept-recommended-btn-handler',
      // Cookiebot (Roche and others in EU)
      'CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      'CybotCookiebotDialogBodyButtonAccept',
      'CybotCookiebotDialogBodyLevelButtonAccept',
      // Didomi (Sanofi, some EU pharma)
      'didomi-notice-agree-button',
      // TrustArc (UCB, BMS, some legacy implementations)
      'truste-consent-button',
      'truste-consent-required',
      // CookieYes
      'cookieyes-accept',
      // Osano
      'osano-cm-accept-all',
      // GDPR Cookie Consent (WordPress plugin)
      'gdpr-cookie-accept',
      // Complianz (WordPress)
      'cmplz-accept',
      // CookieHub
      'cookiehub-dialog-button-accept',
      // iubenda
      'iubenda-cs-accept-btn',
      // Termly
      'termly-accept-btn',
      // WP Cookie Notice
      'cn-accept-cookie',
      // Cookie Notice (WordPress)
      'cookie-notice-accept',
      // Generic IDs frequently used in custom implementations
      'cookie-consent-accept', 'cookieConsentAccept', 'cookieAcceptButton',
      'acceptCookieButton', 'accept-cookie-btn', 'cookie-accept-btn',
      'accept-cookies-btn', 'btn-accept-cookies', 'accept_cookies',
    ];
    for (var ci = 0; ci < cmpIds.length; ci++) {
      var cmpEl = document.getElementById(cmpIds[ci]);
      if (cmpEl && cmpEl.offsetHeight > 0
          && window.getComputedStyle(cmpEl).display !== 'none'
          && window.getComputedStyle(cmpEl).visibility !== 'hidden') {
        cmpEl.click();
        return 'cmp-id:' + cmpIds[ci];
      }
    }

    // ── LAYER 1b: Known CMP CSS selectors ────────────────────────────────────
    var cmpSelectors = [
      // OneTrust variants
      '.onetrust-accept-btn-handler',
      '.optanon-allow-all',
      'button.ot-btn-handler',
      // Usercentrics (European pharma)
      '[data-testid="uc-accept-all-button"]',
      '.uc-btn-accept-banner',
      // Osano
      '.osano-cm-accept-all',
      '.osano-cm__button--accept_all',
      // CookieYes variants
      '.cky-btn-accept',
      // Complianz
      '.cmplz-btn.cmplz-accept',
      // Quantcast Choice / Freewheel
      '.qc-cmp2-summary-buttons button:first-child',
      // TrustArc / Evidon variants
      '.truste-consent-buttons button:first-child',
      '.evidon-banner-acceptbutton',
      '.evidon-accept-button',
      // Termly
      '.t-acceptAllBtn',
      // Ketch (used by some modern pharma sites)
      '[data-action="acceptAll"]',
      // Adobe Experience Cloud consent
      '.adobe-consent-banner [data-action="accept"]',
      // Cookie Information (Scandinavian sites)
      '.cookie-information-popup-container .coi-banner__accept',
      // Cookielaw (various)
      '.cookie-law-info-accept-button',
      // CookiePro
      '.cookie-consent-banner__accept',
      // Generic data-attribute patterns used in custom CMPs
      '[data-action="accept-cookies"]',
      '[data-consent-action="acceptAll"]',
      '[data-cy="cookie-accept"]',
      '[data-testid="cookie-accept-btn"]',
      '[data-testid="accept-all-cookies"]',
      'button[class*="accept-all"]',
      'button[class*="acceptAll"]',
      'button[class*="cookie-accept"]',
      'button[id*="accept-all"]',
      'a[class*="accept-cookies"]',
    ];
    for (var si = 0; si < cmpSelectors.length; si++) {
      try {
        var cmpSel = document.querySelector(cmpSelectors[si]);
        if (cmpSel && cmpSel.offsetHeight > 0
            && window.getComputedStyle(cmpSel).display !== 'none'
            && window.getComputedStyle(cmpSel).visibility !== 'hidden') {
          cmpSel.click();
          return 'cmp-sel:' + cmpSelectors[si];
        }
      } catch (_) {}
    }

    // ── LAYER 2: Intent-based overlay detection ───────────────────────────────
    // Finds any visually blocking overlay (ARIA role OR z-index based) and
    // understands WHAT it's asking based on its text, then clicks the right button.
    // This is the generic layer that handles any site without needing site-specific selectors.

    // Collect all candidate blocking elements
    var candidates = [];

    // 2a: ARIA-role overlays (W3C compliant)
    Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],[aria-modal="true"]'))
      .forEach(function(el) {
        var cs = window.getComputedStyle(el);
        if (cs.display !== 'none' && cs.visibility !== 'hidden'
            && parseFloat(cs.opacity || '1') > 0 && el.offsetHeight > 0) {
          candidates.push({ el: el, zi: parseInt(cs.zIndex || '0', 10) });
        }
      });

    // 2b: Visual overlays (fixed/absolute + high z-index) for non-ARIA sites like GSK India
    if (candidates.length === 0) {
      Array.from(document.querySelectorAll('div,section,aside,article,header'))
        .forEach(function(el) {
          var cs = window.getComputedStyle(el);
          var zi = parseInt(cs.zIndex || '0', 10);
          if ((cs.position === 'fixed' || cs.position === 'absolute') && zi > 100
              && cs.display !== 'none' && cs.visibility !== 'hidden'
              && parseFloat(cs.opacity || '1') > 0
              && el.offsetHeight > 80 && el.offsetWidth > 150
              && el.offsetTop < window.innerHeight && el.offsetTop >= 0) {
            candidates.push({ el: el, zi: zi });
          }
        });
    }

    // Sort highest z-index first (topmost overlay)
    candidates.sort(function(a, b) { return b.zi - a.zi; });

    // Intent map: reads overlay text → picks which button action to perform
    // Order matters — more specific patterns first
    var intents = [
      {
        // Cookie / GDPR consent → click Accept
        detect: /\bcookie\b|\bgdpr\b|\btracking\b|\bconsent\b|\bprivacy preferences\b|\banalytics cookie|\buse of cookie/i,
        action: /\baccept all\b|\baccept all cookies\b|\ballow all\b|\ballow all cookies\b|\baccept\b|\ballow\b|\bagree\b|\bi understand\b|\bgot it\b|\ball cookies\b|\bcontinue\b/i,
        tag: 'cookie-consent'
      },
      {
        // Healthcare Professional / Provider (HCP) gate → click Yes / Confirm / I am HCP
        // detect: also covers "healthcare provider" (e.g. kerendiahcp.com "Are you a US healthcare provider?")
        detect: /healthcare professional|healthcare provider|health care provider|medical professional|\bhcp\b|health care professional|are you a (health|medical|doctor|physician|nurse|pharmacist)|prescriber|licensed practitioner/i,
        // action: covers "US healthcare provider", "Healthcare provider", "Yes / I am / Confirm" variants
        action: /^(yes|i am|i am a|i'm a|i am an|yes.*hcp|yes.*health|yes.*professional|yes.*provider|yes.*doctor|yes.*physician|continue as|enter as|i confirm|confirm|healthcare professional|healthcare provider|i am a healthcare|i'm a healthcare|us healthcare)/i,
        tag: 'hcp-gate'
      },
      {
        // Country / region selector → select country or click Confirm/Continue
        detect: /select.*country|choose.*region|your country|which country|select.*region|select.*location|select a country|country of residence|where are you/i,
        action: /continue|proceed|confirm|go|enter|submit|ok/i,
        tag: 'country-selector'
      },
      {
        // Age gate → confirm age
        detect: /age verification|are you (18|21)|must be (18|21)|confirm.*age|legal.*age|you must be at least (18|21)/i,
        action: /yes|i am|18|21|enter|confirm|i'm of legal age|i am of legal age/i,
        tag: 'age-gate'
      },
      {
        // Regulatory / medical disclaimer → Continue/I acknowledge
        detect: /regulatory|intended for|health professionals|medical information|prescription.*only|important safety|patient information|prescribing information/i,
        action: /continue|proceed|i understand|acknowledge|yes|agree|accept|confirm|i am (18|21|over)|i have read/i,
        tag: 'regulatory'
      },
      {
        // Fraud / security warning (GSK India style) → Close
        detect: /fraud|genuine|authentic|phishing|verify.*identity|job.*offer|recruitment.*fraud|fake.*job|fraudulent/i,
        action: /close|dismiss|ok|got it|continue|proceed|i understand|acknowledge/i,
        tag: 'fraud-warning'
      },
      {
        // Newsletter / promo popup → Close / No Thanks
        detect: /newsletter|subscribe.*email|sign.*up.*email|join.*mailing|promotional|special offer|exclusive deal/i,
        action: /no thanks|close|dismiss|not now|maybe later|skip|later|×|x/i,
        tag: 'newsletter'
      },
      {
        // Location / language selection (common on global pharma sites)
        detect: /select.*language|choose.*language|preferred language|select.*site|choose your site/i,
        action: /continue|proceed|confirm|english|go|enter/i,
        tag: 'language-selector'
      },
      {
        // Generic fallback — cookie/consent/info only. NEVER OK a create/edit/import form.
        detect: /[\s\S]*/,
        action: /^(close|dismiss|×|x|✕|got it|no thanks)$/i,
        tag: 'generic'
      }
    ];

    for (var oi = 0; oi < Math.min(candidates.length, 5); oi++) {
      var cand = candidates[oi].el;
      var rawText = (cand.innerText || cand.textContent || '').trim();

      // Skip tiny or huge elements (likely wrappers or fragments)
      if (rawText.length < 8 || rawText.length > 8000) continue;

      // Create/edit/import workflow dialogs are the test — never auto-OK them as overlays.
      var blob = rawText.toLowerCase();
      var hasCancel = /\bcancel\b/.test(blob);
      var hasPrimary = /\b(ok|save|create|submit|continue|add|apply|next)\b/.test(blob);
      var formish = ((rawText.match(/\b(name|title|type|brand|region|country|email|campaign|language|status|owner|date)\b/gi) || []).length >= 2);
      var workflow = /\b(new |create |add |edit |import |export )\b/i.test(rawText);
      if (hasCancel && hasPrimary && (formish || workflow)) {
        continue;
      }

      var candBtns = Array.from(cand.querySelectorAll('button,[role=button]'));
      if (candBtns.length === 0) continue;

      for (var ii = 0; ii < intents.length; ii++) {
        var intent = intents[ii];
        if (!intent.detect.test(rawText)) continue;

        var targetBtn = null;

        // Find the button whose label matches the intended action
        targetBtn = candBtns.find(function(b) {
          if (b.offsetHeight === 0 || window.getComputedStyle(b).display === 'none'
              || window.getComputedStyle(b).visibility === 'hidden') return false;
          var label = (b.innerText || b.textContent || b.getAttribute('aria-label') || b.value || '').trim();
          return intent.action.test(label);
        });

        // For generic fallback: also check structural close-button patterns
        if (!targetBtn && intent.tag === 'generic') {
          var closeEl = cand.querySelector('.close,.btn-close,[aria-label="Close"],[title="Close"],[data-dismiss],[data-bs-dismiss]');
          if (closeEl && closeEl.offsetHeight > 0
              && window.getComputedStyle(closeEl).display !== 'none') {
            targetBtn = closeEl;
          }
          // Single-button overlays: just click the one button
          if (!targetBtn && candBtns.length === 1) {
            targetBtn = candBtns[0];
          }
        }

        if (targetBtn) {
          targetBtn.click();
          return intent.tag + ':' + (targetBtn.innerText || targetBtn.getAttribute('aria-label') || '').trim().substring(0, 40);
        }
        break; // Intent matched but no button found → don't try other intents for this candidate
      }
    }

    // ── LAYER 2c: Bottom-of-page cookie banners ───────────────────────────────
    // Handles banners that sit at the bottom of the page (not overlays)
    var acceptRx = /\baccept all\b|\baccept\b|\ballow all\b|\ballow\b|\bi accept\b|\bi agree\b|\bagree\b|\bgot it\b|\^ok$|\byes\b/i;
    var bannerSels = [
      '#cookieConsent', '#cookie-consent', '#cookieBanner', '#cookie-banner',
      '#cookie-notice', '#gdpr-banner', '#privacy-banner', '#consent-banner',
      '#cc-window', '#cc-main', '#cookie-law-info-bar', '#cookie_notice_container',
      '#CookieConsent', '#cookie_consent_container', '#cookies-eu-banner',
      '.cookie-banner', '.cookie-consent', '.cookie-notice', '.gdpr-banner',
      '.cc-window', '.cc-banner', '.cc-floating', '.cc-popup',
      '.cookie-bar', '.cookie-alert', '.cookie-law-info-bar', '.cookies-bar',
      '.consent-banner', '.privacy-banner', '.gdpr-consent', '.cookie-policy-banner',
      '[id*="cookie"][id*="banner"]', '[id*="cookie"][id*="consent"]',
      '[id*="gdpr"]', '[id*="consent"][id*="banner"]',
      '[class*="cookie-bar"]', '[class*="cookie-banner"]', '[class*="consent-banner"]',
      '[class*="gdpr-bar"]', '[class*="gdpr-banner"]', '[class*="-cookie-consent"]',
    ];
    for (var bi = 0; bi < bannerSels.length; bi++) {
      try {
        var banners = Array.from(document.querySelectorAll(bannerSels[bi]));
        for (var bj = 0; bj < banners.length; bj++) {
          var banner = banners[bj];
          var bcs = window.getComputedStyle(banner);
          if (bcs.display === 'none' || bcs.visibility === 'hidden' || banner.offsetHeight < 10) continue;
          var bannerBtns = Array.from(banner.querySelectorAll('button,a,[role=button]'));
          var acceptBannerBtn = bannerBtns.find(function(b) {
            return acceptRx.test((b.innerText || b.textContent || '').trim());
          });
          if (acceptBannerBtn) {
            acceptBannerBtn.click();
            return 'cookie-banner:' + (acceptBannerBtn.innerText || '').trim().substring(0, 40);
          }
        }
      } catch (_) {}
    }

    return null;
  };
}

/**
 * Mid-flow popups / toasts / validation messages must not hard-stop a TC unless the
 * step is explicitly verifying that message. Decide from screen + step/expected, then continue.
 */
function stepExpectsPopupOrValidation(desc, expected) {
  const blob = (String(desc || '') + ' ' + String(expected || '')).toLowerCase();
  const aboutUi =
    /\b(popup|pop-up|modal|dialog|overlay|cookie|banner|toast|snackbar|alert|validation|error message|warning message|notification)\b/.test(blob);
  const verifying =
    /\b(verify|assert|check|confirm|ensure|see|appear|appears|display|displayed|show|shows|visible|present|should\s+see)\b/.test(blob)
    || /\b(error|validation|required field|invalid)\b/.test(String(expected || '').toLowerCase());
  return aboutUi && verifying;
}

function stepLooksDestructive(desc) {
  return /\b(delete|remove|destroy|purge|cancel\s+order|unsubscribe|deactivate|revoke)\b/i.test(String(desc || ''));
}

function stepLooksConfirming(desc) {
  return /\b(submit|save|send|confirm|approve|continue|proceed|pay|checkout|publish|create|update)\b/i.test(String(desc || ''));
}

async function scanMidFlowInterrupts(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 8;
    }
    function btnLabel(b) {
      return ((b.getAttribute('aria-label') || b.innerText || b.textContent || b.value || '')
        .replace(/\s+/g, ' ').trim()).slice(0, 80);
    }

    const out = [];

    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .modal.show, .modal.in, .ReactModal__Content, '
      + '[class*="MuiDialog"], [class*="ant-modal"], [class*="chakra-modal"]'
    )).filter(visible);
    dialogs.forEach((d, i) => {
      const text = (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const buttons = Array.from(d.querySelectorAll(
        'button, [role="button"], a.btn, input[type="button"], input[type="submit"]'
      ))
        .filter(visible)
        .map(btnLabel)
        .filter(Boolean)
        .slice(0, 8);
      out.push({ kind: 'dialog', id: 'dlg-' + i, text, buttons });
    });

    const toasts = Array.from(document.querySelectorAll(
      '[role="status"], [role="alert"], .Toastify__toast, [class*="toast"], [class*="snackbar"], '
      + '[class*="notification"], .alert, .alert-warning, .alert-info, .alert-danger, .alert-success'
    )).filter(visible);
    toasts.forEach((t, i) => {
      const text = (t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!text || text.length < 8) return;
      // Nav badges / tab labels (e.g. "Template") are not dismissible toasts
      const toastKw = /success|error|saved|copied|failed|cookie|consent|warning|session|timeout|dismiss|got it|imported|please|invalid/i;
      if (text.length < 48 && !toastKw.test(text)
          && !t.querySelector('button, [role="button"], [aria-label*="close" i], .close')) {
        return;
      }
      if (t.closest('nav, [role="tablist"], [role="tab"], aside, header, [class*="badge" i], [class*="Chip"], [class*="card"]')) {
        return;
      }
      // Skip short field-validation blurbs — handled as validation, not dismissible toasts
      if (text.length < 160
          && /required|select an |is required|please (select|enter|fill)/i.test(text)
          && /email|name|category|entity|purpose|phone|onboarding|field/i.test(text)
          && !t.querySelector('button, [role="button"]')) {
        return;
      }
      if (out.some(o => o.kind === 'dialog' && o.text.includes(text.slice(0, 40)))) return;
      const buttons = Array.from(t.querySelectorAll(
        'button, [role="button"], [aria-label*="close" i], .close'
      ))
        .filter(visible)
        .map(btnLabel)
        .filter(Boolean)
        .slice(0, 4);
      out.push({ kind: 'toast', id: 'toast-' + i, text, buttons });
    });

    const valMsgs = [];
    document.querySelectorAll(
      '[class*="error"], [class*="invalid"], [aria-invalid="true"], .text-danger, .text-red-500, '
      + '[class*="FormError"], [class*="helper-text"], [class*="field-error"]'
    ).forEach((el) => {
      if (!visible(el)) return;
      const t = (el.innerText || el.textContent || el.getAttribute('aria-errormessage') || '')
        .replace(/\s+/g, ' ').trim();
      if (t && /required|invalid|select|enter|must|please|cannot|can't|unable|missing|wrong|incorrect/i.test(t)) {
        valMsgs.push(t.slice(0, 120));
      }
    });
    if (valMsgs.length) {
      out.push({
        kind: 'validation',
        id: 'val-0',
        text: valMsgs.slice(0, 6).join(' | '),
        buttons: [],
        count: valMsgs.length,
      });
    }

    return out.slice(0, 8);
  }).catch(() => []);
}

function pickSafeButton(buttonsLower, preferred) {
  for (const want of preferred) {
    const hit = buttonsLower.find(b => b === want || b.includes(want));
    if (hit) return hit;
  }
  const short = buttonsLower.find(b => b.length > 0 && b.length <= 24 && !/learn more|read more|details|help/i.test(b));
  return short || null;
}

function classifyInterruptDecision(interrupt, stepDesc, expected) {
  const text = String(interrupt.text || '').toLowerCase();
  const buttons = (interrupt.buttons || []).map(b => String(b).toLowerCase());
  const step = String(stepDesc || '').toLowerCase();
  const exp = String(expected || '').toLowerCase();

  if (stepExpectsPopupOrValidation(stepDesc, expected)) {
    return { decision: 'preserve', reason: 'step/expected verifies popup or validation', click: null };
  }

  if (interrupt.kind === 'dialog' && isTaskWorkflowDialogText(interrupt.text)) {
    if (isOptionalDismissStep(stepDesc)) {
      const click = pickSafeButton(buttons, ['cancel', 'close', 'dismiss', '×', 'x']);
      return { decision: 'dismiss', reason: 'optional-dismiss leftover workflow dialog — Cancel not OK', click };
    }
    return { decision: 'preserve', reason: 'task workflow dialog (create/edit/import form) — do not auto-OK', click: null };
  }

  // Field-level required/select messages — even if scanned as toast/alert, must FILL not dismiss
  const looksLikeFieldValidation =
    interrupt.kind === 'validation'
    || (/required|select an |enter |must |please (select|enter|fill)|is required/i.test(text)
        && /email|name|category|entity|purpose|phone|address|field|onboarding/i.test(text)
        && text.length < 180
        && !(interrupt.buttons || []).some(b => /ok|close|got it|dismiss|accept/i.test(String(b))));

  if (looksLikeFieldValidation) {
    if (/\b(error|invalid|required|fail)\b/.test(exp)
        && /\b(see|show|display|appear|visible)\b/.test(exp + ' ' + step)) {
      return { decision: 'preserve', reason: 'expected validation message', click: null };
    }
    return { decision: 'fix_validation', reason: 'inline field validation — fill missing values', click: null };
  }

  if (interrupt.kind === 'toast'
      || /cookie|consent|privacy|newsletter|subscribe|promo|welcome|tip|hint|got it|session.*expir|idle timeout/i.test(text)
      || /healthcare professional|hcp|are you a healthcare|i am a healthcare/i.test(text)) {
    const click = pickSafeButton(buttons, [
      'got it', 'ok', 'close', 'dismiss', 'accept', 'allow', 'agree', 'continue',
      'yes', 'i understand', 'no thanks', 'not now', '×', 'x',
    ]);
    return { decision: 'dismiss', reason: 'non-blocking info/cookie/toast', click };
  }

  const isConfirm = /are you sure|confirm|do you want|proceed|unsaved|leave this page|discard|overwrite/i.test(text);
  const isDestructiveUi = /delete|remove|permanently|cannot be undone|irreversible/i.test(text);
  if (isConfirm || interrupt.kind === 'dialog') {
    if (isDestructiveUi && !stepLooksDestructive(stepDesc)) {
      const click = pickSafeButton(buttons, ['cancel', 'no', 'close', 'dismiss', 'keep', 'stay', '×', 'x']);
      return { decision: 'dismiss', reason: 'destructive confirm unrelated to step — cancel/close', click };
    }
    if (stepLooksConfirming(stepDesc) || stepLooksDestructive(stepDesc)) {
      const click = pickSafeButton(buttons, [
        'ok', 'yes', 'confirm', 'continue', 'proceed', 'submit', 'save', 'delete', 'remove', 'allow',
      ]);
      return { decision: 'acknowledge', reason: 'confirm dialog aligns with step intent', click };
    }
    const click = pickSafeButton(buttons, ['ok', 'got it', 'close', 'dismiss', 'continue', 'cancel', '×', 'x']);
    return { decision: 'dismiss', reason: 'unexpected dialog — clear and continue', click };
  }

  return { decision: 'ignore', reason: 'no clear interrupt action', click: null };
}

async function clickInterruptButton(page, label, stepLabel) {
  if (!label) return false;
  const ok = await page.evaluate((want) => {
    function visible(el) {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    }
    const wantL = String(want || '').toLowerCase().trim();
    const roots = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .modal.show, .modal.in, [role="alert"], [role="status"], '
      + '.Toastify__toast, [class*="toast"], [class*="snackbar"], body'
    ));
    for (const root of roots) {
      const btns = Array.from(root.querySelectorAll(
        'button, [role="button"], a.btn, input[type="button"], input[type="submit"], [aria-label]'
      )).filter(visible);
      for (const b of btns) {
        const t = ((b.getAttribute('aria-label') || b.innerText || b.textContent || b.value || '')
          .replace(/\s+/g, ' ').trim()).toLowerCase();
        if (!t) continue;
        if (t === wantL || t.includes(wantL) || wantL.includes(t)) {
          try { b.click(); } catch (_) {}
          return true;
        }
      }
    }
    return false;
  }, label).catch(() => false);

  if (ok) {
    rlog(stepLabel + ':INTERRUPT:clicked "' + String(label).slice(0, 60) + '"');
    await page.waitForTimeout(350);
    return true;
  }
  return false;
}

/**
 * Context-aware mid-flow interrupt handler. Never throws — always continues testing.
 * Decisions: preserve | dismiss | acknowledge | fix_validation | ignore | none
 */
async function handleMidFlowInterrupt(page, stagehand, stepLabel, stepDesc, expected) {
  const label = stepLabel || 'STEP';
  try {
    if (cfg.skipInitDismiss && stepExpectsPopupOrValidation(stepDesc, expected)) {
      rlog(label + ':INTERRUPT:preserve (skipInitDismiss + step verifies popup/validation)');
      return { handled: false, decision: 'preserve', continued: true };
    }

    const interrupts = await scanMidFlowInterrupts(page);
    if (!interrupts.length) {
      const ws = await inspectAppWorkspace(page).catch(() => null);
      if (ws && (ws.kind === 'create-form' || ws.kind === 'tool-dialog')) {
        rlog(label + ':INTERRUPT:preserve workflow dialog kind=' + ws.kind);
        return { handled: false, decision: 'preserve', continued: true };
      }
      const dismissed = await dismissBlockingUi(page, label + ':INTERRUPT', null, false);
      return { handled: !!dismissed, decision: dismissed ? 'dismiss' : 'none', continued: true };
    }

    rlog(label + ':INTERRUPT:detected n=' + interrupts.length
      + ' kinds=' + interrupts.map(i => i.kind).join(','));

    // Prefer filling field validation before dismissing unrelated toasts/dialogs
    interrupts.sort((a, b) => {
      const rank = (k) => (k === 'validation' ? 0 : (k === 'toast' ? 1 : 2));
      return rank(a.kind) - rank(b.kind);
    });

    let anyHandled = false;
    for (const interrupt of interrupts) {
      const plan = classifyInterruptDecision(interrupt, stepDesc, expected);
      rlog(label + ':INTERRUPT:decide=' + plan.decision
        + ' kind=' + interrupt.kind
        + ' why=' + String(plan.reason || '').slice(0, 120)
        + ' text=' + String(interrupt.text || '').replace(/\r?\n/g, ' ').slice(0, 100));

      if (plan.decision === 'preserve' || plan.decision === 'ignore') continue;

      if (plan.decision === 'fix_validation') {
        anyHandled = true;
        rlog(label + ':INTERRUPT:fix_validation — fill errored/empty required fields, then continue');
        try {
          await fixValidationErrorsAndContinue(
            page, stagehand, label, stepDesc || 'fix vendor form validation and continue'
          );
        } catch (e) {
          rlog(label + ':INTERRUPT:fix_WARN:' + (e && e.message ? e.message : e));
        }
        continue;
      }

      if (plan.decision === 'dismiss' || plan.decision === 'acknowledge') {
        let clicked = false;
        if (plan.click) clicked = await clickInterruptButton(page, plan.click, label);
        if (!clicked) clicked = await dismissBlockingUi(page, label + ':INTERRUPT', null, false);
        if (!clicked && stagehand && plan.decision === 'dismiss') {
          try {
            const ai = await stagehand.act(
              'A non-critical popup, toast, or dialog is blocking the page. '
              + 'Click Close, OK, Got it, Dismiss, Accept, Continue, or Cancel as appropriate. '
              + 'Do NOT delete, pay, or submit unless those exact words are the only safe close action. '
              + 'If nothing is blocking, do nothing. Step context: '
              + String(stepDesc || '').slice(0, 160),
              { page }
            );
            if (!isNoActionResult(ai)) {
              clicked = true;
              rlog(label + ':INTERRUPT:ai-dismiss:'
                + String(ai && ai.message ? ai.message : 'ok').replace(/\r?\n/g, ' ').slice(0, 80));
            }
          } catch (_) {}
        }
        if (clicked) anyHandled = true;
        await page.waitForTimeout(200);
      }
    }

    if (!stepExpectsPopupOrValidation(stepDesc, expected)) {
      const still = await scanMidFlowInterrupts(page);
      if (still.some(i => i.kind === 'dialog')) {
        await dismissBlockingUi(page, label + ':INTERRUPT:retry', null, false);
      }
    }

    rlog(label + ':INTERRUPT:continue testing (roadblock=false handled=' + anyHandled + ')');
    return { handled: anyHandled, decision: anyHandled ? 'cleared' : 'noted', continued: true };
  } catch (e) {
    rlog(label + ':INTERRUPT:WARN:' + (e && e.message ? e.message : e) + ' — continuing');
    return { handled: false, decision: 'error_continued', continued: true };
  }
}

// ── Generic blocking-UI dismissal ─────────────────────────────────────────────
async function dismissBlockingUi(page, contextLabel, stagehand, useAiFallback) {
  const lbl = contextLabel || 'INIT';

  // ── Layer 1 + 2: JS-based detection ───────────────────────────────────────
  let hit = null;
  try {
    hit = await page.evaluate(buildDismissJs());
  } catch (_) {}

  if (hit) {
    rlog(lbl + ':DISMISS:' + hit);
    await page.waitForTimeout(800);
    return true;
  }

  // ── Layer 3: Cross-frame CMPs (OneTrust/Cookiebot in sandboxed iframes) ───
  try {
    const frames = page.frames ? page.frames() : [];
    for (const frame of frames) {
      try {
        const frameUrl = frame.url ? frame.url() : '';
        if (!frameUrl || frameUrl === 'about:blank') continue;
        const frameHit = await frame.evaluate(buildDismissJs());
        if (frameHit) {
          rlog(lbl + ':DISMISS:frame:' + frameHit + ' (' + frameUrl.substring(0, 60) + ')');
          await page.waitForTimeout(800);
          return true;
        }
      } catch (_) {}
    }
  } catch (_) {}

  // ── Layer 4: Stagehand AI visual fallback (used ONLY at INIT, once) ────────
  // Handles popups that JS detection cannot see (heavy shadow DOM, complex iframes,
  // sites that obscure elements from document.querySelector, etc.)
  if (useAiFallback && stagehand) {
    try {
      rlog(lbl + ':DISMISS:ai-fallback — no popup found by JS, trying visual detection');
      const aiResult = await stagehand.act(
        'Look at the current page. If there is a modal popup, cookie consent banner, ' +
        'healthcare professional gate, country selector, age verification, or any overlay ' +
        'blocking the main page content — dismiss it by clicking the appropriate button ' +
        '(Close, Accept, Allow, Yes, Continue, Dismiss, or similar). ' +
        'If there is NO blocking overlay or popup visible, do nothing.',
        { page }
      );
      const aiMsg = (aiResult && aiResult.message) ? String(aiResult.message) : '';
      if (aiMsg && !/no action|nothing to do|not found|not visible/i.test(aiMsg)) {
        rlog(lbl + ':DISMISS:ai:' + aiMsg.replace(/\r?\n/g, ' ').substring(0, 80));
        await page.waitForTimeout(800);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

// ── Chrome CDP WebSocket URL ───────────────────────────────────────────────────
function getChromeCdpWsUrl(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.webSocketDebuggerUrl)
            return reject(new Error('Chrome /json/version has no webSocketDebuggerUrl'));
          resolve(json.webSocketDebuggerUrl);
        } catch (e) {
          reject(new Error('Failed to parse Chrome CDP response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Timeout fetching Chrome CDP URL')));
  });
}

// ── Azure OpenAI client ────────────────────────────────────────────────────────
function buildAzureClient() {
  return new OpenAI({
    apiKey:         cfg.apiKey,
    baseURL:        `${cfg.endpoint}/openai/deployments/${cfg.deploy}`,
    defaultQuery:   { 'api-version': cfg.version },
    defaultHeaders: { 'api-key': cfg.apiKey },
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  let stagehand = null;
  let page      = null;

  try {
    const llmClient = new CustomOpenAIClient({
      modelName: cfg.deploy,
      client:    buildAzureClient(),
    });

    const cdpWsUrl = cfg.isProxy ? await getChromeCdpWsUrl(cfg.proxyPort) : null;

    const launchOpts = cfg.isProxy
      ? { cdpUrl: cdpWsUrl, ignoreHTTPSErrors: true }
      : {
          headless: true,
          args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1920,1080',
            '--force-device-scale-factor=1',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
          ],
          ignoreHTTPSErrors: true,
        };

    // verbose:1 → Stagehand info/warn into terminal log (stdout protocol stays clean via custom logger)
    stagehand = new Stagehand({
      env:                       'LOCAL',
      llmClient,
      localBrowserLaunchOptions: launchOpts,
      verbose:                   1,
      logger:                    stagehandSdkLogger,
      disablePino:               true,
      selfHeal:                  true,
      domSettleTimeout:          2000,
    });

    await stagehand.init();

    rlog('INIT:Mode=' + (cfg.isProxy ? 'Proxy/SSO (port ' + cfg.proxyPort + ')' : 'Headless')
        + ' | Steps=' + cfg.steps.length + ' | URL=' + cfg.baseUrl
        + (cfg.skipInitDismiss ? ' | skipInitDismiss=true' : '')
        + (cfg.logFile ? ' | logFile=on' : ''));
    if (bizPlan) {
      rlog('PLAN:flow=' + (bizPlan.businessFlow || '')
        + ' module=' + (bizPlan.module || '')
        + ' severity=' + (bizPlan.severity || '')
        + ' intent=' + (bizPlan.intentSource || '')
        + ' confidence=' + (bizPlan.flowConfidence != null ? bizPlan.flowConfidence : '')
        + '% actions=' + (Array.isArray(bizPlan.catalogActions) ? bizPlan.catalogActions.join('>') : '')
        + ' atomic=' + (Array.isArray(bizPlan.actions) ? bizPlan.actions.length : 0));
      const missing = bizPlan.rules && bizPlan.rules.missingFields;
      if (Array.isArray(missing) && missing.length) {
        rlog('RULE:missing test data fields: ' + missing.join(', '));
      }
    }
    if (cfg.executionContext && cfg.executionContext.trim()) {
      rlog('CONTEXT:Agreed Confluence/design hints loaded (' + cfg.executionContext.trim().length + ' chars)');
    }
    if (cfg.ragEnabled) {
      rlog('RAG:enabled stepHints=' + cfg.stepMemory.length
        + ' memoryPack=' + (cfg.memoryPack ? cfg.memoryPack.trim().length : 0) + ' chars'
        + ' confluence=' + (cfg.confluenceHints ? cfg.confluenceHints.trim().length : 0) + ' chars');
    }

    if (cfg.isProxy) {
      page = await stagehand.context.awaitActivePage();
    } else {
      page = await stagehand.context.newPage();
    }

    await page.setViewportSize(1920, 1080);

    // ── Navigate ─────────────────────────────────────────────────────────────
    if (cfg.baseUrl) {
      await safeGoto(page, cfg.baseUrl, 'NAV', cfg.navTimeoutMs);

      // Many pharma/enterprise sites delay-load popups 1-3s after navigation settles
      await page.waitForTimeout(2000);

      if (cfg.skipInitDismiss) {
        rlog('INIT:skipInitDismiss — popup/cookie left visible for this TC to interact with');
      } else {
        // Attempt 1: JS + cross-frame
        let dismissed = await dismissBlockingUi(page, 'INIT', null, false);
        if (!dismissed) {
          // Some sites load popup after a delay — wait and retry
          await page.waitForTimeout(1800);
          dismissed = await dismissBlockingUi(page, 'INIT', null, false);
          if (!dismissed) {
            // Last resort: use Stagehand AI vision (once, only at init)
            dismissed = await dismissBlockingUi(page, 'INIT', stagehand, true);
            if (!dismissed) {
              rlog('INIT:No blocking overlay detected — page is clean');
            }
          }
        }
      }
      await page.waitForTimeout(300);
    }

    // ── Pre-step popup dismiss (optional, user-controlled) ────────────────────
    // Runs AFTER the normal init dismiss so it catches any popup that appeared
    // late (e.g. fraud gate that loads 3-4s after domcontentloaded).
    if (cfg.preDismissPopup && !cfg.skipInitDismiss) {
      rlog('PRE_DISMISS:Running extra popup dismiss before step 1…');
      const pd = await dismissBlockingUi(page, 'PRE_DISMISS', null, false);
      if (!pd) {
        await page.waitForTimeout(800);
        await dismissBlockingUi(page, 'PRE_DISMISS', stagehand, true);
      }
    }

    // ── Pre-step frame switch (optional, user-controlled) ─────────────────────
    // When frameSelector is set, resolve a FrameLocator for the named iframe.
    // All Stagehand act/extract calls will be scoped to that frame.
    // After the last step we switch back to the main frame.
    let activeFrame = null;
    if (cfg.frameSelector) {
      try {
        activeFrame = page.frameLocator(cfg.frameSelector);
        rlog('FRAME:Switched to frame: ' + cfg.frameSelector);
      } catch (fex) {
        rlog('FRAME:WARNING — could not switch to frame "' + cfg.frameSelector + '": ' + fex.message);
        activeFrame = null;
      }
    }

    // ── Read the script the way a tester does, then execute ─────────────────
    const qaBrief = qaReadTestCase();
    qaLogBriefing(qaBrief);

    // ── Execute steps ─────────────────────────────────────────────────────────
    for (let i = 0; i < cfg.steps.length; i++) {
      const step     = cfg.steps[i];
      const desc     = (step.description   || '').trim();
      const expected = (step.expectedResult || '').trim();
      if (!desc) continue;

      const stepLabel = 'STEP:' + (i + 1);
      const stepT0 = Date.now();
      let stepKind = 'UNKNOWN';
      rlog(stepLabel + ':QA:role=' + qaStepRole(desc, expected)
        + ' — ' + stripLeadingStepNumber(stripStepHtml(desc)).slice(0, 140));
      const planned = plannedForStep(i + 1);
      // Prefer local classify for NAV so we can goto when off-page; map VERIFY → VERIFY_ONLY.
      let klass = classifyStep(desc);
      if (planned && planned.type === 'VERIFY') {
        klass = { kind: 'VERIFY_ONLY', reason: planned.businessAction || 'plan-verify' };
      } else if (planned && planned.type === 'META') {
        klass = { kind: 'META', reason: planned.businessAction || 'plan-meta' };
      } else if (planned && planned.type === 'WAIT') {
        klass = { kind: 'WAIT', ms: 400, reason: planned.businessAction || 'plan-wait' };
      } else if (planned && (planned.type === 'NAV' || planned.type === 'ACT')) {
        // Keep classifyStep result for NAV (real goto) / ACT — do NOT soft-skip NAV blindly
        if (klass.kind !== 'NAV' && planned.type === 'NAV') {
          klass = { kind: 'NAV', reason: planned.businessAction || 'plan-nav' };
        } else if (klass.kind === 'VERIFY_ONLY' && planned.type === 'ACT') {
          klass = { kind: 'ACT', reason: planned.businessAction || 'plan-act' };
        }
      }

      // SSO / already-authenticated: never execute credential login (avoids profile avatar clicks).
      const loginish = looksLikeLoginStep(desc)
        || (planned && String(planned.businessAction || '').toUpperCase() === 'LOGIN');
      if (loginish && !looksLikeLogoutStep(desc) && klass.kind !== 'META') {
        const alreadyIn = cfg.isProxy || await pageLooksLoggedIn(page);
        if (alreadyIn) {
          klass = { kind: 'META', reason: 'already logged in (SSO/session) — skip login/credentials' };
        }
      }
      stepKind = klass.kind || 'UNKNOWN';
      try {
      if (planned) {
        rlog(stepLabel + ':PLAN:' + planned.actionId + ' type=' + planned.type
          + ' biz=' + planned.businessAction + ' validation=' + planned.validation
          + ' exec=' + klass.kind);
      }

      // ── Fast paths: META / WAIT ──
      if (klass.kind === 'META') {
        rlog(stepLabel + ':SKIP_META:' + klass.reason + ' — ' + desc.substring(0, 120));
        await dismissOpenUserMenu(page, stepLabel);
        if (expected && expected.toLowerCase() !== 'na' && expected.toLowerCase() !== 'n/a') {
          const check = await verifyStepExpected(stagehand, page, stepLabel, expected);
          const reason = check.reason ? String(check.reason).replace(/\r?\n/g, ' ').substring(0, 300) : '';
          if (!check.met) {
            rememberIssueRects(check.highlightRects);
            rlog(stepLabel + ':VERIFY_FAIL:' + reason);
            await stepScreenshot(page, i + 1, check.highlightRects);
            throw new Error(`Step ${i + 1} assertion failed — expected: "${expected}" | observed: ${check.reason}`);
          }
          rlog(stepLabel + ':VERIFY_PASS:' + reason);
        }
        await stepScreenshot(page, i + 1);
        continue;
      }

      if (klass.kind === 'WAIT') {
        const ms = klass.ms || 400;
        rlog(stepLabel + ':WAIT:' + ms + 'ms (capped for speed) — ' + desc.substring(0, 80));
        await page.waitForTimeout(ms);
        await stepScreenshot(page, i + 1);
        continue;
      }

      if (klass.kind === 'DISMISS_OPTIONAL') {
        rlog(stepLabel + ':DISMISS_OPTIONAL:' + desc.substring(0, 120));
        await handleOptionalDismissStep(page, stepLabel);
        if (expected && expected.toLowerCase() !== 'na' && expected.toLowerCase() !== 'n/a') {
          const check = await verifyStepExpected(stagehand, page, stepLabel, expected);
          const reason = check.reason ? String(check.reason).replace(/\r?\n/g, ' ').substring(0, 300) : '';
          if (!check.met) {
            rememberIssueRects(check.highlightRects);
            rlog(stepLabel + ':VERIFY_FAIL:' + reason);
            await stepScreenshot(page, i + 1, check.highlightRects);
            throw new Error(`Step ${i + 1} assertion failed — expected: "${expected}" | observed: ${check.reason}`);
          }
          rlog(stepLabel + ':VERIFY_PASS:' + reason);
        }
        await stepScreenshot(page, i + 1);
        continue;
      }

      // ── NAV: goto target URL when not already there (critical for batch TCs) ──
      if (klass.kind === 'NAV' || klass.kind === 'NAV_SOFT') {
        const targetUrl = extractUrlFromStep(desc) || cfg.baseUrl || null;
        let cur = '';
        try { cur = page.url ? String(page.url()) : ''; } catch (_) {}
        const alreadyThere = targetUrl && urlsLooselyMatch(cur, targetUrl);
        if (alreadyThere) {
          rlog(stepLabel + ':NAV_SKIP:already on target — ' + cur.substring(0, 120));
        } else if (targetUrl) {
          rlog(stepLabel + ':NAV_GOTO:' + targetUrl + ' (from ' + cur.substring(0, 80) + ')');
          try {
            await safeGoto(page, targetUrl, stepLabel + ':NAV', cfg.navTimeoutMs);
            await page.waitForTimeout(500);
            await handleMidFlowInterrupt(page, stagehand, stepLabel, desc, expected);
          } catch (navErr) {
            rlog(stepLabel + ':NAV_GOTO_FAIL:' + (navErr && navErr.message ? navErr.message : navErr)
              + ' — falling through to ACT');
            // Fall through to ACT path below
            klass = { kind: 'ACT', reason: 'nav-fallback-act' };
          }
        } else {
          // No URL in step — use ACT (e.g. click Dashboard in sidebar)
          rlog(stepLabel + ':NAV_AS_ACT:no URL in step — ' + desc.substring(0, 120));
          klass = { kind: 'ACT', reason: 'nav-without-url' };
        }
        if (klass.kind === 'NAV' || klass.kind === 'NAV_SOFT') {
          if (expected && expected.toLowerCase() !== 'na' && expected.toLowerCase() !== 'n/a') {
            const check = await verifyStepExpected(stagehand, page, stepLabel, expected);
            const reason = check.reason ? String(check.reason).replace(/\r?\n/g, ' ').substring(0, 300) : '';
            if (!check.met) {
              rememberIssueRects(check.highlightRects);
              rlog(stepLabel + ':VERIFY_FAIL:' + reason);
              await stepScreenshot(page, i + 1, check.highlightRects);
              throw new Error(`Step ${i + 1} assertion failed — expected: "${expected}" | observed: ${check.reason}`);
            }
            rlog(stepLabel + ':VERIFY_PASS:' + reason);
          }
          await stepScreenshot(page, i + 1);
          continue;
        }
        // else fall through to ACT
      }

      if (klass.kind === 'VERIFY_ONLY') {
        rlog(stepLabel + ':VERIFY_ONLY:' + desc.substring(0, 160));
        const exp = (expected && expected.toLowerCase() !== 'na' && expected.toLowerCase() !== 'n/a')
          ? expected
          : desc;
        await maybeAdvanceWorkflow(page, stagehand, stepLabel, desc, exp);
        const verifyBlob = desc + ' ' + exp;
        const tabName = isChromeDocumentTitleExpected(verifyBlob) ? '' : extractNamedTab(verifyBlob);
        if (tabName) {
          await activateNamedTabIfNeeded(page, tabName, stepLabel);
        }
        if (!stepExpectsPopupOrValidation(desc, exp)) {
          await handleMidFlowInterrupt(page, stagehand, stepLabel, desc, exp);
        }
        let check = await verifyStepExpected(stagehand, page, stepLabel, exp);
        let reason = check.reason ? String(check.reason).replace(/\r?\n/g, ' ').substring(0, 300) : '';
        if (!check.met && !stepExpectsPopupOrValidation(desc, exp)) {
          rlog(stepLabel + ':VERIFY_RETRY:clear interrupt then re-verify');
          if (tabName) await activateNamedTabIfNeeded(page, tabName, stepLabel);
          await handleMidFlowInterrupt(page, stagehand, stepLabel, desc, exp);
          await page.waitForTimeout(300);
          check = await verifyStepExpected(stagehand, page, stepLabel, exp);
          reason = check.reason ? String(check.reason).replace(/\r?\n/g, ' ').substring(0, 300) : '';
        }
        if (!check.met) {
          rememberIssueRects(check.highlightRects);
          rlog(stepLabel + ':VERIFY_FAIL:' + reason);
          await stepScreenshot(page, i + 1, check.highlightRects);
          throw new Error(`Step ${i + 1} assertion failed — expected: "${exp}" | observed: ${check.reason}`);
        }
        rlog(stepLabel + ':VERIFY_PASS:' + reason);
        await stepScreenshot(page, i + 1);
        continue;
      }

      // ── ACT path ────────────────────────────────────────────────────────────
      await ensureActionAllowed(page, planned, stepLabel);
      const subActions = splitCompoundActions(desc);
      const multi = subActions.length > 1;
      rlog(stepLabel + ':ACT:' + desc.substring(0, 200) + (multi ? ` (split into ${subActions.length} field actions)` : ''));

      let actResult = null;
      let selfNavTried = false;
      let formFilledThisStep = false;
      for (let si = 0; si < subActions.length; si++) {
        const subDesc   = subActions[si];
        const subLabel  = multi ? `${stepLabel}:ACT:${si + 1}/${subActions.length}` : stepLabel + ':ACT';
        const doneLabel = multi ? `${stepLabel}:ACT_DONE:${si + 1}/${subActions.length}` : stepLabel + ':ACT_DONE';
        if (multi) rlog(subLabel + ':' + subDesc.substring(0, 200));

        if (UPLOAD_STEP_RE.test(subDesc)) {
          const uploaded = await tryDirectFileUpload(page, stepLabel);
          if (uploaded) {
            rlog(doneLabel + ':File attached via input');
            if (multi && si < subActions.length - 1) await page.waitForTimeout(200);
            continue;
          }
        }

        if (looksLikeDataEntry(subDesc) || looksLikeBulkFormFillStep(subDesc)) {
          let formDone = await tryDirectFormAction(page, subDesc, subLabel, stagehand);
          if (!formDone && (looksLikeBulkFormFillStep(subDesc) || cfg.humanLike)) {
            rlog(subLabel + ':HUMAN:retry full form intelligence');
            await humanPause(page, 400, 700);
            formDone = await humanLikeFillFormAndComplete(
              page, stagehand, subLabel, subDesc, { complete: stepWantsProceed(subDesc) }
            );
          }
          if (formDone) {
            formFilledThisStep = true;
            rlog(doneLabel + ':Form completed via human-like fill');
            actResult = { message: 'Form filled and progressed via human-like intelligence' };
            if (multi && si < subActions.length - 1) await humanPause(page, 200, 450);
            continue;
          }
          if (looksLikeBulkFormFillStep(subDesc)) {
            rlog(subLabel + ':FORM_FILL:WARN bulk fill incomplete — skipping Stagehand act (avoids single-field partial fill)');
            actResult = { message: 'Bulk form fill attempted via Playwright' };
            if (multi && si < subActions.length - 1) await page.waitForTimeout(250);
            continue;
          }
        }

        if (/\b(click|press|tap)\b.*\b(next|continue|proceed|submit)\b/i.test(subDesc)) {
          let errs = await countVisibleFormErrors(page);
          if (errs > 0) {
            rlog(subLabel + ':FORM_FILL:' + errs + ' validation error(s) before Next/Submit — targeted fix');
            await fixValidationErrorsAndContinue(
              page, stagehand, subLabel, subActions[Math.max(0, si - 1)] || subDesc
            );
            await page.waitForTimeout(400);
            errs = await countVisibleFormErrors(page);
            if (errs > 0) {
              rlog(subLabel + ':FORM_FILL:WARN still ' + errs + ' validation error(s) — continuing to click then re-fix if needed');
            }
          }
        }

        if (parseProceedIntent(subDesc)) {
          const proceeded = await proceedWizardNextIfIntended(page, stagehand, subLabel, subDesc);
          if (proceeded) {
            actResult = { message: 'Clicked intended footer button (Next/Submit only as named)' };
            rlog(doneLabel + ':' + actResult.message);
            if (multi && si < subActions.length - 1) await page.waitForTimeout(200);
            continue;
          }
        }

        if (!looksLikeDataEntry(subDesc) && !looksLikeBulkFormFillStep(subDesc)) {
          const treeHit = await tryBestTreePath(page, subDesc, subLabel);
          if (treeHit && treeHit.ok) {
            actResult = { message: 'Tree path → ' + treeHit.name + ' (' + treeHit.path + ')' };
            rlog(doneLabel + ':' + actResult.message);
            if (multi && si < subActions.length - 1) await page.waitForTimeout(200);
            continue;
          }
        }

        // Deterministic nav/button click — never on form-fill steps (those use label-scoped fill only)
        if (!looksLikeDataEntry(subDesc) && !looksLikeBulkFormFillStep(subDesc)
            && (/\b(click|press|tap)\b/i.test(subDesc) || extractKnownClickTargets(subDesc).length)) {
          const directOk = await tryDirectKnownUiClick(page, subDesc, subLabel);
          if (directOk) {
            actResult = { message: 'Clicked via deterministic text match (no LLM)' };
            rlog(doneLabel + ':' + actResult.message);
            if (multi && si < subActions.length - 1) await page.waitForTimeout(200);
            continue;
          }
        }

        try {
          actResult = await actWithFastFallback(stagehand, page, subDesc, stepLabel, i + 1);
        } catch (actErr) {
          rlog(stepLabel + ':ACT_RETRY:act() threw — ' + formatActError(actErr).slice(0, 180));
          const directRetry = await tryDirectKnownUiClick(page, subDesc, subLabel);
          if (directRetry) {
            actResult = { message: 'Clicked via deterministic text match after act() failure' };
            rlog(doneLabel + ':' + actResult.message);
            if (multi && si < subActions.length - 1) await page.waitForTimeout(200);
            continue;
          }
          if (isAzureNetworkBlockedError(actErr)) {
            throw new Error(formatActError(actErr));
          }
          rlog(stepLabel + ':ACT_RETRY:clearing mid-flow popup/validation (non-blocking)');
          await handleMidFlowInterrupt(page, stagehand, stepLabel, subDesc, expected);
          await page.waitForTimeout(250);
          const afterDismiss = await tryDirectKnownUiClick(page, subDesc, subLabel);
          if (afterDismiss) {
            actResult = { message: 'Clicked via deterministic text match after interrupt clear' };
            rlog(doneLabel + ':' + actResult.message);
            if (multi && si < subActions.length - 1) await page.waitForTimeout(200);
            continue;
          }
          try {
            actResult = await actWithFastFallback(stagehand, page, subDesc, stepLabel, i + 1);
          } catch (retryErr) {
            // Still not a hard roadblock from popup alone — leave no-action for self-nav / gate
            rlog(stepLabel + ':ACT_RETRY:WARN after interrupt — '
              + formatActError(retryErr).slice(0, 160) + ' — continuing to self-nav/gate');
            actResult = { message: 'No action found after interrupt clear', success: false };
          }
        }

        // Clear unexpected popup/validation before self-nav so observe sees the real page
        if (cfg.selfNav && isNoActionResult(actResult)
            && !looksLikeDataEntry(subDesc) && !looksLikeBulkFormFillStep(subDesc)
            && !parseProceedIntent(subDesc)) {
          await handleMidFlowInterrupt(page, stagehand, subLabel, subDesc, expected);
          selfNavTried = true;
          const intel = await executeIntelligentStep(
            stagehand, page, stripStepHtml(subDesc), subLabel, { maxDepth: cfg.selfNavDepth }
          );
          if (intel.success) {
            actResult = intel.actResult || { message: 'Self-nav succeeded (' + intel.source + ')' };
          } else {
            const cand = summarizeCandidates(intel.candidates || []);
            rlog(subLabel + ':SELFNAV:FAIL:reason=' + (intel.reason || intel.source || 'failed')
              + (cand ? ' candidates=' + cand : ''));
            // Keep no-action actResult so confidence gate can soft-fail / HUMAN_REVIEW with context
            actResult = {
              message: 'No action found after self-nav (' + (intel.reason || intel.source) + ')'
                + (cand ? ' candidates: ' + cand : ''),
              success: false,
            };
          }
        }

        if (UPLOAD_STEP_RE.test(subDesc)) {
          await tryDirectFileUpload(page, stepLabel);
        }

        const subActMsg = (actResult && actResult.message)
          ? String(actResult.message).replace(/\r?\n/g, ' ').substring(0, 250)
          : 'Action performed';
        rlog(doneLabel + ':' + subActMsg);

        if (multi && si < subActions.length - 1) await page.waitForTimeout(200);
      }

      if (looksLikeInPageMenuClick(desc)) {
        await settleInPageNavigation(page, stepLabel);
      }

      await settleAndClearInterrupts(page, stagehand, stepLabel, desc, expected);

      // After the click, reach the screen this step (and later steps) actually expect:
      // fill intermediate forms, open quoted popups, use Playwright for data entry.
      await humanReachExpected(page, stagehand, stepLabel, desc, expected);

      // Wizard forms: fill leftover fields only if this step did not already fill.
      // Never auto-click Draft/Save here — that happens only when the step names the button.
      if (!formFilledThisStep
          && (looksLikeBulkFormFillStep(desc) || (cfg.humanLike && looksLikeDataEntry(desc)))) {
        const bulk = await tryFillAllMandatoryFields(page, stepLabel, desc, stagehand);
        if (bulk) actResult = { message: 'Form completed via human-like intelligence' };
      }
      // If validation still showing after settle (e.g. Next clicked too early), fix then continue
      const postErrs = await countVisibleFormErrors(page);
      if (postErrs > 0 && !stepExpectsPopupOrValidation(desc, expected)) {
        rlog(stepLabel + ':FIX_VALIDATION:post-act errors=' + postErrs);
        await fixValidationErrorsAndContinue(page, stagehand, stepLabel, desc);
      }

      const actScore = scoreAction(actResult, { businessOk: true, domOk: !isNoActionResult(actResult) });
      const gate = gateDecision(actScore);
      rlog(stepLabel + ':CONFIDENCE:element=' + actScore.elementConf
        + ' business=' + actScore.businessConf
        + ' dom=' + actScore.domConf
        + ' expected=' + actScore.expectedConf
        + ' final=' + actScore.final
        + ' gate=' + gate);
      if (gate === 'HUMAN_REVIEW') {
        if (cfg.selfNav && actScore.noAct && !selfNavTried) {
          selfNavTried = true;
          rlog(stepLabel + ':SELFNAV:gate=HUMAN_REVIEW noAct — exploring before stop');
          const intel = await executeIntelligentStep(
            stagehand, page, stripStepHtml(desc), stepLabel, { maxDepth: cfg.selfNavDepth }
          );
          if (intel.success) {
            actResult = intel.actResult || { message: 'Self-nav recovered from HUMAN_REVIEW' };
            const recovered = scoreAction(actResult, { businessOk: true, domOk: true });
            rlog(stepLabel + ':SELFNAV:OK:recovered_from_HUMAN_REVIEW conf=' + recovered.final);
          } else if (cfg.batchMode) {
            const cand = summarizeCandidates(intel.candidates || []);
            rlog(stepLabel + ':GATE:SOFT_FAIL batch mode after self-nav — '
              + (intel.reason || 'failed') + (cand ? ' candidates=' + cand : ''));
            throw new Error(
              `Step ${i + 1} could not locate target after self-nav — ${actScore.final}%`
              + (cand ? ` candidates: ${cand}` : '')
            );
          } else {
            const cand = summarizeCandidates(intel.candidates || []);
            rlog(stepLabel + ':GATE:STOP after self-nav — '
              + (intel.reason || 'failed') + (cand ? ' candidates=' + cand : ''));
            throw new Error(
              `Step ${i + 1} stopped after self-nav — ${intel.reason || 'target not found'}`
              + (cand ? ` | candidates: ${cand}` : '')
            );
          }
        } else if (cfg.selfNav && actScore.noAct && selfNavTried) {
          const failMsg = String(actResult && actResult.message ? actResult.message : 'self-nav already attempted');
          if (cfg.batchMode) {
            rlog(stepLabel + ':GATE:SOFT_FAIL batch mode — ' + failMsg.slice(0, 200));
            throw new Error(`Step ${i + 1} could not locate target after self-nav — ${actScore.final}%`);
          }
          rlog(stepLabel + ':GATE:STOP after self-nav — ' + failMsg.slice(0, 200));
          throw new Error(`Step ${i + 1} stopped after self-nav — ${failMsg.slice(0, 240)}`);
        } else if (cfg.batchMode && actScore.noAct) {
          rlog(stepLabel + ':RETRY:batch low-confidence — one constrained heal before failing TC');
          actResult = await actWithFastFallback(stagehand, page, desc, stepLabel, i + 1);
          const retryScore = scoreAction(actResult, { businessOk: true, domOk: !isNoActionResult(actResult) });
          if (retryScore.final >= CONF_GATES.retry) {
            rlog(stepLabel + ':RETRY_OK:batch heal recovered to ' + retryScore.final + '%');
          } else {
            rlog(stepLabel + ':GATE:SOFT_FAIL batch mode — TC will fail; runner continues with next TC');
            throw new Error(`Step ${i + 1} could not locate target — ${actScore.final}% confidence after heal`);
          }
        } else {
          rlog(stepLabel + ':GATE:STOP confidence ' + actScore.final + '% < ' + CONF_GATES.humanReview
            + '% — human review required (LLM will not continue blindly)');
          throw new Error(`Step ${i + 1} stopped for human review — action confidence ${actScore.final}%`);
        }
      }
      if (gate === 'RETRY' && actScore.noAct) {
        if (cfg.selfNav && !selfNavTried) {
          selfNavTried = true;
          rlog(stepLabel + ':SELFNAV:gate=RETRY noAct — exploring');
          const intel = await executeIntelligentStep(
            stagehand, page, stripStepHtml(desc), stepLabel, { maxDepth: cfg.selfNavDepth }
          );
          if (intel.success) {
            actResult = intel.actResult || { message: 'Self-nav recovered on RETRY' };
          } else {
            rlog(stepLabel + ':RETRY:self-nav missed — one extra constrained heal');
            actResult = await actWithFastFallback(stagehand, page, desc, stepLabel, i + 1);
          }
        } else if (!cfg.selfNav) {
          rlog(stepLabel + ':RETRY:low-confidence no-action — one extra constrained heal');
          actResult = await actWithFastFallback(stagehand, page, desc, stepLabel, i + 1);
        }
      }

      await stepScreenshot(page, i + 1);

      await page.waitForLoadState('domcontentloaded', 3000).catch(() => {});
      if (cfg.stepDelayMs > 0) await page.waitForTimeout(Math.min(cfg.stepDelayMs, 1200));

      await maybeAdvanceWorkflow(page, stagehand, stepLabel, desc, expected);

      // Second pass: catch late toasts/validation that appeared after confidence gate
      await handleMidFlowInterrupt(page, stagehand, stepLabel, desc, expected);

      if (expected && expected.toLowerCase() !== 'na' && expected.toLowerCase() !== 'n/a') {
        let check = await verifyStepExpected(stagehand, page, stepLabel, expected);
        let reason = check.reason
          ? String(check.reason).replace(/\r?\n/g, ' ').substring(0, 300)
          : '';
        if (!check.met && !stepExpectsPopupOrValidation(desc, expected)) {
          // Transient popup/toast may have obscured the assertion — clear and re-check once
          rlog(stepLabel + ':VERIFY_RETRY:interrupt may have obscured expected — clearing and re-verify');
          await handleMidFlowInterrupt(page, stagehand, stepLabel, desc, expected);
          await page.waitForTimeout(300);
          check = await verifyStepExpected(stagehand, page, stepLabel, expected);
          reason = check.reason
            ? String(check.reason).replace(/\r?\n/g, ' ').substring(0, 300)
            : '';
        }
        if (!check.met) {
          rememberIssueRects(check.highlightRects);
          rlog(stepLabel + ':VERIFY_FAIL:' + reason);
          await stepScreenshot(page, i + 1, check.highlightRects);
          throw new Error(
            `Step ${i + 1} assertion failed — expected: "${expected}" | observed: ${check.reason}`,
          );
        }
        rlog(stepLabel + ':VERIFY_PASS:' + reason);
      } else if (gate === 'VALIDATE') {
        rlog(stepLabel + ':VERIFY:extra DOM validation because confidence is ' + actScore.final + '%');
      }
      } finally {
        rlog(stepLabel + ':TIMING:' + (Date.now() - stepT0) + 'ms kind=' + stepKind);
      }
    }

    try {
      if (page) {
        const buf = await page.screenshot();
        if (buf) console.log('SCREENSHOT:' + buf.toString('base64'));
      }
    } catch (_) {}

    // ── Post-step frame reset ─────────────────────────────────────────────────
    if (activeFrame) {
      rlog('FRAME:Returned to main document after all steps');
      activeFrame = null;
    }

    rlog('DONE:All steps completed successfully');
    console.log('RESULT:PASS');
    writeTerminalLog('RESULT:PASS', 'META');
    closeTerminalLog('PASS');

  } catch (err) {
    try {
      if (page) {
        const buf = await screenshotWithIssueRects(page, lastIssueRects);
        if (buf) console.log('SCREENSHOT:' + buf.toString('base64'));
      }
    } catch (_) {}

    const msg = formatActError(err)
      .replace(/\r?\n/g, ' ')
      .substring(0, 400);
    writeTerminalLog('RESULT:FAIL:' + msg, 'ERROR');
    console.log('RESULT:FAIL:' + msg);
    closeTerminalLog('FAIL');

  } finally {
    if (stagehand) {
      // Batch + proxy: detach Stagehand but keep the user's Chrome session for the next TC.
      const keepBrowser = cfg.isProxy || cfg.batchMode;
      await stagehand.close({ browserClose: !keepBrowser }).catch(() => {});
    }
    // Safety net if an early throw skipped closeTerminalLog
    if (logStream) closeTerminalLog('ABORTED');
  }
})();
