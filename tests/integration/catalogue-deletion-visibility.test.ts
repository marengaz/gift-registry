import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { fixture } from './identity-fixture';
import { acceptInvitation, createInvitation, setGrant } from '../../src/lib/server/invitations';
import { canReadProduct, visibleEntries } from '../../src/lib/server/access';
import {
	productsGet,
	productGet,
	productPatch,
	listsGet,
	saveCapture,
	parseCapture,
	type CatalogueEvent
} from '../../src/lib/server/catalogue';
import { allocationGet, allocationPost, myGiftsGet } from '../../src/lib/server/allocations';
import { calculateListTotals } from '../../src/lib/server/totals';
import { captureDuplicates } from '../../src/lib/server/capture-duplicates';
import { capturesPost } from '../../src/lib/server/capture-sync';
import { mediaGet, prepareMedia } from '../../src/lib/server/media';
import {
	identifyGet,
	identifyPost,
	runNextJob,
	confirmSuggestion,
	attachIdentificationPhoto
} from '../../src/lib/server/enrichment/jobs';
import { updateIdentificationSettings } from '../../src/lib/server/enrichment/allowance';

let model: ReturnType<typeof fixture>;
let directory: string;
beforeEach(() => {
	model = fixture();
	directory = mkdtempSync(join(tmpdir(), 'gift-deleted-'));
	acceptInvitation(
		model.connection,
		model.actor('guest'),
		createInvitation(model.connection, model.admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'contributor' }]
		}).token
	);
});
afterEach(() => {
	model.connection.close();
	rmSync(directory, { recursive: true, force: true });
});
function event(id = 'admin', body?: unknown, query = ''): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/products' + query);
	return {
		url,
		locals: { actor: model.actor(id) },
		request: new Request(url, {
			method: body ? 'POST' : 'GET',
			headers: { origin: url.origin, 'content-type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {})
		})
	};
}
function item(title = 'Gift', listIds = ['visible'], contributor = 'admin') {
	return saveCapture(
		model.connection,
		model.actor(contributor),
		parseCapture({ title, listIds, estimatePence: 1200, sourceUrl: 'https://shop.example/gift' })
	);
}
function remove(id: string) {
	model.connection.sqlite
		.prepare('UPDATE products SET deleted_at=1,deletion_token=? WHERE id=?')
		.run('deletion', id);
}
function restore(id: string) {
	model.connection.sqlite
		.prepare('UPDATE products SET deleted_at=NULL,deletion_token=NULL WHERE id=?')
		.run(id);
}
const fetchedPage = async () => ({
	status: 200,
	headers: { 'content-type': 'text/html' },
	body: Buffer.from(
		'<script type="application/ld+json">{"@type":"Product","name":"Identified gift","image":"https://shop.example/image.png","offers":{"price":"12.00","priceCurrency":"GBP"}}</script>'
	),
	url: 'https://shop.example/gift'
});
async function photo() {
	return new File(
		[
			await sharp({ create: { width: 3, height: 3, channels: 3, background: 'green' } })
				.png()
				.toBuffer()
		],
		'gift.png',
		{ type: 'image/png' }
	);
}

describe('recoverably deleted ideas at existing access boundaries', () => {
	it('hides ideas from catalogue, inbox, lists, own gifts and direct reads for every existing role, then restores the same access', async () => {
		acceptInvitation(
			model.connection,
			model.actor('other'),
			createInvitation(model.connection, model.admin, {
				email: 'other@example.test',
				grants: [{ listId: 'secret', role: 'viewer' }]
			}).token
		);
		const listed = item('Removed listed');
		const unlisted = item('Removed inbox', [], 'guest');
		const retained = item('Retained');
		model.connection.sqlite
			.prepare(
				"UPDATE entries SET state='allocated',buyer_id='guest',allocated_by_id='admin',allocation_source='administrator' WHERE product_id=?"
			)
			.run(listed.id);
		remove(listed.id);
		remove(unlisted.id);
		expect(
			(await (await productsGet(model.connection, event())).json()).products.map(
				(p: { id: string }) => p.id
			)
		).toEqual([retained.id]);
		for (const role of ['contributor', 'buyer', 'viewer'] as const) {
			setGrant(model.connection, model.admin, 'guest', { listId: 'visible', role });
			for (const id of ['admin', 'guest']) {
				expect(canReadProduct(model.connection, model.actor(id), listed.id)).toBe(false);
				expect((await productGet(model.connection, event(id), listed.id)).status).toBe(404);
				expect((await productGet(model.connection, event(id), unlisted.id)).status).toBe(404);
				expect(visibleEntries(model.connection, model.actor(id)).map((e) => e.productId)).toEqual([
					retained.id
				]);
				expect(
					(await (await listsGet(model.connection, event(id), 'visible')).json()).products.map(
						(p: { id: string }) => p.id
					)
				).toEqual([retained.id]);
				expect(
					(await (await productsGet(model.connection, event(id, undefined, '?inbox=1'))).json())
						.products
				).toEqual([]);
			}
			expect((await (await myGiftsGet(model.connection, event('guest'))).json()).products).toEqual(
				[]
			);
		}
		restore(listed.id);
		restore(unlisted.id);
		expect((await productGet(model.connection, event('guest'), listed.id)).status).toBe(200);
		expect((await (await myGiftsGet(model.connection, event('guest'))).json()).products[0].id).toBe(
			listed.id
		);
		expect((await productGet(model.connection, event('guest'), unlisted.id)).status).toBe(200);
		expect((await productGet(model.connection, event('other'), listed.id)).status).toBe(404);
	});
	it('omits deleted estimated, unknown, allocated and actual purchased values until restoration', () => {
		const first = item('Purchased');
		const unknown = item('Unknown');
		item('Retained');
		model.connection.sqlite
			.prepare(
				"UPDATE entries SET state='purchased',buyer_id='guest',allocated_by_id='admin',allocation_source='administrator',actual_pence=900 WHERE product_id=?"
			)
			.run(first.id);
		model.connection.sqlite
			.prepare('UPDATE entries SET estimate_pence=NULL WHERE product_id=?')
			.run(unknown.id);
		const before = calculateListTotals(model.connection, model.admin, 'visible');
		remove(first.id);
		remove(unknown.id);
		expect(calculateListTotals(model.connection, model.admin, 'visible')).toEqual({
			all: { count: 1, pence: 1200, unknown: 0 },
			allocated: { count: 0, pence: 0, unknown: 0 },
			purchased: { count: 0, pence: 0, unknown: 0, estimatedCount: 0 }
		});
		restore(first.id);
		restore(unknown.id);
		expect(calculateListTotals(model.connection, model.admin, 'visible')).toEqual(before);
	});
	it('denies buying reads, history, new commands and successful command replay without changing history', async () => {
		const gift = item();
		const entry = gift.entries[0];
		const command = { actionId: randomUUID(), expectedVersion: 0, action: 'reserve' };
		expect((await allocationPost(model.connection, event('guest', command), entry.id)).status).toBe(
			200
		);
		const before = model.connection.sqlite.prepare('SELECT * FROM entries').all();
		const history = model.connection.sqlite.prepare('SELECT * FROM allocation_history').all();
		remove(gift.id);
		for (const id of ['admin', 'guest']) {
			expect((await allocationGet(model.connection, event(id), entry.id)).status).toBe(404);
			expect(
				(
					await allocationPost(
						model.connection,
						event(id, { actionId: randomUUID(), expectedVersion: 1, action: 'purchase' }),
						entry.id
					)
				).status
			).toBe(404);
		}
		expect((await allocationPost(model.connection, event('guest', command), entry.id)).status).toBe(
			404
		);
		expect(model.connection.sqlite.prepare('SELECT * FROM entries').all()).toEqual(before);
		expect(model.connection.sqlite.prepare('SELECT * FROM allocation_history').all()).toEqual(
			history
		);
		restore(gift.id);
		expect((await allocationGet(model.connection, event(), entry.id)).status).toBe(200);
	});
	it('denies original and preview images, duplicate suggestions, edits and identification APIs even to administrator', async () => {
		const prepared = await prepareMedia([await photo()], { mediaRoot: directory });
		const gift = saveCapture(
			model.connection,
			model.admin,
			parseCapture({
				title: 'Photo',
				listIds: ['visible'],
				sourceUrl: 'https://shop.example/gift'
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
		remove(gift.id);
		for (const id of ['admin', 'guest']) {
			for (const query of ['', '?original=1'])
				expect(
					(
						await mediaGet(model.connection, event(id, undefined, query), gift.media[0].id, {
							mediaRoot: directory
						})
					).status
				).toBe(404);
			expect((await identifyGet(model.connection, event(id), gift.id)).status).toBe(404);
		}
		expect(
			(
				await identifyPost(
					model.connection,
					event('admin', { operationId: queued.operationId, kind: 'metadata' }),
					gift.id
				)
			).status
		).toBe(404);
		expect(
			(
				await productPatch(
					model.connection,
					event('admin', { title: 'Changed', listIds: ['visible'] }),
					gift.id
				)
			).status
		).toBe(404);
		expect(
			(
				await (
					await captureDuplicates(
						model.connection,
						event('admin', undefined, '?url=https%3A%2F%2Fshop.example%2Fgift')
					)
				).json()
			).matches
		).toEqual([]);
		let fetched = false;
		await runNextJob(model.connection, {
			fetchPage: async () => {
				fetched = true;
				return fetchedPage();
			}
		});
		expect(fetched).toBe(false);
		expect(
			model.connection.sqlite
				.prepare('SELECT state,result_json FROM lookup_jobs WHERE id=?')
				.get(queued.id)
		).toEqual({ state: 'failed', result_json: null });
		restore(gift.id);
		expect(
			(await mediaGet(model.connection, event(), gift.media[0].id, { mediaRoot: directory })).status
		).toBe(200);
		expect(
			model.connection.sqlite.prepare('SELECT title FROM products WHERE id=?').get(gift.id)
		).toEqual({ title: 'Photo' });
	});
	it('does not publish a metadata result when deletion happens during the fetch', async () => {
		const gift = item();
		await identifyPost(
			model.connection,
			event('admin', { operationId: randomUUID(), kind: 'metadata' }),
			gift.id
		);
		await runNextJob(model.connection, {
			fetchPage: async () => {
				remove(gift.id);
				return fetchedPage();
			}
		});
		expect(
			model.connection.sqlite.prepare('SELECT state,result_json FROM lookup_jobs').get()
		).toEqual({ state: 'failed', result_json: null });
	});
	it('keeps dispatched allowance reserved but does not publish a paid result after deletion', async () => {
		const prepared = await prepareMedia([await photo()], { mediaRoot: directory });
		const gift = saveCapture(
			model.connection,
			model.admin,
			parseCapture({ title: 'Photo', listIds: ['visible'] }),
			prepared.media
		);
		updateIdentificationSettings(model.connection, {
			enabled: true,
			monthlyLimitMicrodollars: 3500,
			unitMicrodollars: 3500,
			pricingRevision: 'test'
		});
		await identifyPost(
			model.connection,
			event('admin', { operationId: randomUUID(), kind: 'vision', mediaId: gift.media[0].id }),
			gift.id
		);
		await runNextJob(model.connection, {
			mediaRoot: directory,
			provider: {
				projectId: 'test-personal',
				detect: async () => {
					remove(gift.id);
					return { labels: ['Toy'], pages: [] };
				}
			}
		});
		expect(
			model.connection.sqlite.prepare('SELECT state,result_json FROM lookup_jobs').get()
		).toEqual({ state: 'uncertain', result_json: null });
		expect(
			model.connection.sqlite
				.prepare('SELECT amount_microdollars FROM allowance_reservations')
				.all()
		).toEqual([{ amount_microdollars: 3500 }]);
	});
	it('rechecks deletion during suggestion image preparation and keeps existing photos and fields untouched', async () => {
		const gift = item();
		const job = await (
			await identifyPost(
				model.connection,
				event('admin', { operationId: randomUUID(), kind: 'metadata' }),
				gift.id
			)
		).json();
		await runNextJob(model.connection, { fetchPage: fetchedPage });
		const bytes = Buffer.from(await (await photo()).arrayBuffer());
		const response = await confirmSuggestion(
			model.connection,
			event('admin', { jobId: job.id, index: 0, fields: ['title', 'offer', 'image'] }),
			gift.id,
			{
				mediaRoot: directory,
				fetchPage: async () => {
					remove(gift.id);
					return { status: 200, headers: {}, body: bytes, url: 'https://shop.example/image.png' };
				}
			}
		);
		expect(response.status).toBe(404);
		expect(
			model.connection.sqlite.prepare('SELECT title FROM products WHERE id=?').get(gift.id)
		).toEqual({ title: 'Gift' });
		expect(model.connection.sqlite.prepare('SELECT * FROM media').all()).toEqual([]);
		expect(model.connection.sqlite.prepare('SELECT * FROM offers').all()).toEqual([]);
		expect(readdirSync(directory)).toEqual([]);
		expect(
			(
				await confirmSuggestion(
					model.connection,
					event('admin', { jobId: job.id, index: 0, fields: ['title'] }),
					gift.id
				)
			).status
		).toBe(404);
	});
	it('rechecks deletion after a photo body is read and before committing an attachment', async () => {
		const gift = item();
		const file = await photo();
		const body = new FormData();
		body.set('operationId', randomUUID());
		body.set('photo', file);
		const request = event('admin', {});
		request.request.formData = async () => body;
		const staged = body.get('photo') as File;
		const read = staged.arrayBuffer.bind(staged);
		staged.arrayBuffer = async () => {
			remove(gift.id);
			return read();
		};
		const response = await attachIdentificationPhoto(model.connection, request, gift.id, {
			mediaRoot: directory
		});
		expect(response.status).toBe(404);
		expect(model.connection.sqlite.prepare('SELECT * FROM media').all()).toEqual([]);
		expect(model.connection.sqlite.prepare('SELECT * FROM lookup_jobs').all()).toEqual([]);
		expect(readdirSync(directory)).toEqual([]);
	});
	it('denies attachment receipt replay after deletion without modifying saved images or receipts', async () => {
		const gift = item();
		const file = await photo();
		const operationId = randomUUID();
		const upload = () => {
			const value = event('admin', {});
			const body = new FormData();
			body.set('operationId', operationId);
			body.set('photo', file);
			value.request = new Request(value.url, {
				method: 'POST',
				headers: { origin: value.url.origin },
				body
			});
			return attachIdentificationPhoto(model.connection, value, gift.id, { mediaRoot: directory });
		};
		expect((await upload()).status).toBe(200);
		const images = model.connection.sqlite.prepare('SELECT * FROM media').all();
		const receipts = model.connection.sqlite.prepare('SELECT * FROM lookup_jobs').all();
		remove(gift.id);
		expect((await upload()).status).toBe(404);
		expect(model.connection.sqlite.prepare('SELECT * FROM media').all()).toEqual(images);
		expect(model.connection.sqlite.prepare('SELECT * FROM lookup_jobs').all()).toEqual(receipts);
		expect(readdirSync(directory)).toHaveLength(1);
	});
	it('acknowledges a saved capture retry without restoring deleted content or returning a product projection', async () => {
		const operationId = randomUUID();
		const send = () =>
			capturesPost(
				model.connection,
				event('admin', {
					ownerId: 'admin',
					operationId,
					draft: { title: 'Captured', listIds: ['visible'] }
				}),
				{ mediaRoot: directory }
			);
		const saved = await (await send()).json();
		remove(saved.productId);
		expect(await (await send()).json()).toEqual(saved);
		expect(Object.keys(saved).sort()).toEqual(['entryIds', 'operationId', 'productId']);
		expect(model.connection.sqlite.prepare('SELECT count(*) AS n FROM products').get()).toEqual({
			n: 1
		});
		expect((await productGet(model.connection, event(), saved.productId)).status).toBe(404);
		expect(model.connection.sqlite.prepare('SELECT deleted_at FROM products').get()).toEqual({
			deleted_at: 1
		});
	});
});
