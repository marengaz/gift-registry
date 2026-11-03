# Family gifts

A private family present catalogue with one administrator, Google sign-in, reusable ideas and recipient/occasion lists. Contributors can capture links, notes and photos offline. Relatives reserve gifts online, and the administrator can assign them and track GBP estimates and purchases.

The app is an installable website. Android Chrome can share links and photos into it; relatives can use an ordinary browser. Retailer metadata fills available fields. Optional Google Vision matching suggests buying pages for confirmation and stays disabled until configured and enabled within an allowance.

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

For the production app and metadata worker, build once and run these in separate terminals:

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
