# Email configuration

Mailtrap is the default email service. Newsletter Opt In uses the HTTP Sending API. Credentials stay on the server; the repository contains no account credentials.

## Development and staging

Copy `.env.example` to `.env`. Keep `MAIL_MODE=sandbox`, set `MAIL_FROM`, `MAILTRAP_SANDBOX_TOKEN`, and numeric `MAILTRAP_INBOX_ID` from the Sandbox API integration page. The ordinary app workflow sends to `https://sandbox.api.mailtrap.io/api/send/{inbox_id}`; messages are captured in that Sandbox. Disable forwarding when external delivery is not intended.

## Production

Verify your sending domain, set `MAIL_MODE=production`, `MAIL_FROM` on that domain, and `MAILTRAP_PRODUCTION_TOKEN` with sending permission. Transactional mail uses `https://send.api.mailtrap.io/api/send`. Both environments use Bearer authentication over HTTPS. Restart after changing configuration. Replace operator/reviewer addresses if used by this app.

## Message details

Each content send includes a workflow `category`, plain text and escaped HTML. `custom_variables` carries the stored record ID and workflow for finding the message in provider logs; it does not render template text. `X-Workflow-Reference` supplies the same reference as a custom header. A contact or review message uses `reply_to` when the workflow has a reply address. No extra recipients are added to an email for demonstration purposes.

## Previews and failures

`MAIL_MODE=log` with `npm run dev` writes private JSON previews to `.data/emails.jsonl`; it makes no network call and is disabled in production. Keep these files private because they can contain addresses and action links.

A provider acceptance response must contain `success: true` and a message ID for each recipient. Accepted means submitted to the provider, not delivered to the inbox. Missing credentials and explicit rejection remain visible as failed; correct configuration and run `npm run retry-email`. Timeouts, server errors, malformed replies, and interrupted sends stay unknown or sending. Inspect provider logs before deciding how to reconcile them; they are not resent automatically. Retries are operator initiated, including rate-limit rejections; wait for the provider's cooldown before retrying.

Existing SMTP settings are no longer read. When upgrading an earlier copy, replace Sandbox username/password with the API token and Sandbox ID; production retains `MAILTRAP_PRODUCTION_TOKEN`. Old queued content messages can still be sent.

Reference: [Sending API](https://docs.mailtrap.io/developers), [official API schemas](https://github.com/mailtrap/mailtrap-openapi), [custom variables](https://docs.mailtrap.io/email-api-smtp/advanced/custom-variables).

Related pending messages are sent with `/api/batch` in groups of at most 20, with one private recipient per request. Each response is matched to its original outbox row; a rejected entry does not cause successful entries to be retried. Single remaining messages use `/api/send`.

## Project-note editions

Set `NEWSLETTER_POSTAL_ADDRESS`, then use **Send project notes** on the protected operator page. Give each edition a unique key such as `october-notes`; posting the same key again is rejected even after an ambiguous send. Only confirmed subscribers are selected, with a 100-person limit to keep this application small. Each recipient gets their own personalized request and local unsubscribe link. That link uses a confirmation POST, so merely opening it cannot unsubscribe someone.

Confirmations use the transactional stream. Editions use `https://bulk.api.mailtrap.io/api/batch` (or `/api/send` for one recipient); Sandbox keeps using its capture endpoints. Ensure the token has bulk sending permission. The bulk provider also manages its own suppression/unsubscribe behavior. A provider unsubscribe does not update the local subscriber count, but the provider suppresses future bulk sends to that address. Local unsubscribes cancel any pending or explicitly failed editions for that subscriber; messages already submitted to the provider cannot be recalled.

An HTTP 200 batch can contain rejected items. Inspect each outbox status; `npm run retry-email` retries only failed entries, rechecking local consent. Never issue a new edition key just to retry an existing edition. This app has no campaign scheduler or delivery webhook consumer.
