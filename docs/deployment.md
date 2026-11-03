# Deploy Family gifts at home

Run the app, lookup worker and Caddy HTTPS proxy with Docker Compose on a 64-bit Linux home server. Build on the target `amd64` or `arm64` host so the SQLite and image libraries match it. The supplied image uses Node 26.13.0 on Debian Bookworm; container execution on your actual host remains an acceptance check.

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

## Start the services

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
5. In **Identification**, review the monthly allowance and enable paid image identification. Make a one-image check only when you intend to spend its admitted allowance, and record the result separately.

The default US$1 UTC-month allowance counts every image at US$0.0035, admitting at most 285 requests even where a free tier applies. A timeout or worker crash after possible dispatch keeps its reservation. Paid requests are not retried automatically. This controls requests admitted by this application, not the project's entire provider bill. Use Google billing alerts as additional information; they are not this application's hard admission check. Recheck the [Vision price](https://cloud.google.com/vision/pricing) before changing the conservative unit cost.

Image matching sends a metadata-stripped derivative to Google and shows candidate pages for confirmation. Private social posts may require a screenshot. Matches do not establish an exact product or variant, and confirming an offer does not change a list's agreed GBP estimate.

## Upgrade and recover

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
