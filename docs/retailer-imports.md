# Save ideas from shops

Use one **Add an idea** form for a link, photo, screenshot or a few words. The existing retailer reader runs first, including Amazon-specific handling. Gemini is an optional fallback for accessible page content that still needs interpretation; it does not bypass a shop's access block.

## Add a readable link

1. Share the link to the installed Family gifts app on Android, or paste it into **Product link**.
2. The input is kept on this device before lookup. Keep choosing lists or editing while details are read.
3. Review the title, description, variant, photo and optional GBP estimate. Existing edits and deliberately cleared fields are not overwritten.
4. Choose **Save idea** with the correct **Adding as** account shown. This explicitly confirms a new share's author and submits the idea.

Select zero, one or several permitted lists. No selected lists means an unlisted idea. A link-only capture can be saved with a descriptive fallback title. A photo-only capture can use **Photo idea**.

## When a shop blocks the lookup

Keep the original link. Use **Add screenshot**, **Open product page**, or enter what you know manually. No bookmarklet or browser extension is needed.

On Android, take a screenshot in the shop using the phone's normal controls. Return and attach it to the existing idea, or share it to Family gifts. A new incoming screenshot offers **Use this with an existing idea?** when there are eligible unfinished drafts. Choose **Add to** the correct idea or **Start a new idea**. The app never guesses from the most recent child or draft.

Attachment retains the existing link, edits, lists and photos. The temporary incoming draft is retired only after the combined material is stored successfully. If another window holds the editor or the idea has already started sending, both drafts remain available while you resolve it.

Preview the image and optionally choose **Crop or rotate**. **Use cropped image** selects the part that will be used for extraction and the saved attachment. The original remains available to restore while editing. Choose **Fill from image** to send that selected image to Google; selecting a photo alone does not trigger AI.

## Review and correct

- **Undo autofill** reverts the latest untouched inserted fields; subsequent edits and list choices remain.
- A from-price, range, unclear variant or missing currency stays out of the GBP estimate. Foreign prices keep their original currency. An unknown price is not zero.
- A screenshot containing several products can require a crop or item choice.
- A plain photograph may support a provisional description, but does not establish a precise model, price or buying URL.
- An inaccessible Instagram/TikTok post keeps its link and can use a screenshot or pasted caption. This feature does not retrieve private videos or verify new buying links.
- **Paste text** accepts a description or message; **Fill from text** explicitly requests interpretation. The clipboard is not read automatically.
- A permitted duplicate hint offers the existing idea and its lists without preventing a genuinely separate variant.

## Keep unfinished work or save it

**Keep for later** retains an unfinished draft on this device. Reopening, signing in or reconnecting does not publish it. Edits are also saved locally as you work; trust **Draft kept on this device** only after storage succeeds. Keep the original source if storage is full or unavailable.

**Save idea** submits the visible snapshot under a freshly checked account. A known author's explicit offline save waits to send when connected. Without a known author, retain the draft and sign in before explicitly saving. A draft belonging to another author cannot be transferred by signing in as someone else.

The normal flow no longer requires a separate adoption button. Older browser captures and their photo hints remain recoverable. A late lookup cannot rewrite an acknowledged idea, and uncertain saves reuse their original operation to avoid duplicates.

When signing out, **Keep drafts and sign out** preserves unfinished work for its original author. **Send queued ideas, then sign out** sends only ideas already submitted. Cancellation restores the open editor.

## Configure optional Gemini help

Create a personal key in [Google AI Studio](https://aistudio.google.com/apikey), using the Gemini API, and put these server-only settings in the app's local environment file. Creating a Gemini API key in Cloud Console is also supported; it does not require recreating the key in AI Studio. Use the intended personal project, as described in [Google's key documentation](https://ai.google.dev/gemini-api/docs/api-key#cloud-console).

```dotenv
GEMINI_API_KEY=YOUR_PERSONAL_KEY
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_MONTHLY_BUDGET_USD=2.00
GEMINI_EVAL_BUDGET_USD=0.25
```

Restart the app after changing settings. In **Identification**, enable AI help and review the administrator's overall allowance. Ordinary retailer metadata and manual capture remain available when AI is disabled, unconfigured, unavailable or out of allowance. The automatic page-help checkbox can turn off model processing for a capture; the existing page reader still runs.

Each model request reserves US$0.02 conservatively within bounded input/output limits. The smaller available administrator or environment allowance applies. Vision reservations and Gemini reservations share the administrator's overall allowance. Evaluations also count towards the Gemini monthly allowance and have their own smaller cap. Failed, uncertain and interrupted requests retain their reservation; an operation retry never dispatches the same generation twice.

Reservations limit this application's admitted requests, not the entire Google project's bill. Google may require activated billing and a positive prepaid balance even when promotional developer credits are available. An HTTP 402 from Google means the prepaid billing balance needs attention; capturing ideas still works. See [Google billing](https://ai.google.dev/gemini-api/docs/billing) and [API errors](https://ai.google.dev/gemini-api/docs/api-errors).

Only bounded product content or deliberately submitted text/images go to Google. Cookies, sign-in tokens, list names, buyers and unrelated drafts are excluded. Page content is treated as untrusted data, and structured results are validated before use.

## Evaluation

The development checkout includes a versioned synthetic corpus and an opt-in harness. It sends no family gifts or photos and does not fetch the named retailers. Install the development dependencies and load the existing local app environment before running:

```sh
node --env-file=.env --import tsx scripts/evaluate-gemini.ts --live --limit 8 --run-id YOUR_UUID
```

Choose and retain a UUID for each run. Repeating the same run ID reuses results or reports an uncertain prior attempt without redispatching it. Eight new cases reserve at most US$0.16 centrally before provider calls. The harness stops at the first provider failure and reports field denominators, case results, latency and any available usage estimate. It requires AI help to be enabled and a configured administrator; it never signs in as a real user.

The harness runs from the development checkout, not the dependency-pruned production container. Provider billing readiness, model quality and actual Android acceptance are separate from deterministic local tests.

## Previous live retailer checks: 7 November 2026

These are checks of the linked products from this development environment, not a guarantee for every page or future retailer change. For passing links, the image was downloaded and decoded as well as extracted from the page.

| Shop            | Checked product                                                                                                                                                                                               | Direct link result                                                       | Recovery             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------- |
| Smyths          | [Supplied Nintendo console](https://www.smythstoys.com/uk/en-gb/gaming-and-tech/nintendo-switch-2/nintendo-switch-2-consoles/nintendo-switch-2-the-legend-of-zelda-40th-anniversary-edition-console/p/266502) | HTTP 403 before product content                                          | Screenshot or manual |
| The Entertainer | [LEGO Stitch and Scrump 43296](https://www.thetoyshop.com/construction-toys/building-blocks/LEGO-Disney-Stitch-And-Scrump-Construction-Set-43296/p/582531)                                                    | Title, description, image and £50.00 GBP                                 | Screenshot or manual |
| Argos           | [LEGO Concorde 10318](https://www.argos.co.uk/product/3376913)                                                                                                                                                | HTTP 403 before product content                                          | Screenshot or manual |
| LEGO UK         | [Police Car 60312](https://www.lego.com/en-gb/product/police-car-60312)                                                                                                                                       | Title, description, image and £8.99 GBP                                  | Screenshot or manual |
| Hamleys         | [LEGO Stitch 43249](https://www.hamleys.com/legor-disney-stitch-buildable-kids-toy-playset-43249)                                                                                                             | HTTP 403 before product content                                          | Screenshot or manual |
| The Works       | [Doctor role-play set](https://www.theworks.co.uk/p/role-play-toys/playworks-pretend-and-play-doctor-role-play-set/5052089328631.html)                                                                        | Title, image and £7.00 GBP; no description published in product metadata | Screenshot or manual |
| Currys          | [Nintendo Switch 2](https://www.currys.co.uk/products/nintendo-switch-2-10281815.html)                                                                                                                        | HTTP 403 before product content                                          | Screenshot or manual |
| Etsy            | [Wooden train listing](https://www.etsy.com/uk/listing/1395933334/montessori-wooden-train-stacking-sorting)                                                                                                   | HTTP 403 and a site challenge                                            | Screenshot or manual |
| John Lewis      | [Cinderella castle 43283](https://www.johnlewis.com/lego-disney-43283-cinderella-animal-friends-castle-building-toy/p115349819)                                                                               | Title, description, image and £18.74 GBP                                 | Screenshot or manual |

The prior four passing direct imports included image download and decoding. These checks were not repeated for the new UX release. Search-result prices were not substituted for current product evidence.

Automated tests use representative responses for extraction, cropping, review, saving, draft continuation and account/offline recovery. They do not certify every retailer's current content, a real Android share menu or storage survival on a specific phone. Complete [Android acceptance](android-acceptance.md) separately.
