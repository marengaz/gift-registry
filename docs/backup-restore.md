# Back up and restore

Create a completed snapshot before upgrades and keep a copy outside the live disk or Docker volume. The backup command holds a SQLite write lock while it snapshots the database and copies only its referenced immutable originals/previews. Private application requests, including access checks, may wait or return an error while the lock is held; retry them after the snapshot. Local capture drafts remain recoverable.

A completed backup contains `gifts.sqlite`, referenced files under `media/`, and `manifest.json` with SHA-256 hashes. The manifest is published last. A directory without that manifest is incomplete and cannot be restored. Existing destination directories are refused.

## Create a backup

With the Compose app running, choose a new destination name. Replace `BACKUP_NAME` with a distinct name such as `2026-11-03-before-upgrade`:

```sh
mkdir -p backups
docker compose exec app mkdir -p /data/backups
docker compose exec app node scripts/backup.mjs create --destination /data/backups/BACKUP_NAME
docker compose cp app:/data/backups/BACKUP_NAME ./backups/BACKUP_NAME
```

Copy the completed directory to your chosen protected storage outside the live disk. Backups contain private family data and authentication records; restrict access and use encryption where you store them.

For a local Node installation, the command reads paths from `.env`, unless overridden:

```sh
npm run backup -- create --destination /ABSOLUTE/BACKUP_PARENT/BACKUP_NAME
```

Explicit paths are also supported:

```sh
node scripts/backup.mjs create --database /LIVE/gifts.sqlite --media /LIVE/media --destination /BACKUP/BACKUP_NAME
```

Keep the backup destination separate from the live media root. Do not copy an open SQLite file and omit its WAL, or run a hand-written file copy as a substitute for the snapshot command. The command removes its own failed output; an interrupted process can leave an incomplete directory for inspection.

## Restore into an isolated directory

Stop the service that will use the restored data. Keep the original live volume and the backup intact. The restore destination must not already exist.

Run the restore helper in the built image with the backup parent and a separate empty recovery parent mounted. Replace the two host paths and `BACKUP_NAME`:

```sh
docker compose run --rm --no-deps \
  --volume /ABSOLUTE/BACKUP_PARENT:/backup:ro \
  --volume /ABSOLUTE/RECOVERY_PARENT:/recovery \
  app node scripts/backup.mjs restore --source /backup/BACKUP_NAME --destination /recovery/restored
```

The recovery parent must be writable by UID 1000. For a local Node installation, run:

```sh
npm run backup -- restore --source /BACKUP/BACKUP_NAME --destination /RECOVERY/restored
```

The helper verifies file hashes, database integrity, foreign keys and all referenced images before publishing `restore-notice.json`. It restores gift details, list memberships, allocations, purchases and every stored allowance reservation. It also:

- disables paid identification;
- marks formerly queued/running lookups cancelled, or uncertain if they might have been paid;
- removes restored sessions, OAuth verification state and unused invitation tokens.

Catalogue deletion markers, action receipts and the latest Undo target are included in the snapshot. Photographs belonging to deleted ideas remain referenced and are backed up too. After signing in again as the same administrator, a restored latest action can still be undone, provided its recorded effects have not changed. Restoring a backup does not uncover older Undo actions or provide a separate deleted-ideas browser.

Existing family membership/grants are retained as snapshot data. Review them before making the recovered service public: revocations performed after the snapshot are not present in an older database. Everyone must sign in again, and pending invitations must be recreated.

An older snapshot cannot know provider charges incurred after it was taken. Keep paid identification disabled until you reconcile those current-month charges against the dedicated project's usage, or wait for a new UTC month before re-enabling it. Restoring does not release any recorded reservation and does not redispatch old lookups.

## Check and promote a restored copy

1. Read `restored/restore-notice.json`. Confirm the snapshot date and the identification/access review requirements.
2. Use a separate local instance with `DATABASE_PATH` and `MEDIA_PATH` pointing at `restored/gifts.sqlite` and `restored/media`. Keep it private while checking the configured administrator, grants, one purchased entry, one private image and uncertain lookup counts.
3. Sign in again with the administrator's real Google account. Review restored grants and recreate only the invitations you still need.
4. Stop the instance. With production app and worker stopped, mount or copy this verified directory into the production data volume, preserving ownership for UID 1000. Keep the previous volume until recovery acceptance is complete.
5. Start the app and worker, then verify HTTPS, sign-in, lists, media and privacy before allowing relatives to use it. Leave identification disabled until its usage review is complete.

Local integration tests exercise real SQLite lock contention, an isolated restore and damaged-snapshot rejection. A restore on your chosen home storage and a real Google callback still need to be recorded after deployment.

References: [SQLite online backups](https://www.sqlite.org/backup.html), [SQLite WAL storage](https://www.sqlite.org/wal.html).
