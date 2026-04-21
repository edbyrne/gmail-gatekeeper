/**
 * Gmail Gatekeeper — v2
 *
 * Filters unknown senders out of your inbox using a scoring engine that looks at
 * headers, content, sender history, and (optionally) an LLM tiebreaker. Sends
 * an auto-reply with a Stripe payment link. When a sender pays, a Stripe webhook
 * moves their message back to your inbox with a star.
 *
 * What's new vs v1:
 *   - Heuristic scoring engine (instead of all-or-nothing contact check)
 *   - Strict / Balanced / Loose presets
 *   - Calendar invite, bulk-header, role-prefix, transactional-subject detection
 *   - Sender-domain history memory (recurring senders gain trust)
 *   - Previous-thread participation check (on a thread, never emailed → pass)
 *   - Optional Claude Haiku fallback for grey-zone decisions
 *   - Stripe webhook auto-delivery: paid mail returns to inbox with a star
 *
 * SETUP (short version — full guide at gatekeeper.edbyrne.me):
 *   1. New Apps Script project → paste this file → save
 *   2. Add Services: People API, Gmail API
 *   3. Edit the CONFIGURATION block below (or generate via the web configurator)
 *   4. Run `setup` once → authorize
 *   5. (Optional AI) Project Settings → Script Properties → add ANTHROPIC_API_KEY
 *   6. (Optional Stripe auto-deliver) Deploy → New deployment → Web app
 *      → Execute as Me, Access Anyone → run `getWebhookSetup` to see the URL
 *      to paste into Stripe webhooks
 */

// ============================================================
// CONFIGURATION — edit these values
// ============================================================

const YOUR_NAME = "Your Name";
const STRIPE_LINK = "https://buy.stripe.com/YOUR_LINK_HERE";

// How aggressive should the filter be? "strict" | "balanced" | "loose"
const STRICTNESS = "balanced";

// Toggles
const AUTO_REPLY = false;               // reply to unknown senders with Stripe link
const SKIP_INBOX = true;                // archive filtered messages out of inbox
const AUTO_DELIVER_ON_PAYMENT = true;   // Stripe webhook: return paid mail to inbox, starred
const USE_AI_FALLBACK = false;          // Claude Haiku tiebreaker for grey-zone messages

// Personal lists
const WHITELISTED_DOMAINS = [
  // "yourcompany.com",
];
const WHITELISTED_EMAILS = [
  // "specific.person@gmail.com",
];

// Common services — domain (and subdomains) pass through automatically
const COMMON_SERVICES = [
  // Shopping
  "amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr",
  "ebay.com", "etsy.com", "shopify.com", "walmart.com",
  "target.com", "bestbuy.com", "costco.com", "homedepot.com",
  "lowes.com", "wayfair.com", "nike.com", "apple.com",
  // Shipping & logistics
  "fedex.com", "ups.com", "usps.com", "dhl.com",
  "royalmail.com", "dpd.co.uk",
  // Social & professional
  "linkedin.com", "twitter.com", "x.com", "facebook.com",
  "instagram.com", "youtube.com", "reddit.com", "medium.com",
  "substack.com", "github.com",
  // Finance & payments
  "paypal.com", "stripe.com", "venmo.com", "chase.com",
  "bankofamerica.com", "wellsfargo.com", "americanexpress.com",
  "discover.com", "capitalone.com", "schwab.com",
  "fidelity.com", "vanguard.com", "coinbase.com",
  // Travel
  "delta.com", "united.com", "aa.com", "southwest.com",
  "airbnb.com", "booking.com", "expedia.com", "uber.com",
  "lyft.com", "hilton.com", "marriott.com",
  // Utilities & services
  "att.com", "verizon.com", "t-mobile.com", "xfinity.com",
  "spectrum.com",
  // Productivity & tech
  "google.com", "gmail.com", "microsoft.com", "office.com",
  "zoom.us", "slack.com", "notion.so", "dropbox.com",
  "adobe.com", "atlassian.com", "calendly.com",
  "docusign.com", "intuit.com", "turbotax.com",
  // Food & delivery
  "doordash.com", "grubhub.com", "ubereats.com",
  "instacart.com", "seamless.com",
  // Health
  "mychart.com", "onemedical.com", "zocdoc.com",
  // Insurance
  "geico.com", "statefarm.com", "progressive.com",
];

// Auto-reply content
const AUTO_REPLY_SUBJECT = "Auto-Reply: Filtered Message";
const AUTO_REPLY_BODY = `You have not emailed with ${YOUR_NAME} previously and this email has been filtered out of their inbox.

If you believe this to be in error, please send a small payment via the link below and your email will be delivered and starred. Response not guaranteed.

${STRIPE_LINK}

(If this is a technical error your payment will be refunded.)`;

// Testing
const TEST_EMAIL = "friend@example.com";

// ============================================================
// INTERNAL CONSTANTS — no edits needed below
// ============================================================

const LABEL_NAME = "Unknown Senders";

// Sender address prefixes that indicate automated/role mail, not a real person.
const ROLE_PREFIXES = [
  "noreply", "no-reply", "do-not-reply", "donotreply", "no_reply",
  "mailer-daemon", "postmaster", "bounces", "bounce",
  "notifications", "notification", "notify", "alert", "alerts",
  "updates", "news", "newsletter",
  "info", "support", "help", "helpdesk",
  "feedback", "billing", "invoice", "invoices", "receipts", "receipt",
  "order", "orders", "tracking", "shipment", "shipments", "shipping",
  "contact", "hello", "team", "system", "admin", "auto",
  "sales", "press", "media", "marketing",
];

// Never auto-reply to addresses matching these patterns (substring match)
const NO_REPLY_PATTERNS = [
  "noreply", "no-reply", "do-not-reply", "donotreply", "no_reply",
  "mailer-daemon", "postmaster", "bounces", "notifications",
  "notify", "alert", "updates", "news", "newsletter",
  "info@", "support@", "feedback@", "billing@", "invoice@",
  "receipts@", "order@", "orders@", "tracking@", "shipment@",
  "help@", "team@", "system@", "admin@", "auto@", "hello@",
];

// Transactional subject patterns — order receipts, shipping, verification, etc.
const TRANSACTIONAL_SUBJECT_REGEX = new RegExp(
  [
    "\\border\\s*#?\\s*[a-z0-9-]",
    "\\btracking\\s*(number|#|code)",
    "\\breceipt\\b",
    "\\binvoice\\b",
    "\\b(has\\s+)?shipped\\b",
    "\\bdelivered\\b",
    "\\bout\\s+for\\s+delivery\\b",
    "\\bpayment\\s+(confirmation|received|successful)",
    "\\byour\\s+(order|package|payment|subscription|statement|bill|receipt|code|account|shipment)",
    "\\bverify\\s+your\\s+(email|account|phone)",
    "\\bverification\\s+code\\b",
    "\\b\\d{4,8}\\s+is\\s+your\\s+(code|verification)",
    "\\bwelcome\\s+to\\b",
    "\\bconfirm\\s+your\\s+(email|subscription|account)",
    "\\bshipment\\s+(update|confirmation)",
    "\\btwo[\\s-]?factor\\b",
  ].join("|"),
  "i"
);

// Bulk-mail / automated headers. Any of these present = very likely not a person.
const BULK_HEADER_NAMES = [
  "List-Unsubscribe",
  "List-Id",
  "Feedback-ID",
  "Auto-Submitted",
  "X-Auto-Response-Suppress",
  "Precedence",
];

// Scoring thresholds per strictness preset. Higher = more filtering.
const STRICTNESS_THRESHOLDS = {
  strict: 50,
  balanced: 30,
  loose: 15,
};

// If passScore is in [GREY_ZONE_MIN, threshold) the LLM is consulted (if enabled)
const GREY_ZONE_MIN = 10;

// How many prior messages from a domain before it's auto-trusted
const DOMAIN_TRUST_MIN = 5;

// PropertiesService keys
const PROP_KEYS = {
  repliedSenders: "repliedSenders",
  paidSenders: "paidSenders",
  domainHistory: "domainHistory",
  webhookToken: "webhookToken",
  processedStripeEvents: "processedStripeEvents",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  llmCache: "llmCache",
};

// ============================================================
// SETUP
// ============================================================

function setup() {
  getOrCreateLabel_(LABEL_NAME);

  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === "processNewMessages") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("processNewMessages")
    .timeBased()
    .everyMinutes(15)
    .create();

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP_KEYS.webhookToken)) {
    props.setProperty(PROP_KEYS.webhookToken, generateToken_(32));
  }

  Logger.log("Setup complete.");
  Logger.log("  Label: " + LABEL_NAME);
  Logger.log("  Strictness: " + STRICTNESS);
  Logger.log("  Auto-reply: " + AUTO_REPLY);
  Logger.log("  Auto-deliver on payment: " + AUTO_DELIVER_ON_PAYMENT);
  Logger.log("  AI fallback: " + USE_AI_FALLBACK);
  Logger.log("  Trigger: every 15 minutes");
  Logger.log("");
  Logger.log("Next:");
  Logger.log(" - If using AI fallback: open Project Settings → Script Properties and add ANTHROPIC_API_KEY");
  Logger.log(" - If using Stripe auto-delivery: Deploy → New deployment → Web app,");
  Logger.log("   then run getWebhookSetup to see the URL to paste into Stripe.");
}

// ============================================================
// MAIN LOOP
// ============================================================

function processNewMessages() {
  const label = getOrCreateLabel_(LABEL_NAME);
  const threads = GmailApp.search("in:inbox newer_than:1h", 0, 50);
  if (threads.length === 0) return;

  const contacts = getContactEmails_();
  const aliases = getAliases_();
  const paid = getPaidSenders_();
  const domainHist = getDomainHistory_();
  const replied = getRepliedSenders_();

  const threshold = STRICTNESS_THRESHOLDS[STRICTNESS] || STRICTNESS_THRESHOLDS.balanced;

  for (const thread of threads) {
    const messages = thread.getMessages();
    const latest = messages[messages.length - 1];
    const senderEmail = extractEmail_(latest.getFrom());
    if (!senderEmail) continue;

    if (aliases.has(senderEmail)) continue;

    const domain = domainFromEmail_(senderEmail);
    if (domain) updateDomainHistory_(domainHist, domain);

    const { passScore, signals } = scoreMessage_(
      latest, thread, senderEmail, domain, contacts, aliases, paid, domainHist
    );

    let decision = "filter";
    let reason = `score ${passScore} < threshold ${threshold}`;

    if (passScore >= threshold) {
      decision = "pass";
      reason = `score ${passScore} >= threshold ${threshold}`;
    } else if (USE_AI_FALLBACK && passScore >= GREY_ZONE_MIN) {
      const llm = classifyWithLLMCached_(latest, senderEmail);
      if (llm && llm.isPerson === false) {
        decision = "pass";
        reason = `LLM: not-cold-outreach (conf ${llm.confidence}) — ${llm.reason}`;
      } else if (llm && llm.isPerson === true) {
        reason = `LLM: cold outreach (conf ${llm.confidence}) — ${llm.reason}`;
      } else {
        reason = "grey zone, LLM unavailable — default filter";
      }
    }

    Logger.log(
      `[${decision}] ${senderEmail} · ${passScore}pts · ${signals.join(",")} · ${reason}`
    );

    if (decision === "filter") {
      thread.addLabel(label);
      if (SKIP_INBOX) thread.moveToArchive();
      if (AUTO_REPLY) sendAutoReply_(latest, senderEmail, replied, aliases);
    }
  }

  saveRepliedSenders_(replied);
  saveDomainHistory_(domainHist);
}

// ============================================================
// SCORING ENGINE
// ============================================================

function scoreMessage_(message, thread, senderEmail, domain, contacts, aliases, paid, domainHist) {
  const signals = [];
  let score = 0;

  // Strong pass signals (100 pts each)
  if (WHITELISTED_EMAILS.some(e => e.toLowerCase() === senderEmail)) {
    signals.push("whitelist-email");
    score += 100;
  }
  if (contacts.has(senderEmail)) {
    signals.push("contact");
    score += 100;
  }
  if (paid.has(senderEmail)) {
    signals.push("paid-before");
    score += 100;
  }
  if (hasThreadParticipation_(thread, aliases)) {
    signals.push("thread-history");
    score += 100;
  }
  if (score >= 100) return { passScore: score, signals };

  // Whitelisted / common-service domain (50 pts)
  const allowDomains = [...WHITELISTED_DOMAINS, ...COMMON_SERVICES].map(d => d.toLowerCase());
  if (domain && allowDomains.some(w => domain === w || domain.endsWith("." + w))) {
    signals.push("whitelist-domain");
    score += 50;
  }

  // Bulk-mail headers (40 pts)
  if (hasBulkHeaders_(message)) {
    signals.push("bulk-headers");
    score += 40;
  }

  // Calendar invite (40 pts)
  if (isCalendarInvite_(message)) {
    signals.push("calendar-invite");
    score += 40;
  }

  // Role-prefix sender (30 pts)
  if (matchesRolePrefix_(senderEmail)) {
    signals.push("role-address");
    score += 30;
  }

  // Transactional subject (30 pts)
  if (matchesTransactionalSubject_(message)) {
    signals.push("transactional-subject");
    score += 30;
  }

  // Domain frequency trust (25 pts, scaled by strictness)
  const historyCount = domain && domainHist[domain] ? domainHist[domain].count : 0;
  const trustMultiplier = STRICTNESS === "loose" ? 1.5 : STRICTNESS === "strict" ? 0.5 : 1;
  if (historyCount >= DOMAIN_TRUST_MIN) {
    const points = Math.round(25 * trustMultiplier);
    signals.push(`domain-history(${historyCount})`);
    score += points;
  }

  // Unsubscribe link in body (15 pts)
  if (hasUnsubscribeInBody_(message)) {
    signals.push("unsub-body");
    score += 15;
  }

  return { passScore: score, signals };
}

// ============================================================
// SIGNAL HELPERS
// ============================================================

function hasThreadParticipation_(thread, aliases) {
  const messages = thread.getMessages();
  if (messages.length < 2) return false;
  for (const m of messages) {
    const from = extractEmail_(m.getFrom());
    if (from && aliases.has(from)) return true;
  }
  return false;
}

function hasBulkHeaders_(message) {
  try {
    for (const h of BULK_HEADER_NAMES) {
      const v = message.getHeader(h);
      if (v) {
        if (h === "Precedence" && !/\b(bulk|list|junk)\b/i.test(v)) continue;
        return true;
      }
    }
  } catch (e) {
    try {
      const raw = message.getRawContent();
      if (/^List-Unsubscribe:/mi.test(raw)) return true;
      if (/^List-Id:/mi.test(raw)) return true;
      if (/^Feedback-ID:/mi.test(raw)) return true;
      if (/^Auto-Submitted:\s*auto/mi.test(raw)) return true;
      if (/^Precedence:\s*(bulk|list|junk)/mi.test(raw)) return true;
    } catch (e2) {}
  }
  return false;
}

function isCalendarInvite_(message) {
  try {
    const ct = message.getHeader("Content-Type") || "";
    if (/text\/calendar/i.test(ct)) return true;
  } catch (e) {}
  try {
    const attachments = message.getAttachments({ includeInlineImages: false });
    for (const a of attachments) {
      const name = (a.getName() || "").toLowerCase();
      const type = (a.getContentType() || "").toLowerCase();
      if (name.endsWith(".ics") || type.includes("text/calendar")) return true;
    }
  } catch (e) {}
  try {
    const raw = message.getRawContent();
    if (/Content-Type:\s*text\/calendar/i.test(raw)) return true;
    if (/METHOD:(REQUEST|REPLY|CANCEL)/i.test(raw)) return true;
  } catch (e) {}
  return false;
}

function matchesRolePrefix_(senderEmail) {
  const local = (senderEmail.split("@")[0] || "").toLowerCase();
  for (const prefix of ROLE_PREFIXES) {
    if (local === prefix) return true;
    if (local.startsWith(prefix + ".") || local.startsWith(prefix + "-") || local.startsWith(prefix + "_")) return true;
    if (local.endsWith("." + prefix) || local.endsWith("-" + prefix) || local.endsWith("_" + prefix)) return true;
  }
  return false;
}

function matchesTransactionalSubject_(message) {
  const subject = message.getSubject() || "";
  return TRANSACTIONAL_SUBJECT_REGEX.test(subject);
}

function hasUnsubscribeInBody_(message) {
  try {
    const body = message.getPlainBody() || "";
    if (/\bunsubscribe\b/i.test(body)) {
      const idx = body.search(/\bunsubscribe\b/i);
      const window = body.substring(Math.max(0, idx - 200), idx + 200);
      if (/https?:\/\//.test(window)) return true;
    }
  } catch (e) {}
  return false;
}

// ============================================================
// LLM FALLBACK (Claude Haiku)
// ============================================================

function classifyWithLLMCached_(message, senderEmail) {
  const cache = getLlmCache_();
  const key = senderEmail + "|" + sha1_(message.getSubject() || "");
  if (cache[key]) return cache[key];

  const result = classifyWithLLM_(message, senderEmail);
  if (result) {
    cache[key] = result;
    saveLlmCache_(cache);
  }
  return result;
}

function classifyWithLLM_(message, senderEmail) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.anthropicApiKey);
  if (!apiKey) {
    Logger.log("USE_AI_FALLBACK is on but ANTHROPIC_API_KEY is not set.");
    Logger.log("Open Project Settings → Script Properties and add it.");
    return null;
  }

  const subject = message.getSubject() || "(no subject)";
  const body = (message.getPlainBody() || "").substring(0, 1500);

  const prompt =
    "You are classifying incoming email for someone who wants to filter cold outreach " +
    "from strangers out of their inbox, while keeping transactional mail, newsletters, " +
    "calendar invites, and personal correspondence flowing through.\n\n" +
    "Given the message below, decide whether it is a HUMAN STRANGER trying to initiate " +
    "personal or business contact (isPerson = true), versus automated/transactional/" +
    "promotional/notification mail (isPerson = false).\n\n" +
    "From: " + senderEmail + "\n" +
    "Subject: " + subject + "\n" +
    "Body (first 1500 chars):\n" + body + "\n\n" +
    "Reply with JSON only, no prose: " +
    '{"isPerson": boolean, "confidence": number 0-1, "reason": "short phrase"}';

  try {
    const response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() !== 200) {
      Logger.log("LLM error " + response.getResponseCode() + ": " + response.getContentText());
      return null;
    }

    const data = JSON.parse(response.getContentText());
    const text = (data.content && data.content[0] && data.content[0].text) || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    Logger.log("LLM call failed: " + e);
    return null;
  }
}

function getLlmCache_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.llmCache);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function saveLlmCache_(cache) {
  const keys = Object.keys(cache);
  if (keys.length > 500) {
    const trimmed = {};
    keys.slice(-500).forEach(k => { trimmed[k] = cache[k]; });
    cache = trimmed;
  }
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.llmCache, JSON.stringify(cache));
}

// ============================================================
// AUTO-REPLY
// ============================================================

function sendAutoReply_(message, senderEmail, repliedTo, aliases) {
  if (repliedTo.has(senderEmail)) return;
  for (const pattern of NO_REPLY_PATTERNS) {
    if (senderEmail.includes(pattern)) return;
  }
  if (hasBulkHeaders_(message)) return;
  if (isCalendarInvite_(message)) return;

  const toHeader = message.getHeader("To") || "";
  const ccHeader = message.getHeader("Cc") || "";
  const allRecipients = (toHeader + "," + ccHeader).toLowerCase();
  let sendFrom = null;
  for (const alias of aliases) {
    if (allRecipients.includes(alias)) {
      sendFrom = alias;
      break;
    }
  }

  const options = { htmlBody: AUTO_REPLY_BODY.replace(/\n/g, "<br>") };
  if (sendFrom) options.from = sendFrom;

  GmailApp.sendEmail(senderEmail, AUTO_REPLY_SUBJECT, AUTO_REPLY_BODY, options);
  repliedTo.add(senderEmail);
  Logger.log("Auto-replied to: " + senderEmail + (sendFrom ? " (from: " + sendFrom + ")" : ""));
}

// ============================================================
// STRIPE WEBHOOK — auto-deliver paid mail to inbox
// ============================================================

/**
 * Apps Script doPost cannot read request headers, so authentication is a
 * URL query-string token (functionally identical to a pre-shared secret).
 * The token is generated in setup() and surfaced via getWebhookSetup().
 *
 * Defense in depth:
 *   - URL token must match the one stored in Script Properties
 *   - Only `checkout.session.completed` events are processed
 *   - Event IDs are deduped (replay protection)
 *   - Only unarchives messages already in the Unknown Senders label
 */
function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const expectedToken = props.getProperty(PROP_KEYS.webhookToken);
    const providedToken = e && e.parameter && e.parameter.t;

    if (!expectedToken) return jsonResponse_({ error: "webhook not set up — run setup()" });
    if (!providedToken || providedToken !== expectedToken) {
      return jsonResponse_({ error: "unauthorized" });
    }

    let event;
    try {
      event = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonResponse_({ error: "invalid JSON" });
    }

    if (!event || event.type !== "checkout.session.completed") {
      return jsonResponse_({ received: true, ignored: event && event.type });
    }

    const processed = getProcessedStripeEvents_();
    if (event.id && processed.has(event.id)) {
      return jsonResponse_({ received: true, duplicate: true });
    }

    const result = handleStripeEvent_(event);

    if (event.id) {
      processed.add(event.id);
      saveProcessedStripeEvents_(processed);
    }

    return jsonResponse_({ received: true, result: result });
  } catch (err) {
    Logger.log("doPost error: " + err);
    return jsonResponse_({ error: String(err) });
  }
}

function handleStripeEvent_(event) {
  if (!AUTO_DELIVER_ON_PAYMENT) return { skipped: "AUTO_DELIVER_ON_PAYMENT is off" };

  const session = event.data && event.data.object;
  if (!session) return { error: "no session on event" };

  const payerEmail = (
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    ""
  ).toLowerCase();

  if (!payerEmail) return { error: "no customer email on session" };

  const label = getOrCreateLabel_(LABEL_NAME);
  const query = `label:"${LABEL_NAME}" from:${payerEmail}`;
  const threads = GmailApp.search(query, 0, 25);

  const paid = getPaidSenders_();
  paid.add(payerEmail);
  savePaidSenders_(paid);

  if (threads.length === 0) {
    return { payerEmail: payerEmail, threadsMoved: 0, note: "allowlisted, no filtered threads to move" };
  }

  for (const thread of threads) {
    thread.removeLabel(label);
    thread.moveToInbox();
    const msgs = thread.getMessages();
    for (const m of msgs) m.star();
  }

  Logger.log("Auto-delivered " + threads.length + " thread(s) from paid sender " + payerEmail);
  return { payerEmail: payerEmail, threadsMoved: threads.length };
}

function getProcessedStripeEvents_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.processedStripeEvents);
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw)); } catch (e) { return new Set(); }
}

function saveProcessedStripeEvents_(set) {
  const arr = Array.from(set);
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.processedStripeEvents, JSON.stringify(arr));
}

/**
 * Prints the full webhook URL to paste into Stripe. Run this AFTER deploying
 * the script as a web app.
 */
function getWebhookSetup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty(PROP_KEYS.webhookToken);
  if (!token) {
    token = generateToken_(32);
    props.setProperty(PROP_KEYS.webhookToken, token);
  }

  let baseUrl = "";
  try { baseUrl = ScriptApp.getService().getUrl() || ""; } catch (e) {}

  Logger.log("=".repeat(60));
  Logger.log("STRIPE WEBHOOK SETUP");
  Logger.log("=".repeat(60));
  if (!baseUrl) {
    Logger.log("The script is not yet deployed as a web app.");
    Logger.log("1. Click Deploy → New deployment → Web app");
    Logger.log("2. Execute as: Me");
    Logger.log("3. Who has access: Anyone");
    Logger.log("4. Deploy, then re-run getWebhookSetup");
    return;
  }
  const webhookUrl = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "t=" + token;
  Logger.log("");
  Logger.log("Paste this into Stripe → Developers → Webhooks → Add endpoint:");
  Logger.log("");
  Logger.log("  " + webhookUrl);
  Logger.log("");
  Logger.log("Select event: checkout.session.completed");
  Logger.log("Click Add endpoint to save. You're done.");
  Logger.log("");
  Logger.log("Test: in Stripe, click the endpoint → 'Send test webhook' →");
  Logger.log("checkout.session.completed. Check the Executions tab here.");
}

// ============================================================
// CONTACTS / ALIASES / STATE
// ============================================================

function getContactEmails_() {
  const emails = new Set();

  let pageToken = null;
  do {
    const response = People.People.Connections.list("people/me", {
      personFields: "emailAddresses",
      pageSize: 1000,
      pageToken: pageToken,
    });
    if (response.connections) {
      for (const person of response.connections) {
        if (person.emailAddresses) {
          for (const email of person.emailAddresses) {
            emails.add(email.value.toLowerCase());
          }
        }
      }
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  pageToken = null;
  do {
    const response = People.OtherContacts.list({
      readMask: "emailAddresses",
      pageSize: 1000,
      pageToken: pageToken,
    });
    if (response.otherContacts) {
      for (const person of response.otherContacts) {
        if (person.emailAddresses) {
          for (const email of person.emailAddresses) {
            emails.add(email.value.toLowerCase());
          }
        }
      }
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  return emails;
}

function getAliases_() {
  const aliases = new Set();
  aliases.add(Session.getActiveUser().getEmail().toLowerCase());
  try {
    const response = Gmail.Users.Settings.SendAs.list("me");
    if (response.sendAs) {
      for (const alias of response.sendAs) {
        aliases.add(alias.sendAsEmail.toLowerCase());
      }
    }
  } catch (e) {
    Logger.log("Could not fetch aliases (Gmail API may not be enabled): " + e);
  }
  return aliases;
}

function getRepliedSenders_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.repliedSenders);
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw)); } catch (e) { return new Set(); }
}
function saveRepliedSenders_(set) {
  const arr = Array.from(set);
  if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.repliedSenders, JSON.stringify(arr));
}

function getPaidSenders_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.paidSenders);
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw)); } catch (e) { return new Set(); }
}
function savePaidSenders_(set) {
  const arr = Array.from(set);
  if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.paidSenders, JSON.stringify(arr));
}

function getDomainHistory_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.domainHistory);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
function saveDomainHistory_(hist) {
  const keys = Object.keys(hist);
  if (keys.length > 1000) {
    const sorted = keys.sort((a, b) => (hist[b].count || 0) - (hist[a].count || 0)).slice(0, 1000);
    const trimmed = {};
    sorted.forEach(k => { trimmed[k] = hist[k]; });
    hist = trimmed;
  }
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.domainHistory, JSON.stringify(hist));
}
function updateDomainHistory_(hist, domain) {
  const now = Date.now();
  if (!hist[domain]) {
    hist[domain] = { count: 1, firstSeen: now, lastSeen: now };
  } else {
    hist[domain].count = (hist[domain].count || 0) + 1;
    hist[domain].lastSeen = now;
  }
}

// ============================================================
// TEST / MAINTENANCE FUNCTIONS
// ============================================================

function testRun() {
  processNewMessages();
  Logger.log("Test run complete. Check the '" + LABEL_NAME + "' label and the Executions tab.");
}

function testAutoReply() {
  GmailApp.sendEmail(TEST_EMAIL, AUTO_REPLY_SUBJECT, AUTO_REPLY_BODY, {
    htmlBody: AUTO_REPLY_BODY.replace(/\n/g, "<br>"),
  });
  Logger.log("Test reply sent to: " + TEST_EMAIL);
}

/**
 * Confirms ANTHROPIC_API_KEY works by classifying two canned examples —
 * one obvious cold outreach, one obvious transactional.
 */
function testAIClassifier() {
  const apiKey = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.anthropicApiKey);
  if (!apiKey) {
    Logger.log("ANTHROPIC_API_KEY is not set.");
    Logger.log("Open Project Settings → Script Properties and add a property named");
    Logger.log("ANTHROPIC_API_KEY with your key as the value, then run this again.");
    return;
  }

  const samples = [
    {
      from: "jane@randomstartup.io",
      subject: "Quick intro — 15 mins next week?",
      body: "Hi — loved your recent post. I lead BD at RandomStartup and think there's real overlap with what we're doing. Could we grab 15 minutes next week?",
    },
    {
      from: "no-reply@amazon.com",
      subject: "Your Amazon order has shipped",
      body: "Hello, your order #112-3456789-0123456 has shipped and will arrive Tuesday.",
    },
  ];

  for (const s of samples) {
    const fake = {
      getSubject: () => s.subject,
      getPlainBody: () => s.body,
    };
    const result = classifyWithLLM_(fake, s.from);
    Logger.log(s.from + " → " + JSON.stringify(result));
  }
  Logger.log("");
  Logger.log("Expected: jane@ → isPerson=true, no-reply@ → isPerson=false");
  Logger.log("If you see that, your LLM fallback is wired up correctly.");
}

function resetRepliedSenders() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEYS.repliedSenders);
  Logger.log("Replied-senders list cleared.");
}

function resetPaidSenders() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEYS.paidSenders);
  Logger.log("Paid-senders list cleared.");
}

function resetDomainHistory() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEYS.domainHistory);
  Logger.log("Domain history cleared.");
}

function resetLLMCache() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEYS.llmCache);
  Logger.log("LLM cache cleared.");
}

// ============================================================
// UTILITIES
// ============================================================

function getOrCreateLabel_(name) {
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  return label;
}

function extractEmail_(fromField) {
  const match = fromField.match(/<(.+?)>/);
  if (match) return match[1].toLowerCase();
  if (fromField.includes("@")) return fromField.trim().toLowerCase();
  return null;
}

function domainFromEmail_(email) {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

function generateToken_(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function sha1_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, s);
  return bytes.map(b => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
