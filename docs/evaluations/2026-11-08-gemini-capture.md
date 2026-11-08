# Gemini capture evaluation

Date: 8 November 2026

The authorised live run used model `gemini-3.5-flash-lite` and the version 1 synthetic corpus. It did not fetch live retailers or send family records, photos, list names, cookies or session tokens.

- Run ID: `edaa6d29-6099-4cdf-8384-2e2cd551e414`.
- Planned cases: eight; attempted: one.
- Outcome: the first case stopped with `provider-http-402` (payment required).
- Fields evaluated: zero. No live accuracy claim can be made.
- Reservation retained: US$0.02. This is a conservative application reservation, not a claim about Google's billed charge.
- Evaluation allowance remaining immediately afterwards: US$0.23.
- The existing administrator allowance was US$1/month, which remains stricter than the US$2 environment setting. No allowance was raised.

The key was sent to the Gemini Developer API using its API-key header. No separate Cloud project override, Vertex AI setting, ambient Google credential or machine-default `gcloud` project was used. Ben's Cloud Console screenshot showed the earlier key bound to `page-content-digester@gift-list-app-513921.iam.gserviceaccount.com` and restricted to the Gemini API. Key metadata has not been independently queried; the later replacement key's project binding is unverified.

Google documents HTTP 402 as depleted prepaid credit. Check the key's associated project's billing setup and developer-credit redemption. A positive prepaid balance can be required before promotional credits apply. See [Gemini API errors](https://ai.google.dev/gemini-api/docs/api-errors) and [billing](https://ai.google.dev/gemini-api/docs/billing).

The harness stops on provider failure and retains its reservation. Repeating this run ID reuses the recorded result without making another generation request. Once billing is confirmed ready, use a new run ID for a fresh evaluation within the remaining allowance.

## Replacement AI Studio key

Ben replaced the environment key with a free-tier AI Studio key and authorised another attempt. Run `5036f6d7-1194-4a45-8cca-5a473b7ef49f` completed all eight synthetic cases using the same model and corpus.

- Cases passed: 7/8; field checks passed: 16/17.
- The current-price case returned a control character instead of the visible pound sign in its price evidence. Validation kept the price unknown rather than inserting an unsupported amount. Its title and currency checks passed. No RRP or basket price was accepted.
- Passing cases covered a labelled screenshot, from-price, foreign currency, ambiguous multi-product screenshot, social text without a price, missing currency and an unlabelled image.
- Request latency ranged from 877 to 2,110 ms.
- Token-based estimated cost totalled US$0.003499 at the configured paid model rates. This is not a billed charge; the key was described as free-tier.
- Conservative reservations totalled US$0.16 for this run; the evaluation allowance remaining was US$0.07. The prior failed run's US$0.02 reservation remains held.

The app was restarted to load the replacement key. No IAM or billing settings were changed. These eight controlled cases establish that the key and request protocol work, with one safe price abstention; they do not certify current retailer pages or general model accuracy.

Deterministic tests validate the request, extraction, first-pass ordering, uncertainty and price rules, budgets and UI journeys using controlled responses. They do not replace live model-quality evaluation or actual Android acceptance.
