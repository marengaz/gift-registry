import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { fixture } from './identity-fixture';
import { canCapture, canReadProduct, listRole, visibleEntries } from '../../src/lib/server/access';
import {
	listPatch,
	listsGet,
	listsPost,
	parseCapture,
	productGet,
	productPatch,
	productsGet,
	productsPost,
	saveCapture,
	type CatalogueEvent
} from '../../src/lib/server/catalogue';
import { allocationGet, allocationPost, myGiftsGet } from '../../src/lib/server/allocations';
import { listTotalsGet } from '../../src/lib/server/totals';
import {
	acceptInvitation,
	createInvitation,
	peopleSettings,
	setGrant
} from '../../src/lib/server/invitations';
import { ownIdentity } from '../../src/lib/server/people-api';
import { capturesPost } from '../../src/lib/server/capture-sync';
import {
	catalogueActionsPost,
	catalogueActionsUndoPost
} from '../../src/lib/server/catalogue-actions';
import { mediaGet, prepareMedia } from '../../src/lib/server/media';
import { captureDuplicates } from '../../src/lib/server/capture-duplicates';
import {
	confirmSuggestion,
	identifyGet,
	identifyPost,
	runNextJob
} from '../../src/lib/server/enrichment/jobs';

let model: ReturnType<typeof fixture>;
let directory: string;
beforeEach(() => {
	model = fixture();
	directory = mkdtempSync(join(tmpdir(), 'gift-list-boundaries-'));
	joinFamily('guest');
	joinFamily('other');
});
afterEach(() => {
	model.connection.close();
	rmSync(directory, { recursive: true, force: true });
});
function joinFamily(id: 'guest' | 'other') {
	acceptInvitation(
		model.connection,
		model.actor(id),
		createInvitation(model.connection, model.admin, {
			email: `${id}@example.test`,
			grants: [{ listId: 'visible', role: 'contributor' }]
		}).token
	);
}
function event(id = 'admin', body?: unknown, query = ''): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/products' + query);
	return {
		url,
		locals: { actor: model.actor(id) },
		request: new Request(url, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { origin: url.origin, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	};
}
function item(listIds = ['visible'], id = 'guest') {
	return saveCapture(
		model.connection,
		model.actor(id),
		parseCapture({ title: 'Kept idea', listIds, estimatePence: 1200 })
	);
}
function removeList(id = 'visible') {
	model.connection.sqlite.prepare('UPDATE lists SET deleted_at=1 WHERE id=?').run(id);
}
function rows(table: 'entries' | 'allocation_history' | 'grants') {
	return model.connection.sqlite
		.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'grants' ? 'user_id,list_id' : 'id'}`)
		.all();
}
async function action(body: unknown) {
	return catalogueActionsPost(model.connection, event('admin', body));
}
async function undo(actionId: string) {
	return catalogueActionsUndoPost(
		model.connection,
		event('admin', { operationId: randomUUID(), expectedActionId: actionId })
	);
}

describe('deleted list boundaries with retained memberships', () => {
	it('removes list, entry, identity and grant projections for administrator and every relative role', async () => {
		const gift = item();
		const before = rows('grants');
		removeList();
		for (const role of ['contributor', 'buyer', 'viewer'] as const) {
			model.connection.sqlite.prepare("UPDATE grants SET role=? WHERE user_id='guest'").run(role);
			expect(canCapture(model.connection, model.actor('guest'))).toBe(false);
			for (const id of ['admin', 'guest']) {
				expect(listRole(model.connection, model.actor(id), 'visible')).toBeNull();
				expect(visibleEntries(model.connection, model.actor(id), { productId: gift.id })).toEqual(
					[]
				);
				expect((await listsGet(model.connection, event(id), 'visible')).status).toBe(404);
				expect(
					(await (await listsGet(model.connection, event(id))).json()).lists.map(
						(l: { id: string }) => l.id
					)
				).not.toContain('visible');
				expect(
					(await (await ownIdentity(model.connection, event(id))).json()).lists.map(
						(l: { id: string }) => l.id
					)
				).not.toContain('visible');
			}
		}
		expect(peopleSettings(model.connection, model.admin).grants).toEqual([]);
		expect(rows('grants')).toHaveLength(before.length);
		expect((await (await listsGet(model.connection, event())).json()).administratorId).toBe(
			'admin'
		);
		expect((await (await listsGet(model.connection, event())).json()).lists[0]).not.toHaveProperty(
			'deletedAt'
		);
		expect(await (await listsGet(model.connection, event('guest'))).json()).not.toHaveProperty(
			'administratorId'
		);
	});
	it('returns kept ideas to their author inbox while hidden memberships still prevent that fallback', async () => {
		const kept = item();
		const hidden = item(['visible', 'secret'], 'admin');
		model.connection.sqlite
			.prepare("UPDATE products SET contributor_id='guest' WHERE id=?")
			.run(hidden.id);
		model.connection.sqlite.exec("UPDATE lists SET archived_at=1 WHERE id='secret'");
		removeList();
		expect(canReadProduct(model.connection, model.actor('guest'), kept.id)).toBe(true);
		expect(canReadProduct(model.connection, model.actor('other'), kept.id)).toBe(false);
		expect(canReadProduct(model.connection, model.actor('guest'), hidden.id)).toBe(false);
		expect((await productGet(model.connection, event('guest'), kept.id)).status).toBe(200);
		const inbox = await (
			await productsGet(model.connection, event('guest', undefined, '?inbox=1'))
		).json();
		expect(inbox.products.map((p: { id: string }) => p.id)).toEqual([kept.id]);
		expect(inbox.products[0].entries).toEqual([]);
		expect(
			(
				await (await productsGet(model.connection, event('admin', undefined, '?unlisted=1'))).json()
			).products.map((p: { id: string }) => p.id)
		).toEqual([kept.id]);
	});
	it('allows shared and kept edits without erasing available or purchased historical rows and history', async () => {
		const shared = item(['visible', 'secret'], 'admin');
		const kept = item(['visible'], 'admin');
		setGrant(model.connection, model.admin, 'guest', { listId: 'secret', role: 'viewer' });
		const bought = shared.entries.find((entry) => entry.listId === 'visible')!;
		for (const [index, action] of ['reserve', 'purchase'].entries()) {
			expect(
				(
					await allocationPost(
						model.connection,
						event('admin', { actionId: randomUUID(), expectedVersion: index, action }),
						bought.id
					)
				).status
			).toBe(200);
		}
		removeList();
		const relativeShared = await (
			await productGet(model.connection, event('guest'), shared.id)
		).json();
		expect(relativeShared.entries.map((entry: { listId: string }) => entry.listId)).toEqual([
			'secret'
		]);
		expect(canReadProduct(model.connection, model.actor('other'), shared.id)).toBe(false);
		const historical = rows('entries').filter(
			(entry) => (entry as { list_id: string }).list_id === 'visible'
		);
		const history = rows('allocation_history');
		for (const [productId, listIds] of [
			[shared.id, ['secret']],
			[kept.id, []]
		] as const) {
			expect(
				(
					await productPatch(
						model.connection,
						event('admin', { title: 'Edited', listIds }),
						productId
					)
				).status
			).toBe(200);
		}
		expect(
			rows('entries').filter((entry) => (entry as { list_id: string }).list_id === 'visible')
		).toEqual(historical);
		expect(rows('allocation_history')).toEqual(history);
		expect(
			(
				await productPatch(
					model.connection,
					event('admin', { title: 'Stale target', listIds: ['visible', 'secret'] }),
					shared.id
				)
			).status
		).toBe(403);
	});
	it('denies buying detail, history, commands and receipt replay on a deleted list and retains raw records', async () => {
		const gift = item();
		const command = { actionId: randomUUID(), expectedVersion: 0, action: 'reserve' };
		expect(
			(await allocationPost(model.connection, event('guest', command), gift.entries[0].id)).status
		).toBe(200);
		removeList();
		const before = rows('entries');
		const history = rows('allocation_history');
		for (const id of ['admin', 'guest']) {
			expect((await allocationGet(model.connection, event(id), gift.entries[0].id)).status).toBe(
				404
			);
			expect(
				(
					await allocationPost(
						model.connection,
						event(id, { actionId: randomUUID(), expectedVersion: 1, action: 'purchase' }),
						gift.entries[0].id
					)
				).status
			).toBe(404);
			expect((await (await myGiftsGet(model.connection, event(id))).json()).products).toEqual([]);
		}
		expect(
			(await allocationPost(model.connection, event('guest', command), gift.entries[0].id)).status
		).toBe(404);
		expect((await listTotalsGet(model.connection, event(), 'visible')).status).toBe(404);
		expect(rows('entries')).toEqual(before);
		expect(rows('allocation_history')).toEqual(history);
	});
	it('cannot restore a deleted list and permits a fresh replacement without inheriting old grants', async () => {
		removeList();
		expect(
			(await listPatch(model.connection, event('admin', { archived: false }), 'visible')).status
		).toBe(404);
		const replacement = await listsPost(
			model.connection,
			event('admin', { recipientId: 'child', name: 'New birthday', occasion: 'Birthday' })
		);
		expect(replacement.status).toBe(200);
		const next = await replacement.json();
		expect(next.id).not.toBe('visible');
		expect(listRole(model.connection, model.actor('guest'), next.id)).toBeNull();
		expect(
			(
				await listsPost(
					model.connection,
					event('admin', { recipientId: 'child', name: 'Duplicate', occasion: 'Christmas' })
				)
			).status
		).toBe(409);
	});
	it('freshly authorises archive changes after reading the request body', async () => {
		const request = event('admin', { archived: true });
		request.request.json = async () => {
			model.connection.sqlite.exec("DELETE FROM session WHERE user_id='admin'");
			return { archived: true };
		};
		expect((await listPatch(model.connection, request, 'visible')).status).toBe(401);
		expect(
			model.connection.sqlite.prepare("SELECT archived_at FROM lists WHERE id='visible'").get()
		).toEqual({ archived_at: null });
	});
	it('preserves administrator inspection and existing buying transitions on hidden current lists', async () => {
		const gift = item();
		const entryId = gift.entries[0].id;
		expect(
			(
				await allocationPost(
					model.connection,
					event('guest', { actionId: randomUUID(), expectedVersion: 0, action: 'reserve' }),
					entryId
				)
			).status
		).toBe(200);
		expect(
			(await listPatch(model.connection, event('admin', { archived: true }), 'visible')).status
		).toBe(200);
		expect(listRole(model.connection, model.admin, 'visible')).toBe('contributor');
		expect((await listsGet(model.connection, event('guest'), 'visible')).status).toBe(404);
		expect((await productGet(model.connection, event('guest'), gift.id)).status).toBe(404);
		expect((await listsGet(model.connection, event(), 'visible')).status).toBe(200);
		expect((await listTotalsGet(model.connection, event(), 'visible')).status).toBe(200);
		expect(
			(
				await productPatch(
					model.connection,
					event('admin', { title: 'Still hidden', listIds: ['visible'] }),
					gift.id
				)
			).status
		).toBe(200);
		expect(
			(
				await allocationPost(
					model.connection,
					event('admin', { actionId: randomUUID(), expectedVersion: 1, action: 'purchase' }),
					entryId
				)
			).status
		).toBe(200);
		const history = rows('allocation_history');
		expect(
			(await listPatch(model.connection, event('admin', { archived: false }), 'visible')).status
		).toBe(200);
		expect((await allocationGet(model.connection, event('guest'), entryId)).status).toBe(200);
		expect(rows('allocation_history')).toEqual(history);
	});
	it('rejects deleted targets atomically for new invitations, new grants and pending acceptance', () => {
		const pending = createInvitation(model.connection, model.admin, {
			email: 'other@example.test',
			grants: [
				{ listId: 'secret', role: 'viewer' },
				{ listId: 'visible', role: 'buyer' }
			]
		});
		removeList();
		const before = rows('grants');
		expect(() =>
			createInvitation(model.connection, model.admin, {
				email: 'new@example.test',
				grants: [{ listId: 'visible', role: 'buyer' }]
			})
		).toThrow('active list');
		expect(() =>
			setGrant(model.connection, model.admin, 'guest', { listId: 'visible', role: 'buyer' })
		).toThrow('active list');
		expect(() => acceptInvitation(model.connection, model.actor('other'), pending.token)).toThrow(
			'active list'
		);
		expect(rows('grants')).toEqual(before);
		expect(
			model.connection.sqlite
				.prepare('SELECT accepted_at FROM invitations WHERE id=?')
				.get(pending.id)
		).toEqual({ accepted_at: null });
	});
	it('rejects stale capture and catalogue destinations but acknowledges old capture receipts minimally', async () => {
		const operationId = randomUUID();
		const request = () =>
			event('guest', {
				ownerId: 'guest',
				operationId,
				draft: { title: 'Capture', listIds: ['visible'] }
			});
		const saved = await (
			await capturesPost(model.connection, request(), { mediaRoot: directory })
		).json();
		removeList();
		const replay = await capturesPost(model.connection, request(), { mediaRoot: directory });
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(saved);
		expect(Object.keys(saved).sort()).toEqual(['entryIds', 'operationId', 'productId']);
		const stale = await capturesPost(
			model.connection,
			event('admin', {
				ownerId: 'admin',
				operationId: randomUUID(),
				draft: { title: 'Stale', listIds: ['visible'] }
			}),
			{ mediaRoot: directory }
		);
		expect(stale.status).toBe(403);
		expect(await stale.json()).toMatchObject({ editable: true });
		expect(
			(
				await productsPost(
					model.connection,
					event('admin', { title: 'Raw target', listIds: ['visible'] })
				)
			).status
		).toBe(403);
		expect(
			(
				await action({
					operationId: randomUUID(),
					kind: 'add',
					productIds: [saved.productId],
					listIds: ['secret', 'visible']
				})
			).status
		).toBe(409);
		expect(rows('entries')).toHaveLength(1);
	});
	it('rejects add Undo that would erase retained rows while unrelated Undo remains available', async () => {
		const gift = item([], 'admin');
		const added = await (
			await action({
				operationId: randomUUID(),
				kind: 'add',
				productIds: [gift.id],
				listIds: ['visible']
			})
		).json();
		removeList();
		const before = rows('entries');
		const rejected = await undo(added.acknowledgement.actionId);
		expect(rejected.status).toBe(409);
		expect(await rejected.json()).toMatchObject({ reason: 'unsafe-undo' });
		expect(rows('entries')).toEqual(before);
		const unrelated = await (
			await action({
				operationId: randomUUID(),
				kind: 'add',
				productIds: [gift.id],
				listIds: ['secret']
			})
		).json();
		expect((await undo(unrelated.acknowledgement.actionId)).status).toBe(200);
		expect(rows('entries')).toEqual(before);
		const removed = await (
			await action({ operationId: randomUUID(), kind: 'delete', productIds: [gift.id] })
		).json();
		expect((await undo(removed.acknowledgement.actionId)).status).toBe(200);
		expect(
			model.connection.sqlite.prepare("SELECT deleted_at FROM lists WHERE id='visible'").get()
		).toEqual({ deleted_at: 1 });
		expect(rows('entries')).toEqual(before);
	});
	it('ignores deleted historical estimates when adding a kept idea to a current list', async () => {
		const gift = item(['visible'], 'admin');
		removeList();
		const response = await action({
			operationId: randomUUID(),
			kind: 'add',
			productIds: [gift.id],
			listIds: ['secret']
		});
		expect(response.status).toBe(200);
		expect(
			model.connection.sqlite
				.prepare("SELECT estimate_pence FROM entries WHERE product_id=? AND list_id='secret'")
				.get(gift.id)
		).toEqual({ estimate_pence: null });
	});
	it('keeps live unlisted media and local enrichment usable, while product tombstones revoke both', async () => {
		const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'green' } })
			.png()
			.toBuffer();
		const prepared = await prepareMedia([new File([png], 'idea.png', { type: 'image/png' })], {
			mediaRoot: directory
		});
		const gift = saveCapture(
			model.connection,
			model.admin,
			parseCapture({
				title: 'Photo idea',
				listIds: ['visible'],
				sourceUrl: 'https://shop.example/idea'
			}),
			prepared.media
		);
		const queued = await (
			await identifyPost(
				model.connection,
				event('admin', { operationId: randomUUID(), kind: 'metadata' }),
				gift.id
			)
		).json();
		removeList();
		expect(
			(await mediaGet(model.connection, event(), gift.media[0].id, { mediaRoot: directory })).status
		).toBe(200);
		expect(
			(await mediaGet(model.connection, event('other'), gift.media[0].id, { mediaRoot: directory }))
				.status
		).toBe(404);
		let fetched = 0;
		const fetchPage = async () => {
			fetched++;
			return {
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: Buffer.from(
					'<script type="application/ld+json">{"@type":"Product","name":"Identified idea"}</script>'
				),
				url: 'https://shop.example/idea'
			};
		};
		await runNextJob(model.connection, { fetchPage });
		expect(fetched).toBe(1);
		expect(
			(
				await confirmSuggestion(
					model.connection,
					event('admin', { jobId: queued.id, index: 0, fields: ['title'] }),
					gift.id
				)
			).status
		).toBe(200);
		expect(
			(
				await (
					await captureDuplicates(
						model.connection,
						event('admin', undefined, '?url=https%3A%2F%2Fshop.example%2Fidea')
					)
				).json()
			).matches
		).toEqual([{ id: gift.id, title: 'Identified idea' }]);
		await identifyPost(
			model.connection,
			event('admin', { operationId: randomUUID(), kind: 'metadata' }),
			gift.id
		);
		model.connection.sqlite
			.prepare('UPDATE products SET deleted_at=1,deletion_token=? WHERE id=?')
			.run('list-cleanup', gift.id);
		for (const query of ['', '?original=1'])
			expect(
				(
					await mediaGet(model.connection, event('admin', undefined, query), gift.media[0].id, {
						mediaRoot: directory
					})
				).status
			).toBe(404);
		expect((await identifyGet(model.connection, event(), gift.id)).status).toBe(404);
		expect(
			(
				await confirmSuggestion(
					model.connection,
					event('admin', { jobId: queued.id, index: 0, fields: ['title'] }),
					gift.id
				)
			).status
		).toBe(404);
		expect(
			(
				await (
					await captureDuplicates(
						model.connection,
						event('admin', undefined, '?url=https%3A%2F%2Fshop.example%2Fidea')
					)
				).json()
			).matches
		).toEqual([]);
		await runNextJob(model.connection, { fetchPage });
		expect(fetched).toBe(1);
	});
});
