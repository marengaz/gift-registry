import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import { listDelete, listDeletionImpactGet } from '../../src/lib/server/list-lifecycle';
import { allocationPost } from '../../src/lib/server/allocations';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';
import { catalogueActionsPost } from '../../src/lib/server/catalogue-actions';
import type { CatalogueEvent } from '../../src/lib/server/catalogue';
import type { ListDeleteCommand, ListDeletionImpact } from '../../src/lib/shared/list-lifecycle';

let context: ReturnType<typeof fixture>;
beforeEach(() => {
	context = fixture();
	context.connection.sqlite.exec(`
		INSERT INTO products(id,title,contributor_id) VALUES
		('unique','Unique','admin'),('shared','Shared','admin'),('hidden-shared','Hidden shared','guest'),
		('old','Already deleted','admin'),('unlisted','Previously unlisted','admin');
		INSERT INTO lists(id,recipient_id,name,occasion,archived_at) VALUES ('hidden','child','Hidden','Hidden',100);
		INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES
		('unique-entry','unique','visible',2500),('shared-entry','shared','visible',1000),
		('hidden-entry','hidden-shared','visible',800),('old-entry','old','visible',100),
		('shared-other','shared','secret',1000),('hidden-other','hidden-shared','hidden',800);
		UPDATE products SET deleted_at=99,deletion_token='earlier-action' WHERE id='old';
		INSERT INTO media(id,product_id,storage_path,mime_type,byte_size) VALUES ('photo','unique','fixture.jpg','image/jpeg',1);
		INSERT INTO capture_receipts(actor_id,operation_id,product_id,result_json) VALUES ('admin','capture','unique','{}');
	`);
});
afterEach(() => context.connection.close());
function event(
	body?: unknown,
	actor: string | null = 'admin',
	origin = 'http://localhost:4173'
): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/lists/visible');
	return {
		url,
		locals: { actor: actor ? context.actor(actor) : null },
		request: new Request(url, {
			method: body === undefined ? 'GET' : 'DELETE',
			headers: { origin, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	};
}
async function impact(id = 'visible') {
	const response = await listDeletionImpactGet(context.connection, event(), id);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	return (await response.json()) as ListDeletionImpact;
}
async function command(deleteOrphans = false, id = 'visible'): Promise<ListDeleteCommand> {
	return {
		operationId: randomUUID(),
		deleteOrphans,
		impactFingerprint: (await impact(id)).fingerprint
	};
}
function snapshot() {
	return Object.fromEntries(
		[
			'lists',
			'products',
			'entries',
			'allocation_history',
			'media',
			'capture_receipts',
			'grants',
			'catalogue_actions',
			'catalogue_latest_actions',
			'list_deletion_receipts'
		].map((table) => [
			table,
			context.connection.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
		])
	);
}
async function buy(action: string, expectedVersion: number) {
	const response = await allocationPost(
		context.connection,
		event({ actionId: randomUUID(), action, expectedVersion }),
		'unique-entry'
	);
	expect(response.status).toBe(200);
}
async function remove(input: ListDeleteCommand, id = 'visible') {
	return listDelete(context.connection, event(input), id);
}

describe('administrator list deletion HTTP and SQLite contract', () => {
	it('keeps ideas and all historical rows, counts buying state, and leaves catalogue Undo unchanged', async () => {
		acceptInvitation(
			context.connection,
			context.actor('guest'),
			createInvitation(context.connection, context.admin, {
				email: 'guest@example.test',
				grants: [{ listId: 'visible', role: 'buyer' }]
			}).token
		);
		const addResponse = await catalogueActionsPost(
			context.connection,
			event({
				operationId: randomUUID(),
				kind: 'add',
				productIds: ['unlisted'],
				listIds: ['secret']
			})
		);
		expect(addResponse.status).toBe(200);
		await buy('reserve', 0);
		await buy('purchase', 1);
		const preview = await impact();
		expect(preview).toMatchObject({
			administratorId: 'admin',
			listId: 'visible',
			listName: 'Birthday',
			recipientName: 'Child',
			productCount: 3,
			orphanProductCount: 1,
			allocatedCount: 0,
			purchasedCount: 1
		});
		const before = snapshot();
		const input = {
			operationId: randomUUID(),
			deleteOrphans: false,
			impactFingerprint: preview.fingerprint
		};
		const response = await remove(input);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			administratorId: 'admin',
			listId: 'visible',
			operationId: input.operationId,
			deleteOrphans: false,
			productCount: 3,
			deletedProductCount: 0,
			keptProductCount: 3
		});
		const after = snapshot();
		for (const table of Object.keys(before).filter(
			(table) => !['lists', 'list_deletion_receipts'].includes(table)
		))
			expect(after[table]).toEqual(before[table]);
		expect(after.lists).toEqual(
			(before.lists as Record<string, unknown>[]).map((row) =>
				row.id === 'visible' ? { ...row, deleted_at: expect.any(Number) } : row
			)
		);
		expect(after.list_deletion_receipts).toHaveLength(1);
	});
	it('cleans up exactly newly orphaned live ideas, preserving hidden/shared, unlisted and already deleted ideas', async () => {
		await buy('reserve', 0);
		expect(await impact()).toMatchObject({ allocatedCount: 1, purchasedCount: 0 });
		const before = snapshot();
		const input = await command(true);
		const response = await remove(input);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			productCount: 3,
			deletedProductCount: 1,
			keptProductCount: 2
		});
		const after = snapshot();
		expect(after.products).toEqual(
			(before.products as Record<string, unknown>[]).map((row) =>
				row.id === 'unique'
					? {
							...row,
							deleted_at: expect.any(Number),
							deletion_token: `list-deletion:admin:${input.operationId}`
						}
					: row
			)
		);
		for (const table of [
			'entries',
			'allocation_history',
			'media',
			'capture_receipts',
			'grants',
			'catalogue_actions',
			'catalogue_latest_actions'
		])
			expect(after[table]).toEqual(before[table]);
	});
	it('replays the exact stored acknowledgement after deletion and rejects reused operations with changed intent', async () => {
		const input = await command(true);
		const first = await (await remove(input)).json();
		const before = snapshot();
		const replay = await remove({
			impactFingerprint: input.impactFingerprint,
			deleteOrphans: true,
			operationId: input.operationId
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(first);
		for (const [id, changed] of [
			['visible', { ...input, deleteOrphans: false }],
			['secret', input],
			['visible', { ...input, impactFingerprint: 'different' }]
		] as const) {
			const response = await remove(changed, id);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				reason: 'operation-reused',
				administratorId: 'admin',
				listId: id,
				operationId: changed.operationId
			});
		}
		expect(snapshot()).toEqual(before);
	});
	for (const change of [
		'target membership',
		'other membership',
		'reserve',
		'purchase',
		'release',
		'list state',
		'estimate',
		'actual price',
		'list name',
		'recipient name'
	] as const)
		it(`requires fresh review after changed ${change}, even when keeping ideas`, async () => {
			if (['purchase', 'release', 'actual price'].includes(change)) await buy('reserve', 0);
			if (change === 'actual price') await buy('purchase', 1);
			const input = await command(false);
			const sql = context.connection.sqlite;
			if (change === 'target membership')
				sql.exec(
					"INSERT INTO entries(id,product_id,list_id) VALUES ('added','unlisted','visible')"
				);
			if (change === 'other membership')
				sql.exec("INSERT INTO entries(id,product_id,list_id) VALUES ('added','unique','hidden')");
			if (change === 'reserve') await buy('reserve', 0);
			if (change === 'purchase') await buy('purchase', 1);
			if (change === 'release') await buy('release', 1);
			if (change === 'list state') sql.exec("UPDATE lists SET archived_at=123 WHERE id='visible'");
			if (change === 'estimate')
				sql.exec("UPDATE entries SET estimate_pence=3000 WHERE id='unique-entry'");
			if (change === 'actual price')
				sql.exec("UPDATE entries SET actual_pence=3000 WHERE id='unique-entry'");
			if (change === 'list name') sql.exec("UPDATE lists SET name='Renamed' WHERE id='visible'");
			if (change === 'recipient name')
				sql.exec("UPDATE recipients SET name='New name' WHERE id='child'");
			const before = snapshot();
			const response = await remove(input);
			expect(response.status).toBe(409);
			const conflict = await response.json();
			expect(conflict).toMatchObject({ reason: 'refresh-impact', impact: await impact() });
			expect(conflict.impact.fingerprint).not.toBe(input.impactFingerprint);
			expect(snapshot()).toEqual(before);
			const confirmed = await remove({ ...input, impactFingerprint: conflict.impact.fingerprint });
			expect(confirmed.status).toBe(200);
		});
	it('ignores historical memberships on another deleted list when deciding cleanup', async () => {
		context.connection.sqlite.exec(
			"INSERT INTO lists(id,recipient_id,name,occasion,deleted_at) VALUES ('historical','child','Old','Old',100); INSERT INTO entries(id,product_id,list_id) VALUES ('historical-entry','unique','historical')"
		);
		const before = snapshot();
		const response = await remove(await command(true));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ deletedProductCount: 1 });
		expect(snapshot().entries).toEqual(before.entries);
	});
	it('handles more ideas than a single SQL bind array without truncating cleanup', async () => {
		const sql = context.connection.sqlite;
		const product = sql.prepare(
			"INSERT INTO products(id,title,contributor_id) VALUES (?,?,'admin')"
		);
		const entry = sql.prepare("INSERT INTO entries(id,product_id,list_id) VALUES (?,?,'visible')");
		sql.transaction(() => {
			for (let index = 0; index < 1200; index++) {
				product.run('many-' + index, 'Idea ' + index);
				entry.run('many-entry-' + index, 'many-' + index);
			}
		})();
		const response = await remove(await command(true));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			productCount: 1203,
			deletedProductCount: 1201,
			keptProductCount: 2
		});
		expect(
			sql
				.prepare(
					"SELECT COUNT(*) AS count FROM products WHERE deletion_token LIKE 'list-deletion:%'"
				)
				.get()
		).toEqual({ count: 1201 });
	});
	it('rolls all list and product markers back when receipt storage fails', async () => {
		const input = await command(true);
		context.connection.sqlite.exec(
			"CREATE TRIGGER fail_list_receipt BEFORE INSERT ON list_deletion_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END"
		);
		const before = snapshot();
		await expect(remove(input)).rejects.toThrow('fixture receipt failure');
		expect(snapshot()).toEqual(before);
	});
	it('deletes empty and hidden lists but treats missing or deleted fresh targets as unavailable', async () => {
		for (const id of ['secret', 'hidden']) {
			if (id === 'secret')
				context.connection.sqlite.exec("DELETE FROM entries WHERE list_id='secret'");
			const input = await command(false, id);
			const response = await remove(input, id);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				productCount: id === 'secret' ? 0 : 1,
				deletedProductCount: 0
			});
			const before = snapshot();
			const freshOperationId = randomUUID();
			const unavailable = await remove({ ...input, operationId: freshOperationId }, id);
			expect(unavailable.status).toBe(404);
			expect(await unavailable.json()).toMatchObject({
				reason: 'list-unavailable',
				administratorId: 'admin',
				listId: id,
				operationId: freshOperationId
			});
			expect((await listDeletionImpactGet(context.connection, event(), id)).status).toBe(404);
			expect(snapshot()).toEqual(before);
		}
		const before = snapshot();
		expect(
			(
				await remove(
					{ operationId: randomUUID(), deleteOrphans: false, impactFingerprint: 'missing' },
					'missing'
				)
			).status
		).toBe(404);
		expect((await listDeletionImpactGet(context.connection, event(), 'missing')).status).toBe(404);
		expect(snapshot()).toEqual(before);
	});
	for (const role of ['viewer', 'contributor', 'buyer'] as const)
		it(`denies ${role} impact and mutation without leaking counts`, async () => {
			acceptInvitation(
				context.connection,
				context.actor('guest'),
				createInvitation(context.connection, context.admin, {
					email: 'guest@example.test',
					grants: [{ listId: 'visible', role }]
				}).token
			);
			const input = await command();
			const before = snapshot();
			for (const response of [
				await listDeletionImpactGet(context.connection, event(undefined, 'guest'), 'visible'),
				await listDelete(context.connection, event(input, 'guest'), 'visible')
			]) {
				expect(response.status).toBe(403);
				expect(Object.keys(await response.json())).toEqual(['message']);
			}
			expect(snapshot()).toEqual(before);
		});
	it('requires current permission for impact, first commit and replay, and enforces same origin', async () => {
		const input = await command();
		const stale = event(input);
		const staleGet = event();
		const before = snapshot();
		expect((await listDelete(context.connection, event(input, null), 'visible')).status).toBe(401);
		expect(
			(await listDeletionImpactGet(context.connection, event(undefined, null), 'visible')).status
		).toBe(401);
		expect(
			(
				await listDelete(
					context.connection,
					event(input, 'admin', 'https://elsewhere.test'),
					'visible'
				)
			).status
		).toBe(403);
		context.connection.sqlite.exec("DELETE FROM session WHERE user_id='admin'");
		expect((await listDelete(context.connection, stale, 'visible')).status).toBe(401);
		expect((await listDeletionImpactGet(context.connection, staleGet, 'visible')).status).toBe(401);
		expect(snapshot()).toEqual(before);
	});
	it('rejects revoked administrator rights before replaying a successful receipt', async () => {
		const input = await command();
		const stale = event(input);
		expect((await remove(input)).status).toBe(200);
		context.connection.sqlite.exec(
			"UPDATE application_settings SET administrator_id='other',administrator_google_subject='google-other'"
		);
		const before = snapshot();
		expect((await listDelete(context.connection, stale, 'visible')).status).toBe(403);
		expect(snapshot()).toEqual(before);
	});
	for (const invalid of [
		{},
		{ operationId: 'bad', deleteOrphans: true, impactFingerprint: 'hash' },
		{ operationId: randomUUID(), impactFingerprint: 'hash' },
		{ operationId: randomUUID(), deleteOrphans: false, impactFingerprint: '' }
	])
		it('rejects malformed commands without writing', async () => {
			const before = snapshot();
			expect((await listDelete(context.connection, event(invalid), 'visible')).status).toBe(400);
			expect(snapshot()).toEqual(before);
		});
});
