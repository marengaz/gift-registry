import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fixture } from './identity-fixture';
import {
	acceptInvitation,
	createInvitation,
	setGrant,
	setSiteRole
} from '../../src/lib/server/invitations';
import {
	productsGet,
	productGet,
	productsPost,
	productPatch,
	listsGet,
	listPatch,
	listsPost,
	recipientsPost,
	labelsPost,
	listEntryDelete,
	type CatalogueEvent
} from '../../src/lib/server/catalogue';
import { allocationPost, myGiftsGet } from '../../src/lib/server/allocations';
import { catalogueActionsGet, catalogueActionsPost } from '../../src/lib/server/catalogue-actions';
import { listTotalsGet } from '../../src/lib/server/totals';
import { listDelete, listDeletionImpactGet } from '../../src/lib/server/list-lifecycle';
import { peopleGet, peoplePost } from '../../src/lib/server/people-api';
import { identifyGet, identifyPost } from '../../src/lib/server/enrichment/jobs';
import { canIdentifyProduct } from '../../src/lib/server/access';
import { mediaGet } from '../../src/lib/server/media';
let context: ReturnType<typeof fixture>;
let directory: string;
beforeEach(() => {
	context = fixture();
	directory = mkdtempSync(join(tmpdir(), 'gift-images-'));
});
afterEach(() => {
	context.connection.close();
	rmSync(directory, { recursive: true, force: true });
});
function event(id: string | null, body?: unknown, query = ''): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/products' + query);
	return {
		url,
		locals: { actor: id ? context.actor(id) : null },
		request: new Request(url, {
			method: body ? 'POST' : 'GET',
			headers: { origin: url.origin, 'content-type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {})
		})
	};
}
function invite(role: 'contributor' | 'buyer' | 'viewer', both = false) {
	acceptInvitation(
		context.connection,
		context.actor('guest'),
		createInvitation(context.connection, context.admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role }, ...(both ? [{ listId: 'secret', role }] : [])]
		}).token
	);
}
async function capture(id = 'admin', extra: Record<string, unknown> = {}) {
	const response = await productsPost(
		context.connection,
		event(id, { title: 'Wooden train', listIds: ['visible'], ...extra }),
		{ mediaRoot: directory }
	);
	expect(response.status).toBe(200);
	return response.json();
}
describe('catalogue HTTP resource boundaries', () => {
	it('accepts the editor’s blank source link and returns a validation response for invalid links', async () => {
		const product = await capture('admin', { sourceUrl: '' });
		expect(product.sourceUrl).toBeNull();
		for (const sourceUrl of ['not a link', 'javascript:alert(1)']) {
			const response = await productsPost(
				context.connection,
				event('admin', { title: 'Invalid link', sourceUrl, listIds: [] })
			);
			expect(response.status).toBe(400);
		}
	});
	it('organises recipient lists and labels and searches names or labels as administrator', async () => {
		const recipient = await (
			await recipientsPost(context.connection, event('admin', { name: 'Test child' }))
		).json();
		const list = await (
			await listsPost(
				context.connection,
				event('admin', { recipientId: recipient.id, name: 'Ideas', occasion: null })
			)
		).json();
		expect(list.recipientId).toBe(recipient.id);
		expect((await labelsPost(context.connection, event('admin', { name: 'Age 5' }))).status).toBe(
			200
		);
		await capture('admin', { labels: ['Age 5'], listIds: [list.id] });
		const byLabel = await (
			await productsGet(context.connection, event('admin', undefined, '?q=age%205'))
		).json();
		expect(byLabel.products).toHaveLength(1);
		expect(byLabel.products[0]).toMatchObject({
			title: 'Wooden train',
			contributorId: 'admin',
			contributorName: 'admin'
		});
		expect(
			(await (await productsGet(context.connection, event('admin', undefined, '?q=train'))).json())
				.products
		).toHaveLength(1);
		expect(
			(
				await (
					await productsGet(context.connection, event('admin', undefined, '?unlisted=1'))
				).json()
			).products
		).toHaveLength(0);
	});
	it('saves an own unlisted inbox and independent memberships for contributors and buyers; denies viewers', async () => {
		invite('contributor', true);
		const unlisted = await capture('guest', { listIds: [], estimatePence: null });
		const shared = await capture('guest', { listIds: ['visible', 'secret'], estimatePence: 1250 });
		expect(shared.entries.map((entry: { estimatePence: number }) => entry.estimatePence)).toEqual([
			1250, 1250
		]);
		const inbox = await (
			await productsGet(context.connection, event('guest', undefined, '?inbox=1'))
		).json();
		expect(inbox.products.map((p: { id: string }) => p.id)).toEqual([unlisted.id]);
		expect((await productsGet(context.connection, event('guest'))).status).toBe(403);
		setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: 'buyer' });
		setGrant(context.connection, context.admin, 'guest', { listId: 'secret', role: 'buyer' });
		const buyerIdea = await capture('guest', {
			title: 'Buyer added',
			listIds: ['visible'],
			estimatePence: 1500
		});
		expect(
			(
				await productPatch(
					context.connection,
					event('guest', { title: 'Buyer edited', listIds: ['visible', 'secret'] }),
					buyerIdea.id
				)
			).status
		).toBe(200);
		expect(
			(
				await productPatch(
					context.connection,
					event('guest', { title: 'Cannot remove from buyer list', listIds: ['visible'] }),
					buyerIdea.id
				)
			).status
		).toBe(403);
		const adminIdea = await capture('admin', { title: 'Admin added', listIds: ['visible'] });
		expect(
			(
				await productPatch(
					context.connection,
					event('guest', { title: 'Hijack', listIds: ['visible'] }),
					adminIdea.id
				)
			).status
		).toBe(403);
		setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: 'viewer' });
		setGrant(context.connection, context.admin, 'guest', { listId: 'secret', role: 'viewer' });
		expect(
			(await productsPost(context.connection, event('guest', { title: 'Denied', listIds: [] })))
				.status
		).toBe(403);
	});
	it('rejects invalid or revoked list submissions atomically and checks request origin', async () => {
		invite('contributor');
		for (const target of ['secret', 'missing']) {
			expect(
				(
					await productsPost(
						context.connection,
						event('guest', { title: 'No partial idea', listIds: ['visible', target] })
					)
				).status
			).toBe(403);
			expect(context.connection.sqlite.prepare('SELECT * FROM products').all()).toHaveLength(0);
			expect(context.connection.sqlite.prepare('SELECT * FROM entries').all()).toHaveLength(0);
		}
		const stale = event('guest', { title: 'Revoked', listIds: ['visible'] });
		setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: null });
		expect((await productsPost(context.connection, stale)).status).toBe(403);
		const cross = event('admin', { title: 'Cross origin', listIds: [] });
		cross.request.headers.set('origin', 'https://attacker.example');
		expect((await productsPost(context.connection, cross)).status).toBe(403);
	});
	it('projects memberships and direct IDs without contributor bypass or media leakage', async () => {
		invite('contributor');
		const product = await capture('guest');
		context.connection.sqlite
			.prepare(
				"INSERT INTO entries (id,product_id,list_id) VALUES ('hidden-membership',?,'secret')"
			)
			.run(product.id);
		const visible = await (await productGet(context.connection, event('guest'), product.id)).json();
		expect(visible.entries.map((e: { listId: string }) => e.listId)).toEqual(['visible']);
		expect(visible).not.toHaveProperty('contributorId');
		context.connection.sqlite
			.prepare(
				"UPDATE entries SET state='allocated',buyer_id='other',allocated_by_id='other',allocation_source='self' WHERE product_id=?"
			)
			.run(product.id);
		expect((await productGet(context.connection, event('guest'), product.id)).status).toBe(404);
		context.connection.sqlite
			.prepare(
				"INSERT INTO media (id,product_id,storage_path,mime_type,byte_size) VALUES ('private-image',?,'x/original','image/png',1)"
			)
			.run(product.id);
		expect(
			(
				await mediaGet(context.connection, event('guest'), 'private-image', {
					mediaRoot: directory
				})
			).status
		).toBe(404);
		expect(
			(await mediaGet(context.connection, event(null), 'private-image', { mediaRoot: directory }))
				.status
		).toBe(401);
	});
	it('preserves allocated memberships until explicitly cleared and archives without losing history', async () => {
		invite('contributor');
		const product = await capture();
		context.connection.sqlite
			.prepare(
				"UPDATE entries SET state='allocated',buyer_id='guest',allocated_by_id='admin',allocation_source='administrator' WHERE product_id=?"
			)
			.run(product.id);
		expect(
			(
				await productPatch(
					context.connection,
					event('admin', { title: 'Changed', listIds: [] }),
					product.id
				)
			).status
		).toBe(409);
		expect(
			context.connection.sqlite.prepare('SELECT title FROM products WHERE id=?').get(product.id)
		).toEqual({ title: 'Wooden train' });
		expect(
			(await listPatch(context.connection, event('admin', { archived: true }), 'visible')).status
		).toBe(200);
		expect((await (await listsGet(context.connection, event('guest'))).json()).lists).toHaveLength(
			0
		);
		expect(
			(await (await listsGet(context.connection, event('admin'))).json()).lists.find(
				(l: { id: string }) => l.id === 'visible'
			).archivedAt
		).toBeTypeOf('number');
		expect(
			(
				await productsPost(
					context.connection,
					event('admin', { title: 'Archived target', listIds: ['visible'] })
				)
			).status
		).toBe(403);
		expect((await productGet(context.connection, event('admin'), product.id)).status).toBe(200);
	});
	it('keeps explicit unknown estimates and removes available memberships with their dependent history', async () => {
		const product = await capture('admin', {
			listIds: ['visible', 'secret'],
			estimatePence: 2000,
			entryEstimates: { visible: null }
		});
		expect(
			product.entries.find((e: { listId: string }) => e.listId === 'visible').estimatePence
		).toBeNull();
		const entry = product.entries.find((e: { listId: string }) => e.listId === 'secret');
		context.connection.sqlite
			.prepare(
				"INSERT INTO allocation_history (id,entry_id,actor_id,action_id,action,from_state,to_state,resulting_version,result_json) VALUES ('transition',?,'admin','clear-1','clear','allocated','available',2,'{}')"
			)
			.run(entry.id);
		expect(
			(await listPatch(context.connection, event('admin', { archived: true }), 'secret')).status
		).toBe(200);
		expect(
			context.connection.sqlite.prepare('SELECT * FROM allocation_history').all()
		).toHaveLength(1);
		const response = await productPatch(
			context.connection,
			event('admin', { title: 'Still useful', listIds: ['visible'] }),
			product.id
		);
		expect(response.status).toBe(200);
		expect(
			context.connection.sqlite.prepare('SELECT * FROM allocation_history').all()
		).toHaveLength(0);
		expect((await response.json()).entries).toHaveLength(1);
	});
	it('stores private raster previews, denies revoked access and rejects invalid uploads without a product', async () => {
		invite('contributor');
		const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#abc' } })
			.withMetadata({ orientation: 6 })
			.png()
			.toBuffer();
		async function upload(bytes: Uint8Array, name: string) {
			const form = new FormData();
			form.set('draft', JSON.stringify({ title: 'Photo idea', listIds: ['visible'] }));
			form.append('photos', new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
			const e = event('guest');
			e.request = new Request(e.url, {
				method: 'POST',
				headers: { origin: e.url.origin },
				body: form
			});
			return productsPost(context.connection, e, { mediaRoot: directory });
		}
		expect((await upload(new TextEncoder().encode('<svg/>'), 'fake.png')).status).toBe(400);
		expect((await upload(new Uint8Array(12 * 1024 * 1024 + 1), 'large.png')).status).toBe(413);
		const oversized = await sharp({
			create: { width: 6200, height: 5000, channels: 3, background: '#fff' }
		})
			.png()
			.toBuffer();
		expect((await upload(oversized, 'too-many-pixels.png')).status).toBe(400);
		expect(context.connection.sqlite.prepare('SELECT * FROM products').all()).toHaveLength(0);
		const response = await upload(png, 'photo.png');
		expect(response.status).toBe(200);
		const product = await response.json();
		const id = product.media[0].id;
		expect(JSON.stringify(product)).not.toContain('storagePath');
		const preview = await mediaGet(context.connection, event('guest'), id, {
			mediaRoot: directory
		});
		expect(preview.headers.get('content-type')).toBe('image/webp');
		expect(preview.headers.get('cache-control')).toContain('no-store');
		const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
		expect(metadata.format).toBe('webp');
		expect(metadata.exif).toBeUndefined();
		expect(metadata.icc).toBeUndefined();
		const original = await mediaGet(
			context.connection,
			event('guest', undefined, '?original=1'),
			id,
			{ mediaRoot: directory }
		);
		expect(original.headers.get('content-disposition')).toContain('attachment');
		expect(Buffer.from(await original.arrayBuffer())).toEqual(png);
		setGrant(context.connection, context.admin, 'guest', { listId: 'visible', role: null });
		expect(
			(await mediaGet(context.connection, event('guest'), id, { mediaRoot: directory })).status
		).toBe(404);
	});
	it('enforces site-wide collaborator, site-wide buyer, stacked list collaborator, and secondary administrator RBAC boundaries', async () => {
		const adminIdea = await capture('admin', {
			title: 'Shared toy',
			listIds: ['visible', 'secret']
		});
		const unlistedAdmin = await capture('admin', { title: 'Inbox spark', listIds: [] });

		setSiteRole(context.connection, context.admin, 'guest', 'collaborator');
		const collabCatalogue = await (await productsGet(context.connection, event('guest'))).json();
		expect(collabCatalogue.administrator).toBe(false);
		expect(collabCatalogue.collaborator).toBe(true);
		expect(collabCatalogue.lists.map((l: { id: string }) => l.id)).not.toContain('archived');
		expect(collabCatalogue.products.map((p: { id: string }) => p.id)).toContain(adminIdea.id);
		expect(collabCatalogue.products.map((p: { id: string }) => p.id)).toContain(unlistedAdmin.id);
		expect((await catalogueActionsGet(context.connection, event('guest'))).status).toBe(200);
		expect(
			(
				await catalogueActionsPost(
					context.connection,
					event('guest', {
						kind: 'add',
						operationId: randomUUID(),
						productIds: [unlistedAdmin.id],
						listIds: ['visible']
					})
				)
			).status
		).toBe(200);
		expect(
			(await labelsPost(context.connection, event('guest', { name: 'Board games' }))).status
		).toBe(200);
		expect(
			(
				await productPatch(
					context.connection,
					event('guest', { title: 'Edited by collab', listIds: ['visible'] }),
					adminIdea.id
				)
			).status
		).toBe(200);
		expect(
			(
				await listsPost(
					context.connection,
					event('guest', { recipientId: 'child', name: 'Blocked' })
				)
			).status
		).toBe(403);
		expect((await listTotalsGet(context.connection, event('guest'), 'visible')).status).toBe(403);
		expect((await peopleGet(context.connection, event('guest'))).status).toBe(403);
		const visibleAdminEntry = adminIdea.entries.find(
			(e: { listId: string }) => e.listId === 'visible'
		);
		expect(
			(
				await allocationPost(
					context.connection,
					event('guest', {
						action: 'assign',
						actionId: randomUUID(),
						buyerId: 'guest',
						expectedVersion: 0
					}),
					visibleAdminEntry.id
				)
			).status
		).toBe(403);

		setSiteRole(context.connection, context.admin, 'guest', 'buyer');
		expect((await productsGet(context.connection, event('guest'))).status).toBe(403);
		await expect(
			(await listsGet(context.connection, event('guest'))).json()
		).resolves.toMatchObject({
			lists: expect.arrayContaining([
				expect.objectContaining({ id: 'visible', role: 'buyer' }),
				expect.objectContaining({ id: 'secret', role: 'buyer' })
			])
		});
		const secretEntry = context.connection.sqlite
			.prepare("SELECT id FROM entries WHERE product_id=? AND list_id='visible'")
			.get(unlistedAdmin.id) as { id: string };
		expect(
			(
				await allocationPost(
					context.connection,
					event('guest', { action: 'reserve', actionId: randomUUID(), expectedVersion: 0 }),
					secretEntry.id
				)
			).status
		).toBe(200);
		expect(
			(
				await allocationPost(
					context.connection,
					event('guest', {
						action: 'purchase',
						actionId: randomUUID(),
						actualPence: 1800,
						expectedVersion: 1
					}),
					secretEntry.id
				)
			).status
		).toBe(200);
		const myGifts = await (await myGiftsGet(context.connection, event('guest'))).json();
		expect(myGifts.products.map((p: { id: string }) => p.id)).toContain(unlistedAdmin.id);
		const ownBuyerIdea = await capture('guest', {
			title: 'Buyer spark',
			listIds: ['visible', 'secret']
		});
		expect(
			(
				await productPatch(
					context.connection,
					event('guest', { title: 'Buyer updated', listIds: ['visible', 'secret'] }),
					ownBuyerIdea.id
				)
			).status
		).toBe(200);
		expect(
			(
				await productPatch(
					context.connection,
					event('guest', { title: 'Not yours', listIds: ['visible'] }),
					adminIdea.id
				)
			).status
		).toBe(403);
		const visibleOwnEntry = ownBuyerIdea.entries.find(
			(e: { listId: string }) => e.listId === 'visible'
		);
		const secretOwnEntry = ownBuyerIdea.entries.find(
			(e: { listId: string }) => e.listId === 'secret'
		);
		expect(
			(await listEntryDelete(context.connection, event('guest'), 'visible', visibleOwnEntry.id))
				.status
		).toBe(403);

		// Grant site-wide buyer extra list collaborator permission on 'visible'
		expect(
			(
				await peoplePost(
					context.connection,
					event('admin', {
						action: 'grant',
						userId: 'guest',
						listId: 'visible',
						role: 'collaborator'
					})
				)
			).status
		).toBe(200);
		const delRes = await listEntryDelete(
			context.connection,
			event('guest'),
			'visible',
			visibleOwnEntry.id
		);
		expect(delRes.status).toBe(200);
		// Product remains in catalogue even if removed from visible list
		expect(
			context.connection.sqlite
				.prepare('SELECT deleted_at FROM products WHERE id=?')
				.get(ownBuyerIdea.id)
		).toEqual({ deleted_at: null });
		expect(
			(await listEntryDelete(context.connection, event('guest'), 'secret', secretOwnEntry.id))
				.status
		).toBe(403);
		// Purchased/reserved gift cannot be removed even by collaborator
		setSiteRole(context.connection, context.admin, 'guest', 'collaborator');
		expect(
			(await listEntryDelete(context.connection, event('guest'), 'visible', secretEntry.id)).status
		).toBe(409);

		// Secondary administrator gets full admin access but cannot alter super admin or self
		setSiteRole(context.connection, context.admin, 'guest', 'administrator');
		expect((await listTotalsGet(context.connection, event('guest'), 'visible')).status).toBe(200);
		expect((await peopleGet(context.connection, event('guest'))).status).toBe(200);
		expect(
			(
				await peoplePost(
					context.connection,
					event('guest', { action: 'siteRole', userId: 'admin', role: 'guest' })
				)
			).status
		).toBe(400);
		expect(
			(
				await peoplePost(
					context.connection,
					event('guest', { action: 'siteRole', userId: 'guest', role: 'buyer' })
				)
			).status
		).toBe(400);
		const createdList = await listsPost(
			context.connection,
			event('guest', { recipientId: 'child', name: 'Secondary admin list' })
		);
		expect(createdList.status).toBe(200);
		const newList = await createdList.json();
		const impact = await (
			await listDeletionImpactGet(context.connection, event('guest'), newList.id)
		).json();
		expect(
			(
				await listDelete(
					context.connection,
					event('guest', {
						operationId: randomUUID(),
						deleteOrphans: false,
						impactFingerprint: impact.fingerprint
					}),
					newList.id
				)
			).status
		).toBe(200);
	});
	it('blocks non-admin collaborators from probing or deleting protected products via catalogueActionsPost, preserves viewer entries on author edits, and scopes identify permissions', async () => {
		setSiteRole(context.connection, context.admin, 'other', 'buyer');
		const reserved = await capture('admin', { title: 'Reserved idea', listIds: ['visible'] });
		const reservedEntryId = reserved.entries[0].id as string;
		expect(
			(
				await allocationPost(
					context.connection,
					event('admin', {
						action: 'assign',
						actionId: randomUUID(),
						buyerId: 'other',
						expectedVersion: 0
					}),
					reservedEntryId
				)
			).status
		).toBe(200);
		context.connection.sqlite.exec(
			"INSERT INTO lists (id,recipient_id,name,occasion,archived_at) VALUES ('archived','child','Old list','Archived occasion',1); INSERT INTO products (id,title,contributor_id) VALUES ('archived-only','Archived only','admin'); INSERT INTO entries (id,product_id,list_id) VALUES ('archived-entry','archived-only','archived');"
		);

		setSiteRole(context.connection, context.admin, 'guest', 'collaborator');
		const catalogueRes = await (await productsGet(context.connection, event('guest'))).json();
		expect(catalogueRes.products.find((p: { id: string }) => p.id === reserved.id)).toMatchObject({
			hasHiddenEntries: true,
			entries: []
		});
		expect(
			catalogueRes.products.find((p: { id: string }) => p.id === 'archived-only')
		).toMatchObject({ hasHiddenEntries: true, entries: [] });
		const unlistedRes = await (
			await productsGet(context.connection, event('guest', undefined, '?unlisted=1'))
		).json();
		expect(unlistedRes.products).toHaveLength(0);

		for (const protectedId of [reserved.id, 'archived-only']) {
			const res = await catalogueActionsPost(
				context.connection,
				event('guest', {
					kind: 'delete',
					operationId: randomUUID(),
					productIds: [protectedId]
				})
			);
			expect(res.status).toBe(409);
			const body = await res.json();
			expect(body.impact).toBeUndefined();
			expect(
				context.connection.sqlite
					.prepare('SELECT deleted_at FROM products WHERE id=?')
					.get(protectedId)
			).toEqual({ deleted_at: null });
		}

		// Author downgraded to viewer on 'secret' can still save edits while retaining 'secret' untouched
		setSiteRole(context.connection, context.admin, 'guest', 'guest');
		setGrant(context.connection, context.admin, 'guest', {
			listId: 'visible',
			role: 'contributor'
		});
		setGrant(context.connection, context.admin, 'guest', { listId: 'secret', role: 'contributor' });
		const authored = await capture('guest', {
			title: 'Author dual-list idea',
			listIds: ['visible', 'secret'],
			estimatePence: 2200
		});
		setGrant(context.connection, context.admin, 'guest', { listId: 'secret', role: 'viewer' });
		const patchRes = await productPatch(
			context.connection,
			event('guest', {
				title: 'Author dual-list updated',
				listIds: ['visible', 'secret'],
				entryEstimates: { visible: 2500, secret: 9900 }
			}),
			authored.id
		);
		expect(patchRes.status).toBe(200);
		const patched = await patchRes.json();
		expect(patched.title).toBe('Author dual-list updated');
		expect(
			patched.entries.find((e: { listId: string }) => e.listId === 'visible')?.estimatePence
		).toBe(2500);
		expect(
			patched.entries.find((e: { listId: string }) => e.listId === 'secret')?.estimatePence
		).toBe(2200);

		// Buyer-only user cannot trigger identify on admin's product, yet can identify own product
		const adminSecret = await capture('admin', {
			title: 'Admin secret idea',
			sourceUrl: 'https://shop.example/item',
			listIds: ['secret']
		});
		setSiteRole(context.connection, context.admin, 'guest', 'buyer');
		expect(canIdentifyProduct(context.connection, context.actor('guest')!, adminSecret.id)).toBe(
			false
		);
		expect(canIdentifyProduct(context.connection, context.actor('guest')!, authored.id)).toBe(true);
		const idGet = await (
			await identifyGet(context.connection, event('guest'), adminSecret.id)
		).json();
		expect(idGet.canIdentify).toBe(false);
		expect(
			(
				await identifyPost(
					context.connection,
					event('guest', { operationId: randomUUID(), kind: 'metadata' }),
					adminSecret.id
				)
			).status
		).toBe(403);
	});
});
