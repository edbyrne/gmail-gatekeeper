/**
 * Gmail Gatekeeper
 * 
 * Filters unknown senders out of your inbox, optionally auto-replies
 * with a Stripe payment link. Lets newsletters and common services through.
 * 
 * SETUP:
 * 1. Go to https://script.google.com → New Project
 * 2. Paste this entire script
 * 3. Click Services (+) → add People API AND Gmail API
 * 4. Click Run → select "setup" → Authorize when prompted
 * 5. Replace STRIPE_LINK with your Stripe Payment Link URL
 * 6. That's it. Runs every 15 minutes automatically.
 *
 * TESTING:
 * 1. Replace TEST_EMAIL with a friend's email address
 * 2. Run "testAutoReply" to send them the template
 * 3. Once happy, set AUTO_REPLY to true to go live
 */

// ============================================================
// CONFIGURATION — edit these values
// ============================================================

const LABEL_NAME = "Unknown Senders";
const SKIP_INBOX = true;
const AUTO_REPLY = false; // set to true when ready to go live
const SKIP_NEWSLETTERS = true; // let emails with List-Unsubscribe headers through
const STRIPE_LINK = "https://buy.stripe.com/YOUR_LINK_HERE"; // replace with your Stripe Payment Link
const TEST_EMAIL = "friend@example.com"; // replace with your friend's email for testing
const YOUR_NAME = "Your Name"; // replace with your name for the auto-reply

// Your personal trusted domains
const WHITELISTED_DOMAINS = [
  // "yourcompany.com",
  // "gmail.com",
];

// Common services — emails from these domains pass through automatically.
// Add or remove as needed.
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

// Addresses we should never auto-reply to
const NO_REPLY_PATTERNS = [
  "noreply", "no-reply", "do-not-reply", "donotreply",
  "mailer-daemon", "postmaster", "bounces", "notifications",
  "notify", "alert", "updates", "news", "info@", "support@",
  "feedback@", "billing@", "invoice@", "receipts@",
];

const AUTO_REPLY_SUBJECT = "Auto-Reply: Filtered Message";
const AUTO_REPLY_BODY = `You have not emailed with ${YOUR_NAME} previously and this email has been filtered out of their inbox.

If you believe this to be in error, send $5 via the link below and your email will be delivered. Response not guaranteed.

${STRIPE_LINK}

(If this is a technical error your $5 will be refunded.)`;

// ============================================================
// CORE FUNCTIONS — no edits needed below
// ============================================================

/**
 * Run this once to create the label and set up the recurring trigger.
 */
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
  
  Logger.log("Setup complete. Trigger created. Label: " + LABEL_NAME);
}

/**
 * Main function — called every 15 minutes by the trigger.
 */
function processNewMessages() {
  const label = getOrCreateLabel_(LABEL_NAME);
  const threads = GmailApp.search("in:inbox newer_than:1h", 0, 50);
  
  if (threads.length === 0) return;
  
  const contactEmails = getContactEmails_();
  const repliedTo = getRepliedSenders_();
  const aliases = getAliases_();
  
  // Combine personal whitelist and common services
  const allWhitelisted = new Set(
    [...WHITELISTED_DOMAINS, ...COMMON_SERVICES].map(d => d.toLowerCase())
  );
  
  for (const thread of threads) {
    const messages = thread.getMessages();
    const latestMessage = messages[messages.length - 1];
    const senderEmail = extractEmail_(latestMessage.getFrom());
    
    if (!senderEmail) continue;
    
    const domain = senderEmail.split("@")[1]?.toLowerCase();
    
    // Skip if sender is you (any alias)
    if (aliases.has(senderEmail.toLowerCase())) continue;
    
    // Skip if domain is whitelisted or a common service
    if (domain && allWhitelisted.has(domain)) continue;
    
    // Skip if sender is in contacts
    if (contactEmails.has(senderEmail.toLowerCase())) continue;
    
    // Skip newsletters (emails with List-Unsubscribe header)
    if (SKIP_NEWSLETTERS) {
      try {
        const rawContent = latestMessage.getRawContent();
        if (rawContent.match(/^List-Unsubscribe:/mi)) continue;
      } catch (e) {
        Logger.log("Could not check headers for: " + senderEmail);
      }
    }
    
    // Unknown sender — apply label and archive
    thread.addLabel(label);
    
    if (SKIP_INBOX) {
      thread.moveToArchive();
    }
    
    // Send auto-reply if enabled
    if (AUTO_REPLY) {
      sendAutoReply_(latestMessage, senderEmail, repliedTo, aliases);
    }
  }
  
  saveRepliedSenders_(repliedTo);
}

/**
 * Sends the auto-reply from the same address the email was sent to.
 * Only sends once per sender. Skips no-reply and bulk mail.
 */
function sendAutoReply_(message, senderEmail, repliedTo, aliases) {
  if (repliedTo.has(senderEmail.toLowerCase())) return;
  
  const senderLower = senderEmail.toLowerCase();
  for (const pattern of NO_REPLY_PATTERNS) {
    if (senderLower.includes(pattern)) return;
  }
  
  // Double-check: don't reply to newsletters either
  try {
    const rawContent = message.getRawContent();
    if (rawContent.match(/^List-Unsubscribe:/mi)) return;
  } catch (e) {}
  
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
  
  const options = {
    htmlBody: AUTO_REPLY_BODY.replace(/\n/g, "<br>"),
  };
  
  if (sendFrom) {
    options.from = sendFrom;
  }
  
  GmailApp.sendEmail(senderEmail, AUTO_REPLY_SUBJECT, AUTO_REPLY_BODY, options);
  repliedTo.add(senderEmail.toLowerCase());
  
  Logger.log("Auto-replied to: " + senderEmail + (sendFrom ? " (from: " + sendFrom + ")" : ""));
}

/**
 * Send the auto-reply template to a friend for testing.
 * Replace TEST_EMAIL at the top of the script first.
 */
function testAutoReply() {
  GmailApp.sendEmail(TEST_EMAIL, AUTO_REPLY_SUBJECT, AUTO_REPLY_BODY, {
    htmlBody: AUTO_REPLY_BODY.replace(/\n/g, "<br>"),
  });
  Logger.log("Test reply sent to: " + TEST_EMAIL);
}

/**
 * Returns a Set of all your send-as aliases (including primary).
 * Requires Gmail API to be added under Services.
 */
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

/**
 * Returns a Set of sender emails we've already auto-replied to.
 */
function getRepliedSenders_() {
  const props = PropertiesService.getScriptProperties();
  const data = props.getProperty("repliedSenders");
  if (data) {
    return new Set(JSON.parse(data));
  }
  return new Set();
}

/**
 * Saves the set of replied-to senders to Script Properties.
 */
function saveRepliedSenders_(repliedTo) {
  const props = PropertiesService.getScriptProperties();
  const arr = Array.from(repliedTo);
  
  if (arr.length > 5000) {
    arr.splice(0, arr.length - 5000);
  }
  
  props.setProperty("repliedSenders", JSON.stringify(arr));
}

/**
 * Clears the replied-to sender list. Run manually if you want
 * the script to re-send auto-replies to previously contacted senders.
 */
function resetRepliedSenders() {
  PropertiesService.getScriptProperties().deleteProperty("repliedSenders");
  Logger.log("Replied sender list cleared.");
}

/**
 * Returns a Set of all email addresses from both "My Contacts"
 * and "Other Contacts" (auto-generated from people you've emailed).
 */
function getContactEmails_() {
  const emails = new Set();
  
  // 1. My Contacts
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
  
  // 2. Other Contacts
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

/**
 * Extracts the raw email address from a "Name <email>" string.
 */
function extractEmail_(fromField) {
  const match = fromField.match(/<(.+?)>/);
  if (match) return match[1].toLowerCase();
  if (fromField.includes("@")) return fromField.trim().toLowerCase();
  return null;
}

/**
 * Gets an existing Gmail label or creates it.
 */
function getOrCreateLabel_(name) {
  let label = GmailApp.getUserLabelByName(name);
  if (!label) {
    label = GmailApp.createLabel(name);
  }
  return label;
}

/**
 * Manual test — run this to process messages on demand.
 */
function testRun() {
  processNewMessages();
  Logger.log("Test run complete. Check your Gmail for the '" + LABEL_NAME + "' label.");
}
