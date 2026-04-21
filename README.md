# Gmail Gatekeeper

A free Google Apps Script that filters unknown senders out of your Gmail inbox, lets you charge them to get through via Stripe, auto-delivers paid mail back to your inbox (starred), and optionally uses Claude to classify the grey-zone cases. 10 minutes to set up. Runs forever on Google's servers.

**Live at:** [gatekeeper.edbyrne.me](https://gatekeeper.edbyrne.me) — configurator, setup guide, and downloads.

## What's in this repo

| File | Purpose |
| --- | --- |
| [`gmail-gatekeeper.js`](gmail-gatekeeper.js) | The v2 Apps Script. Paste into `script.google.com`. |
| [`gmail-gatekeeper.v1.js`](gmail-gatekeeper.v1.js) | The original v1 script, preserved for reference / rollback. |
| [`index.html`](index.html) | Landing page + 12-step setup guide. |
| [`config.html`](config.html) | In-browser configurator — toggles, presets, then downloads a personalised script. |

## Quick start

1. Open [`config.html`](config.html) (hosted at [gatekeeper.edbyrne.me/config](https://gatekeeper.edbyrne.me/config.html)).
2. Pick a strictness preset, add your Stripe link and name, toggle the features you want, click **Download**.
3. Follow the 12-step setup in [`index.html`](index.html) — paste into Apps Script, add services, run `setup`, (optionally) deploy as a web app and wire up the Stripe webhook.

## What's new in v2

- **Scoring engine** — replaces v1's all-or-nothing contact check. Each signal contributes pass-points; three strictness presets (Strict/Balanced/Loose) decide the cutoff.
- **Signal coverage** — thread-history participation, bulk-mail headers (`List-Unsubscribe`, `List-Id`, `Feedback-ID`, `Precedence`, `Auto-Submitted`), calendar invites, role-prefix senders (`info@`, `noreply@`, `orders@`…), transactional subject patterns, sender-domain frequency trust, body-unsubscribe links.
- **Stripe auto-deliver** — webhook moves paid mail back to inbox with a ⭐ star and permanently allowlists the sender.
- **AI fallback** — opt-in Claude Haiku classifier for grey-zone messages. Bring your own Anthropic API key. Cached per-sender so repeat conversations cost nothing.
- **Web configurator** — non-technical users never touch the script source.

## How filtering works

Every 15 minutes the script scans the past hour of inbox mail. Each sender earns pass-points:

| Signal | Points |
| --- | --- |
| In your contacts / thread history / paid-before allowlist | +100 |
| Whitelisted domain or built-in common service | +50 |
| Bulk-mail headers | +40 |
| Calendar invite | +40 |
| Role-prefix sender (`info@`, `noreply@`, `orders@`…) | +30 |
| Transactional subject (`Your order`, `Tracking #`, `Receipt`…) | +30 |
| Sender domain seen ≥ 5 times before | +25 |
| Unsubscribe link in body | +15 |

Pass threshold: Strict = 50, Balanced = 30, Loose = 15. Messages in the grey zone (10 ≤ score < threshold) get sent to Claude Haiku if `USE_AI_FALLBACK` is on. Every decision logs its signals to the Apps Script Executions tab for auditing.

## Stripe auto-deliver

Since Apps Script's `doPost(e)` doesn't expose request headers, the webhook is authenticated by a 32-char token in the URL query string (pre-shared secret model). Defense in depth:

- Token must match the one stored in Script Properties (generated at `setup()`)
- Only `checkout.session.completed` events are processed
- Event IDs are deduped (replay protection)
- Only unarchives messages already in the `Unknown Senders` label — cannot be tricked into moving arbitrary inbox mail

Run `getWebhookSetup` after deploying as a web app to get the exact URL to paste into Stripe.

## Hosting

The site is static, so GitHub Pages works with zero config:

1. Push this repo to GitHub.
2. **Settings → Pages → Source:** `main` branch, `/` root.
3. Optional custom domain: add a `CNAME` file with your domain and the matching DNS record.

## License

MIT — see [`LICENSE`](LICENSE).
