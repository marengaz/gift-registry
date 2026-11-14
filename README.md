# Family gifts

A private family present catalogue with one administrator, Google sign-in, reusable ideas and recipient/occasion lists. Contributors can capture links, notes and photos offline. Relatives reserve gifts online, and the administrator can assign them and track GBP estimates and purchases.

The app is an installable website. Android Chrome can share links and photos into it; relatives can use an ordinary browser. Retailer metadata fills available fields. Optional SerpAPI Google Lens search finds possible buying pages from a saved photograph. It stays disabled until configured and identification is enabled by the administrator.

The existing retailer reader runs first, including Amazon-specific handling. Optional Gemini help fills missing details from readable pages, selected screenshots and pasted text. For blocked shops, add a screenshot to the same idea. See [Save ideas from shops](docs/retailer-imports.md) for the workflow and prior live retailer checks.

In the catalogue, use **Add to lists** on an idea or select several ideas and add them together. Search the destination picker by recipient, list name or occasion; selected lists remain chosen while you search. Existing list memberships and buying details are preserved. Changing filters clears the idea selection; changing between cards and compact rows keeps it.

The administrator can also delete ideas individually or in bulk. Deletion hides an idea throughout the app while retaining its photographs and buying history. Gifts already reserved, assigned or purchased require confirmation. **Undo last action** reverses the latest catalogue addition or deletion and survives a reload. It has one level: a newer effective action replaces the previous Undo target. Later reservations, purchases or edits can prevent Undo from reversing an action safely.

Catalogue actions need an online acknowledgement. If the response is lost, use the displayed retry to check the same action before starting another.

On **Gift lists**, the administrator can **Hide list**, then use **Show hidden lists** to find it and show it again. Relatives cannot access a hidden list; its ideas and buying history are retained.

**Delete list** asks for confirmation and keeps ideas by default. Optional cleanup deletes only ideas from that list which have no other undeleted list. Hidden lists still protect their ideas, and previously unlisted ideas are untouched. List deletion has no in-app Undo; retained history and photographs remain in backups. A recreated list needs fresh sharing permissions.

## Run locally

Use Node 26.13.0 or a later Node 26 release. Install the locked dependencies, then create your local settings:

```sh
npm ci
cp .env.example .env
```

Edit `.env`. Keep `ORIGIN=http://localhost:5173` for local development. Supply a random `BETTER_AUTH_SECRET`, your Google web client ID/secret, and the sole administrator's verified Google email or subject. The local Google callback is `http://localhost:5173/api/auth/callback/google`.

Start the development app:

```sh
npm run dev
```

Missing Google settings leave a setup message on the sign-in page. There is no development login bypass. Data defaults to `data/gifts.sqlite` and `data/media`; keep these on local disk and out of Git.

Photo searches and queued source lookups need the worker as well as the development server. Build it once, then start it in a second terminal with the same `.env`:

```sh
npm run build
npm run worker
```

Rebuild and restart the worker after changing its source, and restart it after changing server credentials. The Vite development server alone does not process identification jobs.

## Find buying links from a photograph

Set `SERPAPI_API_KEY` from [your SerpAPI account](https://serpapi.com/manage-api-key) and `SERPAPI_MONTHLY_SEARCH_LIMIT=200` in `.env`. Enable identification in the administrator settings. Existing Google Vision credentials and Gemini billing are not needed for this search. Compose passes these settings to both the app and worker.

Save an idea with a photograph, open it and choose **Find where to buy**. The action sends a compressed, metadata-stripped copy to SerpAPI and Google; the original stays in private app storage. No public image URL or publicly reachable home server is needed. [SerpAPI's image identifier expires after ten minutes](https://serpapi.com/image-api); this is not a promise that the provider deletes the uploaded photo then. See its [privacy terms](https://serpapi.com/legal).

Results are possible matches. Inspect a result before adding its shopping link. Adding or opening a link leaves it **unchecked**, with a warning that it may be incorrect. The administrator can separately record that they checked the linked product and variant, or mark it unchecked again. This records a product check, not seller reliability or future stock and prices. Changing the URL, idea title or variant clears the check; changing only the price preserves it. Unchecked reverse-search prices do not automatically become list estimates.

The app reserves one search slot before contacting the provider. It retains that slot if the outcome is uncertain, and checking the same request does not start another search. The limit counts this app's UTC calendar-month reservations, independently of the provider's renewal cycle and searches made elsewhere. It is not an account-wide spending cap. Review your [SerpAPI plan and usage](https://serpapi.com/dashboard) separately. Missing configuration, exhausted allowances and no matches leave the saved idea available for manual editing.

## Run a production build locally

Build once and run the app and worker in separate terminals:

```sh
npm run build
npm start
```

```sh
npm run worker
```

For direct local production testing, set `ORIGIN=http://localhost:3000` and `PROTOCOL_HEADER=x-forwarded-proto`, and send `X-Forwarded-Proto: http` through a local reverse proxy. The home configuration handles the proxy automatically. Use the development server for ordinary local work.

## Host at home

Follow [Deploy at home](docs/deployment.md) for Docker Compose, HTTPS, Google setup and optional personal Vision credentials. Only Caddy publishes ports; the app and SQLite storage stay behind it. A domain, public route and actual server architecture still need to be selected for your home.

Use [Back up and restore](docs/backup-restore.md) before upgrades and for recovery. Complete [Android acceptance](docs/android-acceptance.md) on the actual phone before relying on offline shares.

## Check the application

Install Chromium once, then run the complete local check in build-before-browser order:

```sh
npx playwright install chromium
npm run verify
```

`verify` runs Svelte/TypeScript checks, the separate service-worker type check, formatting, unit tests, SQLite/HTTP integration tests, a production app/worker build and browser journeys. Tests use isolated data and provider doubles. The optional manual CI workflow is source only; this local repository has no remote or running CI.

Local automation does not establish a real Google callback, Google Vision compatibility, native Android sharing, iPhone behaviour, container restart or public home reachability. Record those results in the deployment/device checklists when performed.
