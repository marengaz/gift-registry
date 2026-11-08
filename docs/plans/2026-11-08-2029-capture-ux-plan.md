# Gift capture UX plan

Created: 2026-11-08

Status: proposed UX contract for review. This document does not authorise implementation, provider calls or paid evaluations. It plans the capture experience; the existing household product contract continues to govern catalogue access, buying and list permissions.

## Outcome

Ashleigh or Ben can keep a gift idea in a few moments, wherever they find it. A readable product link should usually need only a list choice and Save. An inaccessible link, an uncertain product or a missing price must never make the idea impossible to keep.

The app always makes three things clear: which single idea is being edited, whether it is safe on this device, and whether it has actually joined the family catalogue.

## Constraints carried forward

- One administrator, Google sign-in and the existing contributor, buyer and viewer permissions remain in force.
- A product can be added to several lists without becoming several catalogue products. Saving with no lists puts it in the permitted unlisted inbox.
- One sparsely populated form replaces competing capture methods. Link, text and images are evidence for that same idea. (session-settled: user-directed — chosen over separate capture sections because the sections made it unclear how many ideas were being saved.)
- Remove the bookmarklet from the active experience. Use Gemini for generic extraction from accessible page content, pasted text and deliberately submitted images. (session-settled: user-directed — chosen over maintaining the browser bookmarklet after its setup and blocked-page trade-offs were discussed.)
- Gemini uses the Gemini Developer API, not Vertex AI. Credentials remain on the server. Ordinary capture remains available without AI.
- Save credentials first; wait for Ben's explicit go-ahead before implementation and live evaluation. The proposed environment variables are GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MONTHLY_BUDGET_USD and GEMINI_EVAL_BUDGET_USD; the proposed model is gemini-3.5-flash-lite. Credentials and entitlement have not been inspected for this plan.

## 1. One screen, with progressive detail

Use Add an idea for a new capture and Continue idea for an unfinished one. Do not make the person choose a capture mode, retailer or model before they can start.

Suggested phone layout, with real labels rather than final styling:

```text
Add an idea
A link, a photo or a few words is enough.

Link                                      optional
[ Paste a product or social link                 ]
[ Add photo or screenshot ]  [ Paste text ]

[ thumbnail ]  Details found / contextual help

Name                                      optional
[ LEGO Stitch and Scrump                         ]
Description                               optional
[ Short product description / your own notes     ]
Price (£)                                 optional
[ 50.00 ]
Used for list totals. Check the edition and price.

Lists
[ Luke's Christmas ✓ ] [ Kate's birthday ] [ Find list ]
No list selected: keep in your unlisted ideas.

More details ▸

Draft kept on this device · Adding as Ben
[ Keep for later ]                 [ Save idea ]
```

- The image is a preview of this idea, not a separate card to save. Editing fields updates the same draft.
- Show edition, size or colour close to the name when found; put the empty optional variant control under More details.
- More details contains labels, extra shopping links, original sources, observed foreign prices and lookup dates. It does not contain another Save action.
- Keep the primary action reachable on a phone without covering content, the keyboard, errors or image controls. Desktop can use a restrained preview beside the same form.
- Allow zero, one or several permitted lists. Opening capture from a list preselects that list when current access permits. General capture must not silently reuse the last child's list.
- A link, an image or meaningful text is enough to save. If no name was supplied, use an honest fallback such as Idea from Smyths or Photo idea. Never force a made-up product name.
- Buyer and viewer accounts retain their existing access boundaries. Their ability to retain a local capture does not grant permission to publish it to a list.

## 2. Normal product-link journey

1. Share a retailer link to Family gifts, or paste it into Link. Keep the original input locally before network work.
2. Show a small Reading product details… status. Leave the form usable: the person can select lists, type or save while lookup runs.
3. Retrieve available product metadata first. If the page is accessible but incomplete or irregular, use bounded page content with Gemini when AI is enabled for this account and within the allowance. Do not send every page to AI unnecessarily.
4. Fill only empty, untouched fields. Add a quietly labelled Details from shop status and preserve the source and retrieval time under More details. Model interpretation of page content must not be presented as a fresh independently verified shop quote.
5. The person checks the item and variant, chooses lists and taps Save idea.
6. After server acknowledgement show Saved to Luke's Christmas with View idea and Add another. If several lists were chosen, say One idea added to 2 lists. If none, say Saved to unlisted ideas.

Do not show a success tick before details arrive or before the catalogue save is acknowledged. There is no minimum spinner duration and no invented percentage progress.

## 3. Blocked link: preserve the idea and ask for one useful thing

Use a single inline notice below the source input:

> We couldn't read this shop page. Your link is kept. Add a screenshot showing the product and price, or save the idea as it is.

Actions: Add screenshot, Open product page, and an unobtrusive Paste details option. Save idea and Keep for later remain available. Do not expose HTTP 403, bot protection, model errors or infrastructure jargon in the main message.

Distinguish a known access block from a temporary timeout. A timeout can offer Retry; a known block must not repeatedly retry automatically or spend money asking Gemini to interpret the block page. A changed source or explicit retry starts a new bounded attempt.

### The complete Android recovery journey

1. Ashleigh shares a Smyths link into Family gifts. The link is kept in one device draft and the screenshot prompt appears.
2. She taps Open product page and takes a screenshot using Android's normal screenshot controls. The app does not promise to take a screenshot of another app itself.
3. She returns to the existing draft and attaches the screenshot, or shares the screenshot directly to Family gifts from Android's screenshot preview/gallery.
4. A second share is initially held safely as new incoming material. If there are relevant unfinished ideas, show Use this with an existing idea? with a short, entitled shortlist: thumbnail, name/source, and time. Offer Add to the Smyths idea and Start a new idea. Never attach automatically to the most recent draft or infer the child from timing.
5. If she chooses the existing idea, append the new evidence and keep its link, fields and lists. Retire the temporary incoming draft only after the combined draft and files are durably committed. Failure leaves both recoverable. Do not create a catalogue product during this operation.
6. She previews the image, optionally crops it, and chooses Fill from image. The extracted details populate the same form, then she saves once.

Show only drafts accessible to the current account and unbound device captures under the existing device rules. A second account must not see another author's draft previews. Account changes recheck eligibility before attachment. If a target draft is open in another tab or already being submitted, keep the new material and offer to return after that operation finishes; do not bypass locks or rewrite a frozen upload.

A screenshot can be shared first without a preceding link. No recovery chooser is shown when there is no relevant entitled unfinished idea. Never make returning to an old draft a prerequisite for starting a genuinely new idea.

## 4. Images, text and social posts

### Screenshot or photograph

- Preserve the original capture locally and show a preview before sending image content to Google. Attaching a photo alone must not silently trigger AI processing.
- Offer optional crop/rotate and a short explanation: Only the image you submit will be sent to Google to fill the details. The first-use explanation can be expanded; it is not a repeated modal on every action.
- Fill from image submits the selected image/crop. Display a loading state on that action, leaving Save available. Retain a useful extraction image as evidence; it does not need to be the eventual catalogue thumbnail.
- For a screenshot with one obvious product, fill observed fields. For several products or prices with no clear main item, ask Which item? using a small selection or crop step. Do not mix one product's name with another's price. Batch creation is out of scope.
- For an ordinary shop photo without a visible label, a broad description is useful; an exact product identification is only a labelled suggestion. Never invent a brand, SKU, price or buying URL from appearance alone.
- Prefer a validated product image from the supplied shop page for the thumbnail. Otherwise use the submitted image or an optional user-selected crop. Do not make choosing a clean thumbnail compulsory.
- Keep original material recoverable if cropping/conversion fails. Explain actual file-format and size failures with a usable route to a smaller JPEG, PNG or WebP copy. HEIC/AVIF support must be checked against the deployed decoder, not inferred from the file picker.
- When a person crops an image, use that crop for extraction and the saved attachment. Keep the original locally for recovery while editing; do not upload cropped-away personal content to Google or the catalogue unless the person explicitly chooses the original.

### Pasted or shared text

- Paste text is a secondary source control inside the same form; never read the clipboard on page load.
- Keep original text as evidence. Extract a clearly included URL and offer Fill from text when interpretation would help. Short typed notes need no model call.
- If incoming material includes a link and text/images, retain all of them in one incoming capture. They do not produce independent products.

### Instagram, TikTok and similar links

- Keep the original post link. Read only content actually available to the server; do not imply access to private posts, another app's screen or a complete video from its URL.
- Use an accessible caption or metadata only as evidence. A social caption does not establish an exact shop price or variant.
- If there is insufficient evidence, use the screenshot flow. Keep a short manual name/description and Save available even if nothing can be identified.
- Live buying-link search is a separate, later feature. Do not present model-generated URLs as verified retailers or imply that screenshot extraction already performs reverse-image or reverse-video search.

## 5. Extraction and correction rules

| Situation                                                     | Required behaviour                                                                                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field was empty and untouched                                 | Fill from a validated result for the current source and draft revision.                                                                                                             |
| User entered, edited or deliberately cleared a field          | Preserve it. Offer an explicit field-level suggestion if a later result differs.                                                                                                    |
| Name or description is inferred rather than visible           | Label it Suggested; keep it editable. A confidence percentage is not evidence.                                                                                                      |
| Exact GBP product price and variant are evidenced             | Prefill Price (£), recording where and when it was observed.                                                                                                                        |
| From-price, price range, conflicting price or unclear variant | Keep Price (£) unknown; show the observed wording separately, e.g. Shop shows from £49.99.                                                                                          |
| Foreign price                                                 | Keep the original amount and currency in shopping details; leave the GBP estimate blank unless the user supplies one.                                                               |
| Missing price                                                 | Show Unknown, not £0.00. A genuinely evidenced zero remains zero.                                                                                                                   |
| Saved product or list estimate already exists                 | Never silently change it from a new lookup. Offer explicit field selection and confirmation.                                                                                        |
| Photo was replaced or removed while lookup was running        | Do not attach the old result, even when its response body arrives late or the new draft has the same URL.                                                                           |
| Source, draft, selected image, account or access changed      | Invalidate inappropriate in-flight results and recheck authority before applying anything.                                                                                          |
| User saves while lookup is running                            | Save the visible snapshot. Do not delay Save for AI or mutate the acknowledged idea afterwards. A dispatched provider request may still cost money even if its result is discarded. |

Provide Undo autofill for the latest applied result. It reverts only that result's unchanged inserted fields; it cannot erase subsequent user edits, manual photos or list selections. Reopening a kept draft must preserve those ownership and revision rules.

When another input is attached, retain previous source evidence. Link and image are independent inputs for the same idea; changing the source invalidates stale lookup results without silently deleting useful retained material.

## 6. Saving, identity and unfinished drafts

### Keep for later

This retains an unfinished idea on the current device, including inputs, edits and lists. Return to the previous in-app page when available, otherwise Drafts; returning to the external shop uses normal browser or Android navigation. It does not queue a catalogue save. Show Kept on this device with Continue idea. Draft persistence must finish before showing that confirmation or closing the editor.

Also save edits locally as the person works, with a truthful Draft kept on this device indicator after successful storage. Local autosave must never be interpreted by reconnect workers as permission to publish.

### Save idea

- This is the explicit decision to add the visible idea to the catalogue. For a freshly verified contributor account, show Adding as Ben next to the action. That click can confirm ownership of a new unbound share and submit it; do not require a separate Adopt this draft step in the normal flow.
- This simplification changes the presentation, not the authority checks. Never bind from a remembered account alone. Verify the current Google identity and list grants, freeze the exact confirmed payload, retain a stable operation ID, and upload only under its confirmed author.
- If the person is signed out or identity cannot be checked, keep the draft and offer Sign in to save. Signing in must return to the same draft and require an explicit Save with the resulting account visible; sign-in alone does not publish it.
- A draft already bound to another author remains that author's. Do not offer to transfer it to the current account through the new shortcut. Existing failed-upload recovery preserves its frozen payload and operation ID.
- With a known author offline, Save idea can queue the explicit save for later. Say Saved on this device — will send when online. With no verified author, Keep for later is available and later sign-in/Save remains explicit.
- Ignore double taps and reconcile uncertain acknowledgements without creating a second product. A permission change or lost response leaves the idea recoverable rather than claiming success.

### Navigation and status

Use a quiet Drafts entry with a count. Each row has a thumbnail, name/source and a meaningful status: Draft, Waiting to send, Needs sign-in, Needs attention, or Saved. Drafts require an explicit Save; Waiting to send represents a previously authorised catalogue save. They must never share a vague Waiting to synchronise label.

Do not use unbound, lease, acknowledgement, operation ID or adopt in routine UI. Keep technical detail available for diagnostics. Sign-out/account-switch protection and local-storage failure messages remain explicit.

If storage is full, do not claim Draft kept or Keep for later success. Retain the current editor and original share where possible, explain how to recover, and protect against destructive navigation. First-ever offline use and browser storage eviction cannot be promised away.

## 7. Duplicate help and multiple lists

- When a strong source/product match is found within data the person may see, show This idea is already saved with View idea and, where authorised, Add to another list. Allow Save as a separate idea for a genuinely different variant or intended duplicate.
- Do not block saving on a fuzzy title/image similarity or a slow duplicate check. Preserve the source and variant so a later correction is possible.
- Do not reveal another account's private idea, lists, purchase allocation or inaccessible memberships through duplicate hints.
- Matching screenshot material to a local draft and detecting an existing catalogue product are different operations. The former should be completed before any publishing decision; neither silently combines private or conflicting records.

## 8. AI settings, privacy and unavailable service

- Put AI configuration and allowance controls in administrator settings. The ordinary form exposes useful actions and statuses, not models, keys or token prices.
- After configuration, the administrator can enable automatic help for accessible product links. Give users a concise first-use explanation that product content may be sent to Google and provide a per-capture manual-only option before model dispatch. Image/text submissions use their explicit Fill action. Never dispatch model requests before current membership is verified.
- Send bounded relevant product content, selected image/crop and source URL. Do not send Google sign-in tokens, cookies, whole browsing sessions, family list names, buyer information, unrelated drafts or image metadata.
- Validate structured output in the app; unknown or unsupported evidence stays unknown. Page content is untrusted data, not permission to follow instructions or call tools.
- Use the proposed $2 monthly allowance and $0.25 evaluation sub-allowance as initial configurable values, not an assertion that Google enforces those caps. Admission must reserve enough estimated cost atomically before dispatch; retries and ambiguous provider responses must not create unbounded spend.
- If the key is missing, AI is disabled, the allowance is exhausted or the provider is unavailable, explain briefly and keep manual capture working. An exhausted allowance is not a general app error and must not hide the form.
- Offline AI actions say Go online to fill details. Do not silently send previously selected image content on reconnect or refresh; the person can resume its explicit Fill action. A previously authorised catalogue save can still synchronise independently.

## 9. Accessibility and responsiveness

- Keep persistent labels, appropriate input types and visible keyboard focus. Make source actions and list choices usable with screen readers and a keyboard.
- Statuses use text as well as colour. Announce a concise completion/error through a status region without reading every inserted field or moving focus away from typing.
- The return-from-shop/share chooser has a clear title, thumbnails with meaningful labels, Start a new idea, keyboard focus handling and an escape/close route that keeps incoming material.
- Support narrow phone widths, zoom, larger text and the onscreen keyboard. Do not put destructive controls next to the sticky Save action.
- Avoid blocking modals for ordinary partial extraction, missing price, duplicate suggestions or budget exhaustion. Crop/item selection is contextual and cancellable without losing the draft.

## 10. Delivery order

This is a product/UX sequence, not an execution authorisation or a substitute for the implementation plan.

1. Establish durable unfinished-draft versus authorised-save behaviour, truthful statuses and the single-screen actions. This is prerequisite to automatic help and a less cumbersome ownership flow.
2. Add Gemini extraction for accessible links and deliberately submitted screenshot/text inputs, with evidence-aware fill, manual-edit protection, cancellation and bounded costs. Keep ordinary retailer metadata as the first pass.
3. Complete the real Android blocked-link → screenshot → continue-same-idea journey, including the second-share chooser, durable attachment, preview and basic crop. This belongs in the initial release of the new workflow, not a distant enhancement.
4. Finish field-level conflict/undo behaviour, account and offline recovery, permitted duplicate hints and accessibility checks. Remove the bookmarklet entry point, help and active documentation when this replacement is ready. Existing browser-created drafts must remain recoverable; old bookmark invocations must fail safely or offer a clear retirement message rather than overwrite anything.
5. Separately consider live product matching and buying-link search from ambiguous photos/social media. Do not delay the reliable capture release or label this future work as implemented.

## 11. Acceptance and evaluation

| Journey / risk                                                             | Passing result                                                                                                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Readable retailer link                                                     | Source retained, usable details filled, list selection remains available, one explicit Save creates one idea.     |
| Smyths block then screenshot                                               | One continued draft retains the original URL, selected lists and edits; no duplicate idea or orphaned lost image. |
| Screenshot shared first                                                    | Preview and optional crop precede Google submission; meaningful extracted fields appear in the same editor.       |
| Several products / sale prices / recommended cards                         | Main product is identified or user is asked; unrelated/cart/RRP prices never become an exact current estimate.    |
| Plain product photo                                                        | Helpful provisional description; no unsupported exact name, price or purchase URL.                                |
| Instagram/TikTok inaccessible link                                         | Link and notes remain usable; screenshot/manual recovery works; no claim of private-video access.                 |
| User types or deliberately clears a field during lookup                    | Their decision survives completion, retry and Undo autofill.                                                      |
| Replace/remove image; switch draft/source/account during response body     | Stale content cannot attach or mutate another idea.                                                               |
| Keep for later; close/reopen; reconnect                                    | Original author and files retained, no catalogue publish, a clear Continue action.                                |
| Save while offline, then restart/reconnect                                 | Authorised save synchronises once; unfinished drafts still do not synchronise.                                    |
| Unbound share; sign in or switch account; reload before Save               | No publication or cross-author access before fresh-account explicit Save.                                         |
| Save during lookup; double tap; lost acknowledgement                       | Visible snapshot saved once; late lookup never rewrites the acknowledged product.                                 |
| Missing key / AI disabled / allowance depleted / provider timeout          | Manual capture remains available; a useful next step replaces a dead end.                                         |
| Two requests compete for remaining allowance                               | Only adequately reserved work dispatches; restart/retry does not spend the same remaining allowance twice.        |
| Foreign / from / unreadable / genuinely zero price                         | Correct currency/uncertainty preserved; list totals never acquire a made-up GBP amount.                           |
| Quota failure, invalid image, cancelled crop, interrupted draft attachment | No false local-save confirmation or destructive loss of the original inputs.                                      |
| Duplicate hint under restricted access                                     | Only authorised data is disclosed; different variants can be kept separate.                                       |
| Real Android share target and absent installation                          | Actual phone share/return flow works when installed; paste/upload remains clear when it is not.                   |

Before authorised live evaluation, assemble a small versioned, non-family fixture set covering the nine previously audited shops plus Amazon, screenshots, social captures, from-prices, multi-variant pages, foreign currencies and deliberately unreadable inputs. Ground truth marks values as observed, unknown or ambiguous; do not score an abstention on ambiguous evidence as a hallucination.

Start with deterministic browser/HTTP fixtures and ownership/offline regressions. Live model evaluation then measures field accuracy, unsupported assertions, exact-price/variant mistakes, abstention, manual corrections, latency and billed cost. Treat invented exact prices, cross-product prices, cross-account leakage, duplicate publication and unbounded spend as release blockers. Record denominators and individual failures; a small fixture set does not certify every retailer.

Assess the experience on Ashleigh's actual Android phone with a readable link, the supplied Smyths link, a screenshot-first idea and a saved offline capture. Observe whether she understands what is kept, which list is selected, whether an idea was published, and how to resume it without coaching. Automated desktop tests do not establish Android acceptance.

## Existing foundations and changes to plan next

Current code was inspected; no implementation or tests were run for this UX plan.

| Existing area                                                                                                                                                                        | Consequence for implementation planning                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/components/CaptureEditor.svelte`                                                                                                                                            | Already one sparse form; simplify presentation/actions and retain link/photo/text-only saves.                                |
| `src/lib/components/MetadataPrefill.svelte`                                                                                                                                          | Reuse guarded fill and photo behaviour; extend revision tracking to user-cleared fields, evidence and undo.                  |
| `src/routes/capture/+page.svelte`                                                                                                                                                    | Preserve editor locking, author recovery and save idempotency while simplifying new-share ownership confirmation.            |
| `src/lib/client/drafts.ts`, `src/lib/client/sync.ts`                                                                                                                                 | Explicit unfinished-versus-ready semantics must survive all persistence and background sync paths, not only browser imports. |
| `src/lib/client/share-import.ts`, `src/service-worker/index.ts`                                                                                                                      | Keep receipt local and unbound; add explicit continuation selection and transactional evidence attachment.                   |
| `src/lib/components/SyncStatus.svelte`                                                                                                                                               | Separate unfinished drafts from Waiting to send; replace technical adoption wording.                                         |
| `src/lib/components/ProductSuggestions.svelte`                                                                                                                                       | Existing saved-product confirmation must continue to protect existing fields and list estimates.                             |
| `src/lib/client/browser-capture.ts`, `src/lib/client/browser-product.js`, `src/lib/components/BrowserCaptureHelp.svelte`                                                             | Retire active bookmarklet flow without stranding its persisted captures or deleting review protections.                      |
| `tests/e2e/enrichment.spec.ts`, `tests/e2e/metadata-photo-race.spec.ts`, `tests/e2e/share-import.spec.ts`, `tests/e2e/capture-recovery.spec.ts`, `tests/e2e/offline-capture.spec.ts` | Preserve the existing behavioural proofs and add coverage for the accepted new journeys.                                     |

The current Android acceptance document still describes the separate adoption action and states that photo-only drafts need a title; current `CaptureEditor`/`captureTitle` allow sparse saves with a fallback title. Update `docs/android-acceptance.md` to the final implemented behaviour, rather than carrying that stale assertion into the new workflow. Replace the bookmarklet setup in `docs/retailer-imports.md` at release.

## Scope limits and decisions to validate

- This plan recommends removing the everyday separate adoption button only for a newly confirmed capture; it does not relax author isolation or grant transfer of an existing author's draft. The implementation plan must prove that the combined explicit Save cannot reintroduce reload-before-Save publication.
- Local draft autosave, the continuation chooser, basic image crop, undo, duplicate hints and simplified ownership presentation are proposed UX changes, not existing capabilities.
- The user does not need to choose a backend architecture or model prompt to approve this UX. Implementation should choose the smallest change that preserves the existing trust boundaries and verification contracts.
- No native app, extension, bookmarklet installation, universal retailer access, automatic OS screenshot capture, guaranteed video identification or automatic price conversion is promised.
- Provider eligibility, billing setup, live model behaviour and actual phone acceptance remain unverified. Ben's go-ahead is required before implementing or using the evaluation allowance.

## Sources

- Conversation: one sparse form; remove bookmarklet; generic Gemini extraction; personal key configuration; wait for implementation/evaluation go-ahead.
- `docs/plans/2026-11-03-2006-feat-family-gift-catalogue-plan.md`: household product scope, particularly R1, R5, R14–R23. This UX follow-up does not rewrite the original plan.
- `docs/retailer-imports.md`: prior live retailer audit and distinction between accessible pages, blocked pages and fixture-only browser checks. Those checks were not repeated for this plan.
- Current source files named above: durable capture, share import, field prefill, permission and sync behaviour.
- [Chrome Web Share Target guidance](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target): installed-app reception of shared links, text and files; source applications can populate share fields differently.
- [Gemini structured output guidance](https://ai.google.dev/gemini-api/docs/structured-output): structured responses still require application validation and handling of semantically incorrect values.
