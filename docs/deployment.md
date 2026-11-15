# Deploy Family gifts at home

Run the app, lookup worker and Caddy HTTPS proxy with Docker Compose on a 64-bit Linux home server. Published images target `amd64` (Intel/AMD); use the source-build option below for `arm64`. Both use Node 26.13.0 on Debian Bookworm. Container execution on your actual host remains an acceptance check.

## Prepare the address and credentials

1. Choose a hostname such as `gifts.YOUR_DOMAIN`. Point its DNS record at the home's public address. Confirm that your connection permits incoming traffic.
2. Forward TCP ports 80 and 443 to the server. UDP 443 is optional for HTTP/3. Leave the app's port 3000 unpublished.
3. If the connection uses CGNAT or forwarding is unavailable, choose a tunnel or private access route before deployment. Configure that route to preserve the public HTTPS origin and overwrite trusted forwarded headers. A tunnel is not configured by this repository.
4. Create a personal Google OAuth **Web application** client. Configure its authorised JavaScript origin as the exact public HTTPS origin and its redirect URI as `https://YOUR_HOSTNAME/api/auth/callback/google`. For Google's testing audience, add each intended sign-in account as a test user; review the consent-screen publishing settings before wider family use.
5. Copy the source to the server, create `.env` from `.env.example`, and restrict the settings file:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

6. Generate a secret locally and paste it into `.env`:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

Set the following deployment values. The hostname and contact below are placeholders:

```dotenv
PUBLIC_HOSTNAME=gifts.YOUR_DOMAIN
ORIGIN=https://gifts.YOUR_DOMAIN
ACME_EMAIL=YOUR_CERTIFICATE_CONTACT_EMAIL
BETTER_AUTH_SECRET=YOUR_RANDOM_SECRET
GOOGLE_CLIENT_ID=YOUR_PERSONAL_WEB_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_PERSONAL_WEB_CLIENT_SECRET
ADMINISTRATOR_EMAIL=YOUR_ADMINISTRATORS_VERIFIED_GOOGLE_EMAIL
```

Alternatively, set `ADMINISTRATOR_GOOGLE_SUBJECT` for the exact Google subject. When both are supplied, the subject takes precedence. The first matching, verified sign-in binds the sole administrator's Google subject in SQLite. Visiting first does not grant administrator access. Keep that identity and the authentication secret stable across restarts.

## Start from a published image (AMD64)

Choose a numbered version from [GitHub releases](https://github.com/marengaz/gift-registry/releases) and set it in `.env`, for example:

```dotenv
GIFT_IMAGE=ghcr.io/marengaz/gift-registry:0.1.0
```

From the directory containing `compose.yaml`, use the release override for every command:

```sh
mkdir -p secrets
docker compose -f compose.yaml -f compose.release.yaml config --quiet
docker compose -f compose.yaml -f compose.release.yaml pull app worker
docker compose -f compose.yaml -f compose.release.yaml up -d --no-build
```

The override applies the same image to the app and worker. `--no-build` keeps Compose from building the source configuration inherited from the base file. Use the same two `-f` options for `ps`, `logs`, `stop` and later upgrades. Keep the volume names and project directory stable. Configure the hostname, HTTPS route and Google credentials as described above; the image does not contain your settings or household data.

Before upgrading, complete a backup, choose the new version in `.env`, pull both services, then stop and recreate the app and worker using the same files. Keep the database volume. Follow [Back up and restore](backup-restore.md) for recovery; selecting an older image alone does not undo database migrations.

## Build and start from source

Run these commands from the directory containing `compose.yaml`:

```sh
mkdir -p secrets
docker compose config --quiet
docker compose build app
docker compose up -d
```

`secrets` can remain empty while image identification is disabled. The app and worker share the `family-gifts_gifts_data` named volume. Inside both containers, SQLite is `/data/gifts.sqlite` and private images are `/data/media`. Caddy keeps certificates in separate persistent volumes. Do not place SQLite WAL on NFS, SMB or a cloud-synchronised folder.

Only Caddy publishes host ports. The Node adapter trusts `X-Forwarded-Proto` from that proxy, and Caddy replaces the incoming value. The 64 MB request limit allows multipart photos; each individual image still has the application's 12 MB and 30 megapixel limits. If you replace the proxy, retain that header boundary and do not expose port 3000 directly.

Readiness waits for local database integrity/write access, private image storage and required sign-in configuration. It does not contact Google or validate a client secret with the provider. The worker and proxy wait for the app to become healthy.

## Check the deployment

1. Inspect service state with `docker compose ps`. Review app/worker logs if either restarts or remains unhealthy.
2. Open the public HTTPS address and complete one real Google sign-in as the configured administrator.
3. Open **Server checks**. Confirm storage and configuration readiness, a matching incoming address, and the trusted forwarded protocol setting.
4. Create lists and invite a contributor, buyer and viewer through **People**. Send the copied invitation links through your chosen channel. Check one real invitation acceptance and an incorrect-account rejection.
5. Reserve a test idea as a buyer. Check that another relative no longer receives that entry or its private image. Record a purchase and inspect the administrator's totals.
6. Complete the [Android checklist](android-acceptance.md). On an actual iPhone, open a relative's list in Safari, sign in with Google, refresh availability and follow a retailer link. Installation is not required for browsing.
7. Create and restore an isolated [backup](backup-restore.md). Restart the services and verify that signed-in sessions, catalogue, buying state, photos and lookup reservations survive.

The public liveness endpoint, `/health/live`, returns a boolean without resolving authentication or opening the database. `/health/ready` returns a readiness boolean and status 200 or 503. Detailed configuration flags and lookup counts are available only to the administrator. Private responses use `no-store`; the service worker caches the public capture shell and static assets only.

The share fallback deliberately accepts a cross-origin `POST /share` without using cookies or creating server records. The global request hook checks the origin of every other mutation, including authentication endpoints. SvelteKit's generic form check is delegated to that hook so the share recovery page can run.

## Optional Gemini help

The existing retailer reader remains the first pass. Gemini can interpret incomplete accessible content and explicitly submitted images or text. Set `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.5-flash-lite`, `GEMINI_MONTHLY_BUDGET_USD=2.00` and `GEMINI_EVAL_BUDGET_USD=0.25` in the server environment. Compose passes these to the app, which makes the Gemini requests; the existing Vision worker does not need this key.

Enable AI help in **Identification**. The existing administrator allowance, Gemini environment limit and evaluation sub-limit are all enforced. Gemini requests reserve US$0.02 conservatively, with failed or uncertain dispatches still counted. Gemini and Vision share the administrator's overall allowance. Keep the key out of source control and browser code. Google subscription credits do not remove the need for an active provider billing setup.

See [Save ideas from shops](retailer-imports.md) for screenshots, unfinished drafts, extraction controls and the opt-in development evaluation harness. The additive Gemini reservation migration is applied on startup and is included in normal SQLite backups.

## Optional personal image identification

Ordinary capture and retailer metadata work without Vision credentials. To enable explicit photo matching:

1. Create a dedicated personal Google Cloud project, enable Vision and configure its billing. Do this outside work credentials or projects.
2. Create a service account with only the access needed to use Vision in that project. Save its JSON credential as `secrets/vision.json`, outside source control. Make it readable by the container's `node` user, UID 1000, and restrict other access.
3. Set these values in `.env`:

   ```dotenv
   VISION_PROJECT_ID=YOUR_PERSONAL_PROJECT_ID
   VISION_CREDENTIALS_DIRECTORY=./secrets
   VISION_CREDENTIALS_FILE=/run/secrets/vision.json
   ```

4. Recreate app and worker with `docker compose up -d`. Only the worker receives the read-only credential mount. The JSON credential's `project_id` must match `VISION_PROJECT_ID`; ambient Google credentials are not used.
5. In **Identification**, review the shared monthly allowance and enable AI help and paid image identification. Make a one-image check only when you intend to spend its admitted allowance, and record the result separately.

The default US$1 UTC-month allowance counts every image at US$0.0035, admitting at most 285 requests even where a free tier applies. A timeout or worker crash after possible dispatch keeps its reservation. Paid requests are not retried automatically. This controls requests admitted by this application, not the project's entire provider bill. Use Google billing alerts as additional information; they are not this application's hard admission check. Recheck the [Vision price](https://cloud.google.com/vision/pricing) before changing the conservative unit cost.

Image matching sends a metadata-stripped derivative to Google and shows candidate pages for confirmation. Private social posts may require a screenshot. Matches do not establish an exact product or variant, and confirming an offer does not change a list's agreed GBP estimate.

## Upgrade a source build and recover

1. Create a completed backup and copy it outside the live volume.
2. Stop the worker and app with `docker compose stop worker app`.
3. Copy the new source and build it with `docker compose build app`.
4. Recreate services with `docker compose up -d --force-recreate`, preserving their volumes. This also replaces Caddy's bind mount after an editor or source copy has replaced the Caddyfile inode. Versioned database migrations run when the app opens the database. Never run older application code against a newer schema as an improvised rollback.
5. Check **Server checks**, one list and one private photo. Confirm that pending offline drafts remain available on their original devices after the service-worker update.

For an application/schema rollback, restore the pre-upgrade snapshot into an isolated destination and follow the restore guide. Do not remove persistent volumes as part of a routine upgrade.

## Acceptance record

No home hostname, server architecture, public route or real-device/provider credentials have been supplied in this checkout. Fill these entries when you configure them:

| Check                                                        | Result         |
| ------------------------------------------------------------ | -------------- |
| Actual home CPU/OS, Docker image build and container restart | Not run        |
| Public HTTPS origin and route                                | Not configured |
| Real Google sign-in and invitation acceptance                | Not run        |
| Android source apps, flight mode and phone restart           | Not run        |
| iPhone Safari relative journey                               | Not run        |
| Optional admitted Google Vision image check                  | Not run        |

References: [SvelteKit Node deployment](https://svelte.dev/docs/kit/adapter-node), [Better Auth Google setup](https://better-auth.com/docs/authentication/google), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Caddy HTTPS](https://caddyserver.com/docs/automatic-https), [SQLite WAL](https://www.sqlite.org/wal.html).
