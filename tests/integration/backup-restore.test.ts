import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { fixture } from './identity-fixture';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';
import { createBackup, restoreBackup } from '../../scripts/backup.mjs';
const io = vi.hoisted(() => ({ pause: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async (original) => {
	const actual = await original<typeof import('node:fs/promises')>();
	return {
		...actual,
		copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
			if (String(args[1]).endsWith('/media/photo/original')) await io.pause?.();
			return actual.copyFile(...args);
		}
	};
});
const directories: string[] = [];
afterEach(async () => {
	io.pause = undefined;
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
	);
});
async function household() {
	const root = await mkdtemp(join(tmpdir(), 'gift-backup-'));
	directories.push(root);
	const model = fixture();
	acceptInvitation(
		model.connection,
		model.actor('guest'),
		createInvitation(model.connection, model.admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'buyer' }]
		}).token
	);
	createInvitation(model.connection, model.admin, {
		email: 'other@example.test',
		grants: [{ listId: 'visible', role: 'viewer' }]
	});
	model.connection.sqlite
		.exec(`INSERT INTO products(id,title,contributor_id) VALUES('gift','Private gift','admin');
 INSERT INTO entries(id,product_id,list_id,estimate_pence,actual_pence,state,buyer_id,allocation_source,allocated_by_id,allocated_at,purchased_at) VALUES('entry','gift','visible',3000,2500,'purchased','guest','administrator','admin',1,2);
 INSERT INTO media(id,product_id,storage_path,mime_type,byte_size) VALUES('photo','gift','photo/original','image/jpeg',8);
 INSERT INTO identification_settings(id,enabled) VALUES(1,1);
 INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,kind,state,dispatched_at) VALUES('paid','gift','admin','session-admin','paid','paid','vision','uncertain',1),('pending','gift','admin','session-admin','pending','pending','metadata','queued',NULL),('running','gift','admin','session-admin','running','running','vision','running',NULL);
 INSERT INTO allowance_reservations(job_id,month,amount_microdollars,pricing_revision,project_id) VALUES('paid','2026-11',3500,'test','personal-test'),('running','2026-11',3500,'test','personal-test');`);
	const databasePath = join(root, 'live.sqlite');
	await model.connection.sqlite.backup(databasePath);
	model.connection.close();
	const mediaPath = join(root, 'media');
	await mkdir(join(mediaPath, 'photo'), { recursive: true });
	await writeFile(join(mediaPath, 'photo', 'original'), 'original');
	await writeFile(join(mediaPath, 'photo', 'preview.webp'), 'preview');
	return { root, databasePath, mediaPath, destination: join(root, 'backup') };
}
describe('consistent household recovery', () => {
	it('restores entries and immutable media into an isolated destination, preserves uncertain charges and resets restored access', async () => {
		const source = await household();
		await createBackup(source);
		const destination = join(source.root, 'restored');
		await restoreBackup({ source: source.destination, destination });
		const db = new Database(join(destination, 'gifts.sqlite'), { readonly: true });
		try {
			expect(db.pragma('quick_check', { simple: true })).toBe('ok');
			expect(db.pragma('foreign_key_check')).toEqual([]);
			expect(db.prepare('SELECT state,actual_pence,buyer_id FROM entries').get()).toEqual({
				state: 'purchased',
				actual_pence: 2500,
				buyer_id: 'guest'
			});
			expect(await readFile(join(destination, 'media/photo/original'), 'utf8')).toBe('original');
			expect(await readFile(join(destination, 'media/photo/preview.webp'), 'utf8')).toBe('preview');
			expect(
				db.prepare('SELECT sum(amount_microdollars) AS total FROM allowance_reservations').get()
			).toEqual({ total: 7000 });
			expect(db.prepare('SELECT enabled FROM identification_settings').get()).toEqual({
				enabled: 0
			});
			expect(db.prepare('SELECT id,state FROM lookup_jobs ORDER BY id').all()).toEqual([
				{ id: 'paid', state: 'uncertain' },
				{ id: 'pending', state: 'cancelled' },
				{ id: 'running', state: 'uncertain' }
			]);
			expect(db.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 0 });
			expect(
				db.prepare('SELECT count(*) AS n FROM invitations WHERE accepted_at IS NULL').get()
			).toEqual({ n: 0 });
			expect(db.prepare('SELECT count(*) AS n FROM grants').get()).toEqual({ n: 1 });
		} finally {
			db.close();
		}
		const live = new Database(source.databasePath, { readonly: true });
		try {
			expect(live.prepare('SELECT enabled FROM identification_settings').get()).toEqual({
				enabled: 1
			});
			expect(live.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 3 });
		} finally {
			live.close();
		}
	});
	it('holds the SQLite write lock while referenced media is copied and publishes a completed manifest last', async () => {
		const source = await household();
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const copying = new Promise<void>((resolve) => {
			entered = resolve;
		});
		io.pause = async () => {
			entered();
			await blocked;
		};
		const backup = createBackup(source);
		await Promise.race([
			copying,
			backup.then(() => {
				throw new Error('Backup completed without copying referenced media.');
			})
		]);
		const concurrent = new Database(source.databasePath, { timeout: 30 });
		try {
			await expect(
				readFile(join(source.destination, 'manifest.json'), 'utf8')
			).rejects.toMatchObject({ code: 'ENOENT' });
			expect(() =>
				concurrent
					.prepare("INSERT INTO products(id,title,contributor_id) VALUES('later','Later','admin')")
					.run()
			).toThrow(/locked/);
		} finally {
			release();
			concurrent.close();
		}
		await backup;
		const snapshot = new Database(join(source.destination, 'gifts.sqlite'), { readonly: true });
		try {
			expect(snapshot.prepare('SELECT count(*) AS n FROM products').get()).toEqual({ n: 1 });
		} finally {
			snapshot.close();
		}
		expect(
			JSON.parse(await readFile(join(source.destination, 'manifest.json'), 'utf8')).format
		).toBe('family-gifts-backup/v1');
	});
	it('rejects damaged or incomplete backups and existing destinations without overwriting data', async () => {
		const source = await household();
		await createBackup(source);
		await writeFile(join(source.destination, 'media/photo/original'), 'damaged');
		const restored = join(source.root, 'bad-restore');
		await expect(
			restoreBackup({ source: source.destination, destination: restored })
		).rejects.toThrow(/integrity|hash|changed/i);
		await expect(readFile(join(restored, 'restore-notice.json'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT'
		});
		await expect(createBackup(source)).rejects.toThrow(/exist/i);
		expect(await readFile(join(source.destination, 'media/photo/original'), 'utf8')).toBe(
			'damaged'
		);
		const empty = join(source.root, 'incomplete');
		await mkdir(empty);
		await expect(
			restoreBackup({ source: empty, destination: join(source.root, 'incomplete-restore') })
		).rejects.toThrow(/manifest|complete/i);
	});
});
