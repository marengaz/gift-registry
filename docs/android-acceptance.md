# Android sharing and offline acceptance

This is the device acceptance checklist. Desktop browser tests simulate multipart shares and offline pages; they do not prove the Android Share menu, camera formats or storage survival on a particular phone.

## Install on the phone

1. Configure the deployed HTTPS address and Google sign-in using the deployment guide.
2. Open that address in current Chrome on Android. Sign in with an invited contributor account or the configured administrator.
3. Open **Add idea** online. Wait until the capture form and your permitted lists appear.
4. Use Chrome's menu to **Install app** or **Add to Home screen**. Open **Family gifts** from its icon once while online.
5. Close and reopen the installed app. Check that Add idea opens normally.

The app must be installed before Android can offer it as a share target. If it is absent from the Share menu, return to Chrome, check installation and connectivity, and open Add idea again. Copying a link and pasting it into the app remains available.

## Try the sources you use

For each source below, choose its Share action and select **Family gifts**. Record the Android version, Chrome version, source application/version, date and result. No real-device result has been recorded yet.

| Source                     | Check                                                                                             | Result  |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| Amazon or another retailer | The URL is present, the draft is editable and any available metadata can be checked.              | Not run |
| Instagram                  | The original post URL or text is retained; a private post can use a screenshot or manual details. | Not run |
| TikTok                     | The post link is retained; an inaccessible product can use a screenshot or manual details.        | Not run |
| Camera/gallery shop photo  | The original photo name is shown and can be saved, including the phone's actual format and size.  | Not run |
| Text or message            | Shared text is retained even without a URL.                                                       | Not run |

A share is first saved on the device without an account. Sign in if needed, choose **Adopt with my signed-in account**, select lists, and save. Opening a shared draft must not silently upload it as the person who was previously signed in. Photo-only drafts need an editable title before submission.

JPEG, PNG and WebP are the recommended formats. AVIF and HEIC/HEIF may be received, but the server's image decoder still needs to support the actual file. A rejected or oversized image must keep its source recoverable; use a JPEG copy if needed. Photos are limited to 12 MB and 30 megapixels on the server.

## Flight mode and app termination

1. While online, open Add idea with the correct account and lists. Record whether persistent storage was granted or remains best effort.
2. Turn on flight mode, ensuring Wi-Fi is also off. Close the app and reopen it from its installed icon.
3. Add a title, a shop photo and one permitted list. Choose **Save on this device**. Continue only after it confirms that local save.
4. Fully dismiss the app from recent applications. Reopen it while still offline. Open the saved draft and confirm its title, photo and list remain.
5. Share a photo from the gallery while offline. Confirm that it opens as a new unbound draft. Do not confuse it with an already synchronised idea.
6. Restore connectivity. Adopt the unbound share explicitly if applicable and save it. Confirm that pending ideas become acknowledged by the server and each appears once in the catalogue.
7. Repeat after restarting the phone. Do not clear Chrome or application storage: clearing browser data deliberately removes local drafts.

If storage is full or unavailable, the app must say that the share has **not** been saved. Keep the original source and free storage before trying again. Browsers can evict best-effort storage under pressure; synchronise when connected.

## Accounts, updates and recovery

1. Save a draft offline, reconnect and choose Sign out. Confirm that synchronise, discard and cancel are explicit choices, and that cancel keeps the draft.
2. Sign in as a different invited account. Confirm that the first account's unsynchronised draft is not uploaded as the second account.
3. Return to its author and retry. An uncertain response must reuse the original operation rather than create a duplicate.
4. Leave an offline draft pending while deploying an application update. Close existing app windows, reopen online, then check that the draft and photo survive the service-worker update.
5. If a share opens a recovery page saying it has not been saved, keep the source. Open Add idea online and initialise it, then share again or enter the link/photo manually.

Service-worker updates wait for old windows to close instead of replacing a receiver during a share import. Only the public capture screen and static assets are cached; family lists, media and private APIs require a connection.

## Remote debugging

If needed, enable Android developer options and USB debugging, connect the phone to the computer, and open Chrome's `chrome://inspect/#devices`. Select the Family gifts page or service worker. Inspect Application → Service Workers and IndexedDB to diagnose registration or local saves. Do not paste session cookies, invitation tokens or family content into public bug reports.

References: [Chrome Web Share Target guidance](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target), [SvelteKit service workers](https://svelte.dev/docs/kit/service-workers).
