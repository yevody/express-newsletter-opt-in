# Express Newsletter Signup with Double Opt-In (Mailtrap Email API)

A small Node.js newsletter app: visitors subscribe, confirm their address by email (double opt-in), receive project-note editions and can unsubscribe from a private link. Built with Express 5, Node.js 24's built-in SQLite and Zod, it sends confirmation emails through the [Mailtrap Email API](https://mailtrap.io/email-api/?utm_source=github&utm_medium=repo&utm_campaign=express-newsletter-opt-in) Transactional stream and newsletter editions through the Bulk stream, using plain `fetch` with no SDK.

## What it does

Subscribe to occasional project notes. Confirm your email to join; you can unsubscribe using your private link.

The email workflow: send a subscription confirmation link.

## Technologies

- Express 5
- [Mailtrap Email API](https://docs.mailtrap.io/email-api-smtp/overview?utm_source=github&utm_medium=repo&utm_campaign=express-newsletter-opt-in): Transactional stream for confirmations, Bulk stream for editions, called with native `fetch` (no SDK)
- Node.js 24 and its built-in SQLite module for local persistence
- Zod for input validation

## Run locally

Install Node.js 24 or newer in the 24.x release line and npm. The built-in SQLite API is experimental in some Node 24 releases; no database server or native build tools are required.

```sh
npm ci
cp .env.example .env
# Edit .env: set ADMIN_PASSWORD, APP_URL, owner/recipient settings,
# and email credentials using docs/email-setup.md.
npm run dev
```

The app is served at http://localhost:3000. For operator access, choose a unique password of at least 16 characters. You can generate one with:

```sh
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

Use that value in `.env`; the operator username is `admin`. See [email configuration](docs/email-setup.md) for the default provider, development setup, and production settings. To explore locally without credentials, set `MAIL_MODE=log` while running `npm run dev`; resulting messages are written to `.data/emails.jsonl` and are **not sent**. Log mode is disabled when `NODE_ENV=production`.

## Try the workflow

1. Open http://localhost:3000 after starting the application.
2. Complete the form with realistic sample values and submit.
3. Open the link in the resulting email, then confirm the action. Merely opening a link does not consume it.
4. Check `/admin` for the saved record and email state.

Example form values:

```json
{
  "name": "Alex Doe",
  "email": "alex@example.com"
}
```

Private links use hashed random tokens. State-changing token pages require a button press so email link scanners do not accidentally consume them.

## Configuration

| Variable | Meaning |
| --- | --- |
| `APP_URL` | Exact public origin; used for email links and cross-origin checks |
| `ADMIN_PASSWORD` | Operator password, at least 16 characters |
| `OWNER_EMAIL` | Fixed recipient for owner notifications; replace the example address |
| `REVIEWER_EMAIL` | Fixed reviewer for review requests; otherwise unused |
| `DB_PATH` | SQLite file; defaults to `.data/app.sqlite` |
| `HOST`, `PORT` | Production listener settings where supported by the framework |
| `MAIL_MODE` | `sandbox`, `production`, or local-only `log` |

Email credential variables are documented in [email setup](docs/email-setup.md). Frameworks must be restarted after environment changes. Customize the app's public copy, fields, seeded event details, or menu in `src/core/config.js`; Nuxt also uses `app-definition.json` for its client-visible definition. Keep those two definitions consistent when editing.

## Where the main idea lives

- `src/server.js` (routes and middleware) and `views/index.ejs` (page template).
- `src/core/service.js`: the application's workflow, field validation, and atomic state changes.
- `src/core/store.js`: SQLite records, hashed tokens, rate counters, and a small email outbox.
- `src/core/mail.js`: server-side email transport and environment selection.
- `test/workflow.test.mjs`: workflow and permission edge cases.
- `test/email.test.mjs`: transport configuration tests using local doubles.

## Check and build

```sh
npm test
npm run build
npm start
```

Tests exercise the app's business rules and email configuration without sending external mail. They do not prove production delivery. To check actual sending, configure your own credentials and complete the normal workflow with an address you control.

## Email failures

Saving a valid record and recording its intended email happen in one SQLite transaction. Sending happens afterward. An email failure leaves the record intact and appears in the operator page.

```sh
npm run retry-email
```

This retries pending and known-failed messages. `accepted` means accepted by the provider, not confirmed delivery. `logged` means a local preview only. Timeouts or partial HTTP API results are `unknown`; messages interrupted by a process crash may remain `sending`. These states are not automatically retried because a first send may have succeeded. Check provider logs before reconciling them manually.

## Deployment and limits

Run one Node process behind HTTPS with a persistent writable volume for `DB_PATH`. Run the build first, then start with your configured environment. Set `APP_URL` to the real HTTPS origin; do not trust arbitrary forwarded headers. The operator uses HTTP Basic authentication and must be protected by HTTPS outside localhost. This app is not designed for ephemeral or multi-instance serverless storage.

Form submissions are limited to 12 per client per hour and 3 per recipient per hour. Behind a reverse proxy, clients may share the proxy address; configure infrastructure limits before larger deployment. There is no multi-user operator system, payment processing, distributed job queue, or production email webhook tracker.

## FAQ

### How do I add double opt-in to an Express newsletter signup?

The signup is saved as pending with a hashed, random confirmation token, and the subscriber gets an email with a private link. Opening the link shows a button; only pressing it confirms the subscription, so email link scanners can't confirm it by accident. See `src/core/service.js` and `src/core/store.js`.

### How do I send email from Node.js with the Mailtrap Email API without an SDK?

Send a `POST` request with a Bearer token to the Mailtrap Email API. `src/core/mail.js` does this with native `fetch`, a 15-second timeout and a check that every recipient got a message ID:

```js
const response = await fetch('https://send.api.mailtrap.io/api/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.MAILTRAP_PRODUCTION_TOKEN}`
  },
  body: JSON.stringify({
    from: { email: process.env.MAIL_FROM, name: 'Newsletter Opt In' },
    to: [{ email: 'subscriber@example.com' }],
    subject: 'Confirm your subscription',
    text: 'Open this link to confirm: https://example.com/confirm/...',
    category: 'subscriber'
  })
});
const result = await response.json(); // { success: true, message_ids: [...] }
```

### Why are confirmations and newsletter editions sent through different streams?

A confirmation is a transactional email triggered by one person's action, so it goes to `send.api.mailtrap.io`. A newsletter edition goes to many people at once, so it uses the Mailtrap Bulk stream (`bulk.api.mailtrap.io/api/batch`). Keeping them apart protects the reputation of your confirmation emails, and the Bulk stream also manages its own unsubscribe and suppression handling.

### What happens if an email fails to send?

The subscriber record and the pending email are saved in one SQLite transaction before sending, so a failed send never loses a signup. The operator page shows each email's status, and `npm run retry-email` retries failed messages. A batch request can return HTTP 200 while some messages were rejected, so the app checks each result separately.

## License

MIT. See [LICENSE](LICENSE).

### Send project notes

After a subscriber confirms, set `NEWSLETTER_POSTAL_ADDRESS` and open the operator page. Enter a unique edition key, subject and message in **Send project notes**. The edition goes only to confirmed subscribers, up to 100. An edition key can be used once; inspect email status or retry failed messages rather than creating a duplicate edition. See the [email guide](docs/email-setup.md) for stream configuration and unsubscribe behavior.
