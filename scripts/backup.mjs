import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {import('better-sqlite3').Database} SqliteDatabase */
/** @typedef {{format:'family-gifts-backup/v1',createdAt:string,files:Record<string,string>}} BackupManifest */
/** @typedef {{format?:unknown,createdAt?:unknown,files?:Record<string,unknown>}} RawManifest */
/** @typedef {{format:'family-gifts-backup/v1',createdAt:unknown,files:Record<string,string>}} VerifiedManifest */
/** @param {string} parent @param {string} child */
function inside(parent, child) {
	const part = relative(parent, child);
	return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part));
}
/** @param {SqliteDatabase} database */
function mediaFiles(database) {
	/** @type {Set<string>} */
	const names = new Set();
	const rows = /** @type {{storage_path:unknown}[]} */ (
		database.prepare('SELECT storage_path FROM media ORDER BY id').all()
	);
	for (const row of rows) {
		if (
			typeof row.storage_path !== 'string' ||
			!/^[A-Za-z0-9_-]+\/original$/.test(row.storage_path)
		)
			throw new Error('A stored media reference is unsafe.');
		names.add(row.storage_path);
		names.add(row.storage_path.replace(/original$/, 'preview.webp'));
	}
	return [...names].sort();
}
/** @param {string} path */
async function hashFile(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}
/** @param {SqliteDatabase} database */
function checkDatabase(database) {
	if (
		database.pragma('quick_check', { simple: true }) !== 'ok' ||
		/** @type {unknown[]} */ (database.pragma('foreign_key_check')).length
	)
		throw new Error('The database integrity check failed.');
}
/** @param {string} root @param {string} name */
async function safeFile(root, name) {
	const file = join(root, name);
	const canonical = await realpath(file);
	if (!inside(await realpath(root), canonical) || !(await lstat(file)).isFile())
		throw new Error('A media reference does not identify a regular file inside its storage root.');
	return file;
}
/** @param {string} source @param {string} target */
async function copyPrivate(source, target) {
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	await copyFile(source, target);
	await chmod(target, 0o600);
}
/** @param {string} directory @param {string} name @param {unknown} value */
async function publishJson(directory, name, value) {
	const temporary = join(directory, `.${randomUUID()}.json`);
	await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
	await rename(temporary, join(directory, name));
}
/**
 * Creates a completed, hash-checked snapshot while a SQLite write lock protects referenced media.
 * @param {{databasePath?:string,mediaPath?:string,destination?:string}} options
 */
export async function createBackup({
	databasePath = process.env.DATABASE_PATH ?? 'data/gifts.sqlite',
	mediaPath = process.env.MEDIA_PATH ?? 'data/media',
	destination
}) {
	if (!destination) throw new Error('Choose a new backup destination.');
	const target = resolve(destination),
		databaseFile = resolve(databasePath),
		mediaRoot = resolve(mediaPath);
	if (inside(mediaRoot, target) || inside(target, databaseFile) || inside(target, mediaRoot))
		throw new Error('Keep the backup destination separate from live database and media storage.');
	await mkdir(target, { mode: 0o700 });
	/** @type {SqliteDatabase | undefined} */
	let lock;
	/** @type {SqliteDatabase | undefined} */
	let reader;
	let complete = false;
	try {
		lock = new Database(databaseFile, { fileMustExist: true });
		lock.pragma('foreign_keys = ON');
		lock.exec('BEGIN IMMEDIATE');
		reader = new Database(databaseFile, { readonly: true, fileMustExist: true });
		checkDatabase(reader);
		const files = mediaFiles(reader);
		await reader.backup(join(target, 'gifts.sqlite'));
		await chmod(join(target, 'gifts.sqlite'), 0o600);
		for (const name of files)
			await copyPrivate(await safeFile(mediaRoot, name), join(target, 'media', name));
		const snapshot = new Database(join(target, 'gifts.sqlite'), {
			readonly: true,
			fileMustExist: true
		});
		try {
			checkDatabase(snapshot);
		} finally {
			snapshot.close();
		}
		/** @type {Record<string,string>} */
		const hashes = {};
		for (const name of ['gifts.sqlite', ...files.map((name) => 'media/' + name)])
			hashes[name] = await hashFile(join(target, name));
		/** @type {BackupManifest} */
		const manifest = {
			format: 'family-gifts-backup/v1',
			createdAt: new Date().toISOString(),
			files: hashes
		};
		await publishJson(target, 'manifest.json', manifest);
		complete = true;
		return {
			destination: target,
			createdAt: manifest.createdAt,
			files: Object.keys(hashes).length
		};
	} finally {
		reader?.close();
		if (lock?.inTransaction) lock.exec('ROLLBACK');
		lock?.close();
		if (!complete) await rm(target, { recursive: true, force: true });
	}
}
/** @param {string} source @returns {Promise<VerifiedManifest>} */
async function readManifest(source) {
	/** @type {RawManifest | null | undefined} */
	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
	} catch {
		throw new Error('This backup has no readable completed manifest.');
	}
	if (
		manifest?.format !== 'family-gifts-backup/v1' ||
		!manifest.files ||
		typeof manifest.files !== 'object' ||
		!manifest.files['gifts.sqlite']
	)
		throw new Error('The completed backup manifest is invalid.');
	for (const [name, hash] of Object.entries(manifest.files)) {
		if (
			(name !== 'gifts.sqlite' &&
				!/^media\/[A-Za-z0-9_-]+\/(original|preview\.webp)$/.test(name)) ||
			typeof hash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(hash)
		)
			throw new Error('The backup manifest contains an unsafe file reference.');
		if ((await hashFile(await safeFile(source, name))) !== hash)
			throw new Error('Backup integrity failed: a file has changed since the completed snapshot.');
	}
	return /** @type {VerifiedManifest} */ (manifest);
}
/**
 * Restores into a new directory, invalidating restored logins and stopping automatic paid dispatch.
 * @param {{source?:string,destination?:string}} options
 */
export async function restoreBackup({ source, destination }) {
	if (!source || !destination)
		throw new Error('Choose a completed backup source and a new restore destination.');
	const original = resolve(source),
		target = resolve(destination);
	if (inside(original, target) || inside(target, original))
		throw new Error('Keep the restored directory separate from the backup source.');
	const manifest = await readManifest(original);
	await mkdir(target, { mode: 0o700 });
	let complete = false;
	try {
		for (const name of Object.keys(manifest.files)) {
			await copyPrivate(await safeFile(original, name), join(target, name));
			if ((await hashFile(join(target, name))) !== manifest.files[name])
				throw new Error('Backup integrity failed while copying a file.');
		}
		const database = new Database(join(target, 'gifts.sqlite'), { fileMustExist: true });
		try {
			database.pragma('foreign_keys = ON');
			checkDatabase(database);
			const expected = [
				'gifts.sqlite',
				...mediaFiles(database).map((name) => 'media/' + name)
			].sort();
			if (JSON.stringify(expected) !== JSON.stringify(Object.keys(manifest.files).sort()))
				throw new Error('Backup integrity failed: media references do not match the manifest.');
			database
				.transaction(() => {
					const now = Date.now();
					database
						.prepare('INSERT OR IGNORE INTO identification_settings(id,enabled) VALUES(1,0)')
						.run();
					database
						.prepare('UPDATE identification_settings SET enabled=0,updated_at=? WHERE id=1')
						.run(now);
					database
						.prepare(
							`UPDATE lookup_jobs SET state=CASE WHEN dispatched_at IS NOT NULL OR EXISTS(SELECT 1 FROM allowance_reservations r WHERE r.job_id=lookup_jobs.id) THEN 'uncertain' ELSE 'cancelled' END,lease_until=NULL,finished_at=?,error_text='Restored snapshot: reconcile usage before making a new explicit request.' WHERE state IN ('queued','running')`
						)
						.run(now);
					database.exec(
						'DELETE FROM session; DELETE FROM verification; DELETE FROM invitations WHERE accepted_at IS NULL;'
					);
				})
				.immediate();
			checkDatabase(database);
			database.pragma('wal_checkpoint(TRUNCATE)');
		} finally {
			database.close();
		}
		const notice = {
			restoredAt: new Date().toISOString(),
			backupCreatedAt: manifest.createdAt,
			identificationEnabled: false,
			sessionsReset: true,
			reviewRequired: [
				'Review restored family grants before exposing the service.',
				'Reconcile any later current-month provider charges, or wait for a new UTC month, before enabling paid identification.'
			]
		};
		await publishJson(target, 'restore-notice.json', notice);
		complete = true;
		return { destination: target, ...notice };
	} finally {
		if (!complete) await rm(target, { recursive: true, force: true });
	}
}
async function main() {
	const [command, ...args] = process.argv.slice(2);
	/** @type {Record<string,string>} */
	const values = {};
	if (args.length % 2) throw new Error('Use --name value pairs.');
	for (let i = 0; i < args.length; i += 2) {
		if (!args[i].startsWith('--')) throw new Error('Use --name value pairs.');
		values[args[i].slice(2)] = args[i + 1];
	}
	if (command === 'create')
		return createBackup({
			databasePath: values.database,
			mediaPath: values.media,
			destination: values.destination
		});
	if (command === 'restore')
		return restoreBackup({ source: values.source, destination: values.destination });
	throw new Error(
		'Use create --destination NEW_DIRECTORY [--database FILE --media DIRECTORY], or restore --source BACKUP --destination NEW_DIRECTORY.'
	);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main()
		.then((result) => console.log(JSON.stringify(result, null, 2)))
		.catch((error) => {
			console.error(error instanceof Error ? error.message : 'Recovery command failed.');
			process.exitCode = 1;
		});
}
