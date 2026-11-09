import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import { createDatabase, migrateDatabase } from '../../src/lib/server/db/client';
import {
	catalogueActionsGet,
	catalogueActionsPost,
	catalogueActionsUndoPost
} from '../../src/lib/server/catalogue-actions';
import { allocationPost } from '../../src/lib/server/allocations';
import { productPatch, type CatalogueEvent } from '../../src/lib/server/catalogue';
import type {
	CatalogueActionRequest,
	CatalogueActionResult,
	CatalogueActionStatus,
	CatalogueActionError
} from '../../src/lib/shared/catalogue-actions';

let context: ReturnType<typeof fixture>;
beforeEach(() => {
	context = fixture();
	context.connection.sqlite.exec(
		"INSERT INTO products(id,title,contributor_id) VALUES ('game','Game','admin'),('book','Book','admin')"
	);
});
afterEach(() => context.connection.close());
function event(
	body?: unknown,
	actor: string | null = 'admin',
	origin = 'http://localhost:4173'
): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/catalogue-actions');
	return {
		url,
		locals: { actor: actor ? context.actor(actor) : null },
		request: new Request(url, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { origin, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	};
}
const add = (productIds = ['game'], listIds = ['visible']): CatalogueActionRequest => ({
	operationId: randomUUID(),
	kind: 'add',
	productIds,
	listIds
});
const deletion = (productIds = ['game'], impactFingerprint?: string): CatalogueActionRequest => ({
	operationId: randomUUID(),
	kind: 'delete',
	productIds,
	...(impactFingerprint ? { impactFingerprint } : {})
});
async function act(input: CatalogueActionRequest) {
	const response = await catalogueActionsPost(context.connection, event(input));
	expect(response.status).toBe(200);
	return (await response.json()) as CatalogueActionResult;
}
async function status() {
	return (await (
		await catalogueActionsGet(context.connection, event())
	).json()) as CatalogueActionStatus;
}
async function undo(actionId: string, operationId = randomUUID()) {
	return catalogueActionsUndoPost(
		context.connection,
		event({ operationId, expectedActionId: actionId })
	);
}
function rows(table: 'entries' | 'products' | 'catalogue_actions' | 'allocation_history') {
	return context.connection.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}
async function buy(entryId: string, action: string, expectedVersion: number) {
	const response = await allocationPost(
		context.connection,
		event({ actionId: randomUUID(), action, expectedVersion }),
		entryId
	);
	expect(response.status).toBe(200);
}

describe('durable catalogue action HTTP contract', () => {
	it('adds only missing pairs across five ideas and two lists, preserving existing purchases and estimates', async () => {
		const sql = context.connection.sqlite;
		sql.exec(
			"INSERT INTO products(id,title,contributor_id) VALUES ('a','A','admin'),('b','B','admin'),('c','C','admin'); INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES ('existing-game','game','visible',2050),('existing-book','book','visible',null),('existing-a','a','visible',900)"
		);
		await buy('existing-game', 'reserve', 0);
		await buy('existing-game', 'purchase', 1);
		const before = rows('entries');
		const result = await act(add(['game', 'book', 'a', 'b', 'c'], ['visible', 'secret']));
		expect(result.acknowledgement).toMatchObject({
			effective: true,
			entryCount: 7,
			productCount: 5
		});
		expect(rows('entries')).toHaveLength(10);
		for (const entry of before) expect(rows('entries')).toContainEqual(entry);
		expect(result.administratorId).toBe('admin');
		expect(result.undo?.actionId).toBe(result.acknowledgement.actionId);
	});
	it('canonicalises IDs, retains the current latest pointer on old replay and conflicts on changed intent', async () => {
		const input = add(['book', 'game', 'game'], ['secret', 'visible', 'visible']);
		const first = await act(input);
		const later = await act(deletion(['book']));
		const replay = await act({
			...input,
			productIds: ['game', 'book'],
			listIds: ['visible', 'secret']
		} as CatalogueActionRequest);
		expect(replay.acknowledgement).toEqual(first.acknowledgement);
		expect(replay.undo).toEqual(later.undo);
		expect(rows('catalogue_actions')).toHaveLength(2);
		const conflict = await catalogueActionsPost(
			context.connection,
			event({ ...input, productIds: ['game'] })
		);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ reason: 'operation-reused' });
	});
	it('preserves the previous Undo for no-ops, removes only new entries and never uncovers older actions', async () => {
		await act(add(['game'], ['visible']));
		const latest = await act(add(['game', 'book'], ['visible']));
		const noop = await act(add(['game', 'book'], ['visible']));
		expect(noop.acknowledgement).toMatchObject({ effective: false, entryCount: 0 });
		expect(noop.undo).toEqual(latest.undo);
		expect((await undo(latest.undo!.actionId)).status).toBe(200);
		expect(rows('entries')).toMatchObject([{ product_id: 'game' }]);
		expect((await status()).undo).toBeNull();
	});
	it('compares persisted snapshot values independently of JSON object key order', async () => {
		const result = await act(add());
		const sql = context.connection.sqlite;
		const receipt = sql
			.prepare('SELECT snapshots_json FROM catalogue_actions WHERE id=?')
			.get(result.undo!.actionId) as { snapshots_json: string };
		const snapshots = JSON.parse(receipt.snapshots_json);
		snapshots.entries = snapshots.entries.map((entry: Record<string, unknown>) =>
			Object.fromEntries(Object.entries(entry).reverse())
		);
		sql
			.prepare('UPDATE catalogue_actions SET snapshots_json=? WHERE id=?')
			.run(JSON.stringify(snapshots), result.undo!.actionId);
		expect((await undo(result.undo!.actionId)).status).toBe(200);
	});
	for (const change of ['reserve', 'purchase', 'release', 'estimate', 'history'] as const)
		it(`rejects the whole add Undo after a subsequent ${change}`, async () => {
			const added = await act(add(['game', 'book']));
			const entry = context.connection.sqlite
				.prepare("SELECT id FROM entries WHERE product_id='game'")
				.get() as { id: string };
			if (change === 'estimate') {
				const patched = await productPatch(
					context.connection,
					event({ title: 'Game', listIds: ['visible'], entryEstimates: { visible: 1234 } }),
					'game'
				);
				expect(patched.status).toBe(200);
				expect(
					context.connection.sqlite.prepare('SELECT version FROM entries WHERE id=?').get(entry.id)
				).toEqual({ version: 0 });
			} else {
				await buy(entry.id, 'reserve', 0);
				if (change === 'purchase') await buy(entry.id, 'purchase', 1);
				if (change === 'release' || change === 'history') await buy(entry.id, 'release', 1);
				if (change === 'history') {
					// Even an exact entry reset must not erase the allocation audit trail.
					const original = JSON.parse(
						(
							context.connection.sqlite
								.prepare('SELECT snapshots_json FROM catalogue_actions WHERE id=?')
								.get(added.undo!.actionId) as { snapshots_json: string }
						).snapshots_json
					).entries.find((item: { id: string }) => item.id === entry.id);
					context.connection.sqlite
						.prepare('UPDATE entries SET version=?,updated_at=?,allocated_at=? WHERE id=?')
						.run(original.version, original.updatedAt, original.allocatedAt, entry.id);
				}
			}
			const before = rows('entries');
			const response = await undo(added.undo!.actionId);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ reason: 'unsafe-undo' });
			expect(rows('entries')).toEqual(before);
		});
	it('retains photographs, capture receipts and buying history through delete and exact Undo', async () => {
		await act(add(['game', 'book']));
		const entry = context.connection.sqlite
			.prepare("SELECT id FROM entries WHERE product_id='game'")
			.get() as { id: string };
		await buy(entry.id, 'reserve', 0);
		await buy(entry.id, 'purchase', 1);
		context.connection.sqlite.exec(
			"INSERT INTO media(id,product_id,storage_path,mime_type,byte_size) VALUES ('photo','game','private-photo.jpg','image/jpeg',1); INSERT INTO capture_receipts(actor_id,operation_id,product_id,result_json) VALUES ('admin','capture','game','{}')"
		);
		const before = {
			products: rows('products'),
			entries: rows('entries'),
			history: rows('allocation_history')
		};
		const review = await catalogueActionsPost(
			context.connection,
			event(deletion(['game', 'book']))
		);
		expect(review.status).toBe(409);
		const impact = ((await review.json()) as CatalogueActionError).impact!;
		expect(impact).toMatchObject({ allocatedCount: 0, purchasedCount: 1 });
		const deleted = await act(deletion(['game', 'book'], impact.fingerprint));
		expect(deleted.acknowledgement).toMatchObject({ productCount: 2, entryCount: 2 });
		expect(rows('products')).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'game',
					deletion_token: deleted.acknowledgement.actionId,
					deleted_at: expect.any(Number)
				})
			])
		);
		expect(rows('entries')).toEqual(before.entries);
		expect(rows('allocation_history')).toEqual(before.history);
		expect((await undo(deleted.undo!.actionId)).status).toBe(200);
		expect(rows('products')).toEqual(before.products);
		expect(context.connection.sqlite.prepare('SELECT id FROM media').all()).toEqual([
			{ id: 'photo' }
		]);
		expect(
			context.connection.sqlite.prepare('SELECT operation_id FROM capture_receipts').all()
		).toEqual([{ operation_id: 'capture' }]);
	});
	it('refreshes confirmation when a reservation changes and refuses a blind confirmation boolean', async () => {
		await act(add(['game', 'book']));
		const entries = context.connection.sqlite
			.prepare('SELECT id FROM entries ORDER BY product_id')
			.all() as { id: string }[];
		await buy(entries[0].id, 'reserve', 0);
		const input = deletion(['game', 'book']);
		const review = await catalogueActionsPost(context.connection, event(input));
		const impact = ((await review.json()) as CatalogueActionError).impact!;
		await buy(entries[1].id, 'reserve', 0);
		const confirmed = { ...input, impactFingerprint: impact.fingerprint };
		const changed = await catalogueActionsPost(context.connection, event(confirmed));
		expect(changed.status).toBe(409);
		const refreshed = ((await changed.json()) as CatalogueActionError).impact!;
		expect(refreshed.allocatedCount).toBe(2);
		expect(refreshed.fingerprint).not.toBe(impact.fingerprint);
		expect(rows('products')).toEqual(
			expect.arrayContaining([expect.objectContaining({ deleted_at: null })])
		);
		expect(
			(await catalogueActionsPost(context.connection, event({ ...input, confirmed: true }))).status
		).toBe(400);
		await act({ ...input, impactFingerprint: refreshed.fingerprint } as CatalogueActionRequest);
	});
	it('requires refreshed confirmation even when the reviewed non-available impact disappears', async () => {
		await act(add());
		const entry = (rows('entries')[0] as { id: string }).id;
		await buy(entry, 'reserve', 0);
		const review = await catalogueActionsPost(context.connection, event(deletion()));
		const impact = ((await review.json()) as CatalogueActionError).impact!;
		await buy(entry, 'release', 1);
		const response = await catalogueActionsPost(
			context.connection,
			event(deletion(['game'], impact.fingerprint))
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			reason: 'refresh-impact',
			impact: { allocatedCount: 0, purchasedCount: 0 }
		});
	});
	for (const tamper of ['token', 'product', 'entry', 'membership'] as const)
		it(`rejects delete Undo atomically when its ${tamper} snapshot changes`, async () => {
			await act(add(['game', 'book']));
			const deleted = await act(deletion(['game', 'book']));
			const sql = context.connection.sqlite;
			if (tamper === 'token')
				sql.exec("UPDATE products SET deletion_token='different' WHERE id='game'");
			if (tamper === 'product') sql.exec("UPDATE products SET title='Edited' WHERE id='game'");
			if (tamper === 'entry')
				sql.exec("UPDATE entries SET estimate_pence=9 WHERE product_id='game'");
			if (tamper === 'membership')
				sql.exec("INSERT INTO entries(id,product_id,list_id) VALUES ('later','game','secret')");
			const before = rows('products');
			expect((await undo(deleted.undo!.actionId)).status).toBe(409);
			expect(rows('products')).toEqual(before);
		});
	it('rejects missing/deleted ideas and archived lists atomically without replacing prior Undo', async () => {
		const initial = await act(add());
		for (const input of [
			add(['book', 'missing']),
			deletion(['book', 'missing']),
			add(['book'], ['visible', 'missing'])
		]) {
			expect((await catalogueActionsPost(context.connection, event(input))).status).toBe(409);
			expect((await status()).undo).toEqual(initial.undo);
		}
		context.connection.sqlite.exec("UPDATE lists SET archived_at=1 WHERE id='secret'");
		expect(
			(await catalogueActionsPost(context.connection, event(add(['book'], ['visible', 'secret']))))
				.status
		).toBe(409);
		expect(rows('entries')).toHaveLength(1);
		const deleted = await act(deletion(['book']));
		for (const input of [deletion(['book']), add(['game', 'book'])])
			expect((await catalogueActionsPost(context.connection, event(input))).status).toBe(409);
		expect((await status()).undo).toEqual(deleted.undo);
	});
	it('rolls back every new pair and its receipt if a later SQLite write fails', async () => {
		context.connection.sqlite.exec(
			"CREATE TRIGGER reject_second BEFORE INSERT ON entries WHEN NEW.list_id='visible' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END"
		);
		await expect(
			catalogueActionsPost(context.connection, event(add(['game'], ['secret', 'visible'])))
		).rejects.toThrow('fixture write failure');
		expect(rows('entries')).toHaveLength(0);
		expect(rows('catalogue_actions')).toHaveLength(0);
		expect((await status()).undo).toBeNull();
	});
	it('rejects stale Undo, replays once and reports the current target after later actions', async () => {
		const earlier = await act(add());
		const later = await act(add(['book']));
		expect((await undo(earlier.undo!.actionId)).status).toBe(409);
		const operationId = randomUUID();
		const first = await undo(later.undo!.actionId, operationId);
		expect(first.status).toBe(200);
		expect(((await first.json()) as CatalogueActionResult).undo).toBeNull();
		const newest = await act(deletion(['book']));
		const replay = await undo(later.undo!.actionId, operationId);
		expect(replay.status).toBe(200);
		expect(((await replay.json()) as CatalogueActionResult).undo).toEqual(newest.undo);
		expect((await undo(earlier.undo!.actionId, operationId)).status).toBe(409);
	});
	it('reopens the same persisted latest action and successful receipt without reapplying effects', async () => {
		const input = add();
		const result = await act(input);
		const directory = mkdtempSync(join(tmpdir(), 'gift-action-reopen-'));
		const filename = join(directory, 'fixture.sqlite');
		writeFileSync(filename, context.connection.sqlite.serialize());
		const reopened = createDatabase({ filename });
		try {
			migrateDatabase(reopened);
			const get = await catalogueActionsGet(reopened, event());
			expect(await get.json()).toEqual({ administratorId: 'admin', undo: result.undo });
			const replay = await catalogueActionsPost(reopened, event(input));
			expect(await replay.json()).toEqual(result);
			expect(reopened.sqlite.prepare('SELECT COUNT(*) AS count FROM entries').get()).toEqual({
				count: 1
			});
		} finally {
			reopened.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	for (const scenario of [
		'sole-gbp',
		'same-gbp',
		'conflicting-offers',
		'foreign',
		'unknown',
		'agreed-estimates',
		'missing-estimate',
		'conflicting-estimates',
		'actual-only',
		'archived-only'
	] as const)
		it(`initialises new estimates from ${scenario} evidence only`, async () => {
			const sql = context.connection.sqlite;
			let expected: number | null = null;
			if (
				['sole-gbp', 'same-gbp', 'conflicting-offers', 'foreign', 'archived-only'].includes(
					scenario
				)
			) {
				sql
					.prepare(
						"INSERT INTO offers(id,product_id,url,price_minor,currency) VALUES ('offer','game','https://example.test',2050,?)"
					)
					.run(scenario === 'foreign' ? 'USD' : 'GBP');
				if (['same-gbp', 'conflicting-offers'].includes(scenario))
					sql
						.prepare(
							"INSERT INTO offers(id,product_id,url,price_minor,currency) VALUES ('offer2','game','https://example.test/2',?,'GBP')"
						)
						.run(scenario === 'same-gbp' ? 2050 : 3000);
				if (['sole-gbp', 'same-gbp', 'archived-only'].includes(scenario)) expected = 2050;
			}
			if (
				[
					'agreed-estimates',
					'missing-estimate',
					'conflicting-estimates',
					'actual-only',
					'archived-only'
				].includes(scenario)
			) {
				sql
					.prepare(
						"INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES ('existing','game','secret',?)"
					)
					.run(
						scenario === 'agreed-estimates' || scenario === 'conflicting-estimates' ? 4500 : null
					);
				if (scenario === 'agreed-estimates') expected = 4500;
				if (scenario === 'archived-only')
					sql.exec("UPDATE lists SET archived_at=1 WHERE id='secret'");
				if (scenario === 'actual-only')
					sql.exec(
						"UPDATE entries SET state='purchased',buyer_id='admin',allocated_by_id='admin',allocation_source='self',actual_pence=4500 WHERE id='existing'"
					);
				if (scenario === 'conflicting-estimates') {
					sql.exec(
						"INSERT INTO lists(id,recipient_id,name,occasion) VALUES ('other-list','child','Other','Other'); INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES ('other-entry','game','other-list',7000)"
					);
				}
			}
			await act(add());
			expect(
				sql.prepare("SELECT estimate_pence FROM entries WHERE list_id='visible'").get()
			).toEqual({ estimate_pence: expected });
		});
	it('rejects invalid/empty requests without arbitrary count limits and protects private responses', async () => {
		for (const input of [
			add([], ['visible']),
			add(['game'], []),
			deletion([]),
			{ ...add(), operationId: 'not-a-uuid' }
		])
			expect((await catalogueActionsPost(context.connection, event(input))).status).toBe(400);
		for (const id of [null, 'guest']) {
			expect((await catalogueActionsGet(context.connection, event(undefined, id))).status).toBe(
				id ? 403 : 401
			);
			expect((await catalogueActionsPost(context.connection, event(add(), id))).status).toBe(
				id ? 403 : 401
			);
			expect(
				(
					await catalogueActionsUndoPost(
						context.connection,
						event({ operationId: randomUUID(), expectedActionId: randomUUID() }, id)
					)
				).status
			).toBe(id ? 403 : 401);
		}
		expect(
			(await catalogueActionsPost(context.connection, event(add(), 'admin', 'https://evil.test')))
				.status
		).toBe(403);
		expect(
			(
				await catalogueActionsUndoPost(
					context.connection,
					event(
						{ operationId: randomUUID(), expectedActionId: randomUUID() },
						'admin',
						'https://evil.test'
					)
				)
			).status
		).toBe(403);
		const response = await catalogueActionsGet(context.connection, event());
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('vary')).toBe('Cookie');
	});
	it('rechecks expired sessions and revoked administrator identity even for receipt replay', async () => {
		const input = add();
		await act(input);
		const staleReplay = event(input);
		const staleStatus = event();
		context.connection.sqlite.exec("UPDATE session SET expires_at=1 WHERE id='session-admin'");
		expect((await catalogueActionsPost(context.connection, staleReplay)).status).toBe(401);
		expect((await catalogueActionsGet(context.connection, staleStatus)).status).toBe(401);
		context.connection.sqlite.exec(
			"UPDATE session SET expires_at=9999999999999 WHERE id='session-admin'"
		);
		const revoked = event(input);
		context.connection.sqlite.exec(
			"UPDATE application_settings SET administrator_google_subject='revoked' WHERE id=1"
		);
		expect((await catalogueActionsPost(context.connection, revoked)).status).toBe(403);
	});
	it('processes a selection beyond SQLite single-statement bind capacity without truncating', async () => {
		const sql = context.connection.sqlite;
		const option = (sql.pragma('compile_options') as { compile_options: string }[]).find((row) =>
			row.compile_options.startsWith('MAX_VARIABLE_NUMBER=')
		)?.compile_options;
		const count = Number(option?.split('=')[1] ?? 32766) + 1;
		const ids = Array.from({ length: count }, (_, index) => `bulk-${index}`);
		const insert = sql.prepare('INSERT INTO products(id,title,contributor_id) VALUES (?, ?, ?)');
		sql.transaction(() => {
			for (const id of ids) insert.run(id, id, 'admin');
		})();
		const result = await act(add(ids));
		expect(result.acknowledgement.entryCount).toBe(count);
		expect(sql.prepare('SELECT COUNT(*) AS count FROM entries').get()).toEqual({ count });
	}, 60000);
});
