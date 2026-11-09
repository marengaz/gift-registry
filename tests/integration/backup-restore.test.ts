import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { fixture } from './identity-fixture';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';
import { createBackup, restoreBackup } from '../../scripts/backup.mjs';
import { createDatabase } from '../../src/lib/server/db/client';
import { canReadProduct, requireMediaAccess, resolveActor } from '../../src/lib/server/access';
import { allocationPost } from '../../src/lib/server/allocations';
import {
	catalogueActionsPost,
	catalogueActionsUndoPost
} from '../../src/lib/server/catalogue-actions';
import { calculateListTotals } from '../../src/lib/server/totals';
import type {
	CatalogueActionError,
	CatalogueActionResult
} from '../../src/lib/shared/catalogue-actions';
import { listPatch, listsGet, type CatalogueEvent } from '../../src/lib/server/catalogue';
import { listDelete, listDeletionImpactGet } from '../../src/lib/server/list-lifecycle';
import type {
	ListDeleteCommand,
	ListDeletionImpact,
	ListDeletionAcknowledgement
} from '../../src/lib/shared/list-lifecycle';
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
 INSERT INTO allowance_reservations(job_id,month,amount_microdollars,pricing_revision,project_id) VALUES('paid','2026-11',3500,'test','personal-test'),('running','2026-11',3500,'test','personal-test');
 INSERT INTO gemini_capture_requests(actor_id,operation_id,fingerprint,month,reserved_microdollars,state,result_json,created_at) VALUES('admin','gemini-complete','complete-evidence','2026-11',20000,'complete','{"suggestions":[],"message":"No reliable price"}',1),('admin','gemini-running','running-evidence','2026-11',20000,'running',NULL,2);`);
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
	it('preserves hidden lists, deleted lists and orphan cleanup receipts across a restore', async () => {
		const source = await household();
		const connection = createDatabase({ filename: source.databasePath });
		const event = (
			actor: CatalogueEvent['locals']['actor'],
			path: string,
			method = 'GET',
			body?: unknown
		): CatalogueEvent => {
			const url = new URL(path, 'http://localhost:4173');
			return {
				url,
				locals: { actor },
				request: new Request(url, {
					method,
					headers: { origin: url.origin, 'content-type': 'application/json' },
					...(body === undefined ? {} : { body: JSON.stringify(body) })
				})
			};
		};
		let command: ListDeleteCommand;
		let acknowledgement: ListDeletionAcknowledgement;
		let retained: { table: string; rows: unknown[] }[];
		try {
			const actor = resolveActor(connection, 'session-admin')!;
			for (const [action, expectedVersion] of [
				['undo', 0],
				['purchase', 1]
			] as const) {
				const response = await allocationPost(
					connection,
					event(actor, '/api/entries/entry/allocation', 'POST', {
						actionId: randomUUID(),
						action,
						expectedVersion,
						...(action === 'purchase' ? { actualPence: 2500 } : {})
					}),
					'entry'
				);
				expect(response.status).toBe(200);
			}
			connection.sqlite.exec(
				"INSERT INTO products(id,title,contributor_id) VALUES('shared','Shared idea','admin')"
			);
			const addition = await catalogueActionsPost(
				connection,
				event(actor, '/api/catalogue-actions', 'POST', {
					operationId: randomUUID(),
					kind: 'add',
					productIds: ['shared'],
					listIds: ['visible', 'secret']
				})
			);
			expect(addition.status).toBe(200);
			expect(
				(
					await listPatch(
						connection,
						event(actor, '/api/lists/secret', 'PATCH', { archived: true }),
						'secret'
					)
				).status
			).toBe(200);
			const preview = await listDeletionImpactGet(
				connection,
				event(actor, '/api/lists/visible/deletion-impact'),
				'visible'
			);
			expect(preview.status).toBe(200);
			const impact = (await preview.json()) as ListDeletionImpact;
			expect(impact).toMatchObject({ productCount: 2, orphanProductCount: 1, purchasedCount: 1 });
			command = {
				operationId: randomUUID(),
				deleteOrphans: true,
				impactFingerprint: impact.fingerprint
			};
			const deleted = await listDelete(
				connection,
				event(actor, '/api/lists/visible', 'DELETE', command),
				'visible'
			);
			expect(deleted.status).toBe(200);
			acknowledgement = (await deleted.json()) as ListDeletionAcknowledgement;
			expect(acknowledgement).toMatchObject({
				productCount: 2,
				deletedProductCount: 1,
				keptProductCount: 1
			});
			retained = [
				'lists',
				'products',
				'entries',
				'allocation_history',
				'media',
				'list_deletion_receipts',
				'catalogue_latest_actions'
			].map((table) => ({
				table,
				rows: connection.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
			}));
		} finally {
			connection.close();
		}
		await createBackup(source);
		const destination = join(source.root, 'restored-list-lifecycle');
		await restoreBackup({ source: source.destination, destination });
		const restored = createDatabase({ filename: join(destination, 'gifts.sqlite') });
		try {
			expect(restored.sqlite.prepare('SELECT COUNT(*) AS count FROM session').get()).toEqual({
				count: 0
			});
			const now = Date.now();
			restored.sqlite
				.prepare(
					'INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)'
				)
				.run('fresh-admin', 'admin', 'fresh-list-token', now + 3600000, now, now);
			const actor = resolveActor(restored, 'fresh-admin', {
				administratorEmail: 'admin@example.test'
			})!;
			for (const { table, rows } of retained)
				expect(restored.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(
					rows
				);
			expect((await listsGet(restored, event(actor, '/api/lists/visible'), 'visible')).status).toBe(
				404
			);
			const index = await (await listsGet(restored, event(actor, '/api/lists'))).json();
			expect(index.lists.map((list: { id: string }) => list.id)).toEqual(['secret']);
			expect(index.lists[0].archivedAt).toEqual(expect.any(Number));
			expect(canReadProduct(restored, actor, 'gift')).toBe(false);
			expect(canReadProduct(restored, actor, 'shared')).toBe(true);
			expect(() => requireMediaAccess(restored, actor, 'photo')).toThrow('Image not found.');
			expect(await readFile(join(destination, 'media/photo/original'), 'utf8')).toBe('original');
			expect(await readFile(join(destination, 'media/photo/preview.webp'), 'utf8')).toBe('preview');
			const replay = await listDelete(
				restored,
				event(actor, '/api/lists/visible', 'DELETE', command),
				'visible'
			);
			expect(replay.status).toBe(200);
			expect(await replay.json()).toEqual(acknowledgement);
			for (const { table, rows } of retained)
				expect(restored.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(
					rows
				);
		} finally {
			restored.close();
		}
		const live = new Database(source.databasePath, { readonly: true });
		try {
			for (const { table, rows } of retained)
				expect(live.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(rows);
			expect(live.prepare('SELECT COUNT(*) AS count FROM session').get()).toEqual({ count: 3 });
		} finally {
			live.close();
		}
	});
	it('retains deleted ideas, their history and durable Undo through an isolated restore and fresh sign-in', async () => {
		const source = await household();
		const connection = createDatabase({ filename: source.databasePath });
		let deleted: CatalogueActionResult;
		let receipt: unknown;
		let originalEntries: unknown;
		let originalHistory: unknown;
		const event = (actor: CatalogueEvent['locals']['actor'], body: unknown): CatalogueEvent => {
			const url = new URL('http://localhost:4173/api/catalogue-actions');
			return {
				url,
				locals: { actor },
				request: new Request(url, {
					method: 'POST',
					headers: { origin: url.origin, 'content-type': 'application/json' },
					body: JSON.stringify(body)
				})
			};
		};
		try {
			const actor = resolveActor(connection, 'session-admin')!;
			for (const [action, expectedVersion] of [
				['undo', 0],
				['purchase', 1]
			] as const) {
				const response = await allocationPost(
					connection,
					event(actor, {
						actionId: randomUUID(),
						action,
						expectedVersion,
						...(action === 'purchase' ? { actualPence: 2500 } : {})
					}),
					'entry'
				);
				expect(response.status).toBe(200);
			}
			originalEntries = connection.sqlite.prepare('SELECT * FROM entries').all();
			originalHistory = connection.sqlite
				.prepare('SELECT * FROM allocation_history ORDER BY id')
				.all();
			const command = { operationId: randomUUID(), kind: 'delete', productIds: ['gift'] };
			const review = await catalogueActionsPost(connection, event(actor, command));
			expect(review.status).toBe(409);
			const impact = ((await review.json()) as CatalogueActionError).impact!;
			const response = await catalogueActionsPost(
				connection,
				event(actor, { ...command, impactFingerprint: impact.fingerprint })
			);
			expect(response.status).toBe(200);
			deleted = (await response.json()) as CatalogueActionResult;
			receipt = connection.sqlite.prepare('SELECT * FROM catalogue_actions').all();
		} finally {
			connection.close();
		}
		await createBackup(source);
		const destination = join(source.root, 'restored-with-undo');
		await restoreBackup({ source: source.destination, destination });
		const restored = createDatabase({ filename: join(destination, 'gifts.sqlite') });
		try {
			expect(restored.sqlite.prepare('SELECT COUNT(*) AS count FROM session').get()).toEqual({
				count: 0
			});
			const now = Date.now();
			restored.sqlite
				.prepare(
					'INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)'
				)
				.run('fresh-admin', 'admin', 'fresh-token', now + 3600000, now, now);
			const actor = resolveActor(restored, 'fresh-admin', {
				administratorEmail: 'admin@example.test'
			})!;
			expect(actor.administrator).toBe(true);
			expect(canReadProduct(restored, actor, 'gift')).toBe(false);
			expect(() => requireMediaAccess(restored, actor, 'photo')).toThrow('Image not found.');
			expect(calculateListTotals(restored, actor, 'visible').all.count).toBe(0);
			expect(restored.sqlite.prepare('SELECT * FROM catalogue_actions').all()).toEqual(receipt);
			expect(
				restored.sqlite.prepare('SELECT action_id FROM catalogue_latest_actions').get()
			).toEqual({ action_id: deleted.undo!.actionId });
			expect(restored.sqlite.prepare('SELECT * FROM entries').all()).toEqual(originalEntries);
			expect(restored.sqlite.prepare('SELECT * FROM allocation_history ORDER BY id').all()).toEqual(
				originalHistory
			);
			expect(await readFile(join(destination, 'media/photo/original'), 'utf8')).toBe('original');
			expect(await readFile(join(destination, 'media/photo/preview.webp'), 'utf8')).toBe('preview');
			const undone = await catalogueActionsUndoPost(
				restored,
				event(actor, { operationId: randomUUID(), expectedActionId: deleted.undo!.actionId })
			);
			expect(undone.status).toBe(200);
			expect(((await undone.json()) as CatalogueActionResult).undo).toBeNull();
			expect(canReadProduct(restored, actor, 'gift')).toBe(true);
			expect(requireMediaAccess(restored, actor, 'photo').productId).toBe('gift');
			expect(calculateListTotals(restored, actor, 'visible').purchased).toMatchObject({
				count: 1,
				pence: 2500
			});
			expect(restored.sqlite.prepare('SELECT * FROM entries').all()).toEqual(originalEntries);
			expect(restored.sqlite.prepare('SELECT * FROM allocation_history ORDER BY id').all()).toEqual(
				originalHistory
			);
		} finally {
			restored.close();
		}
		const live = new Database(source.databasePath, { readonly: true });
		try {
			expect(live.prepare('SELECT deletion_token FROM products').get()).toEqual({
				deletion_token: deleted.undo!.actionId
			});
			expect(live.prepare('SELECT COUNT(*) AS count FROM catalogue_actions').get()).toEqual({
				count: 1
			});
			expect(live.prepare('SELECT COUNT(*) AS count FROM session').get()).toEqual({ count: 3 });
		} finally {
			live.close();
		}
	});
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
			expect(
				db
					.prepare(
						'SELECT actor_id,operation_id,fingerprint,state,result_json,reserved_microdollars FROM gemini_capture_requests ORDER BY operation_id'
					)
					.all()
			).toEqual([
				{
					actor_id: 'admin',
					operation_id: 'gemini-complete',
					fingerprint: 'complete-evidence',
					state: 'complete',
					result_json: '{"suggestions":[],"message":"No reliable price"}',
					reserved_microdollars: 20000
				},
				{
					actor_id: 'admin',
					operation_id: 'gemini-running',
					fingerprint: 'running-evidence',
					state: 'running',
					result_json: null,
					reserved_microdollars: 20000
				}
			]);
			expect(
				db
					.prepare(
						'SELECT (SELECT sum(amount_microdollars) FROM allowance_reservations) + (SELECT sum(reserved_microdollars) FROM gemini_capture_requests) AS total'
					)
					.get()
			).toEqual({ total: 47000 });
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
