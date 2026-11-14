import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fixture } from './identity-fixture';
import {
	parseCapture,
	productPatch,
	saveCapture,
	type CatalogueEvent
} from '../../src/lib/server/catalogue';
import { confirmSuggestion } from '../../src/lib/server/enrichment/jobs';
import { projectProduct } from '../../src/lib/server/access';
import { catalogueActionsPost } from '../../src/lib/server/catalogue-actions';

let context: ReturnType<typeof fixture>;
beforeEach(() => {
	context = fixture();
	context.connection.sqlite.exec(
		"INSERT INTO products(id,title,variant,contributor_id) VALUES ('game','Game','Blue','admin'),('other','Other',NULL,'admin')"
	);
});
afterEach(() => context.connection.close());
function event(body: unknown): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/products/game');
	return {
		url,
		locals: { actor: context.admin },
		request: new Request(url, {
			method: 'POST',
			headers: { origin: url.origin, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
}
function seedJob(id = 'search', kind = 'vision', provider?: string) {
	const suggestion = {
		title: 'Changed game',
		description: null,
		variant: 'Green',
		imageUrl: null,
		sourceUrl: 'https://shop.example/found',
		retrievedAt: 123,
		source: 'vision-page',
		uncertainty: [],
		offer: {
			url: 'https://shop.example/found',
			retailer: 'Shop',
			priceMinor: 2000,
			currency: 'GBP',
			priceText: null,
			fromPrice: false
		}
	};
	context.connection.sqlite
		.prepare(
			`INSERT INTO lookup_jobs(id,product_id,actor_id,actor_session_id,operation_id,fingerprint,kind,state,result_json${provider ? ',provider' : ''}) VALUES (?,'game','admin','session-admin',?,'fixture',?,'succeeded',?${provider ? ',?' : ''})`
		)
		.run(
			id,
			id,
			kind,
			JSON.stringify({
				suggestions: [suggestion],
				labels: [],
				matchingPages: [],
				message: 'Possible match'
			}),
			...(provider ? [provider] : [])
		);
}
async function accept(jobId = 'search', fields = ['offer']) {
	return confirmSuggestion(context.connection, event({ jobId, index: 0, fields }), 'game');
}
function view() {
	return projectProduct(context.connection, context.admin, 'game')!;
}
function row() {
	return context.connection.sqlite
		.prepare("SELECT * FROM offers WHERE product_id='game'")
		.get() as Record<string, unknown>;
}
function markChecked() {
	const offer = view().offers[0];
	context.connection.sqlite
		.prepare('UPDATE offers SET checked_at=1000,checked_by_id=?,checked_fingerprint=? WHERE id=?')
		.run('private-admin', JSON.stringify(['Game', 'Blue', new URL(offer.url).href]), offer.id);
}
async function edit(offers: unknown[], extra: Record<string, unknown> = {}) {
	return productPatch(
		context.connection,
		event({ title: 'Game', variant: 'Blue', offers, ...extra }),
		'game'
	);
}
it('accepts a reverse suggestion unchecked, idempotently, without exposing internal trust fields', async () => {
	seedJob();
	expect((await accept()).status).toBe(200);
	expect((await accept()).status).toBe(200);
	expect(view().offers).toHaveLength(1);
	expect(view().offers[0]).toMatchObject({
		reverseFound: true,
		checked: false,
		checkedAt: null,
		reviewFingerprint: JSON.stringify(['Game', 'Blue', 'https://shop.example/found'])
	});
	expect(view().offers[0]).not.toHaveProperty('reverseProvider');
	expect(view().offers[0]).not.toHaveProperty('checkedById');
	expect(view().offers[0]).not.toHaveProperty('checkedFingerprint');
});
it('keeps ordinary metadata offers manual even if their source claims image search', async () => {
	seedJob('metadata', 'metadata');
	expect((await accept('metadata')).status).toBe(200);
	expect(view().offers[0]).toMatchObject({ reverseFound: false, checked: false });
});
it('preserves reverse origin and compatible check through prices, duplicates and old-client payloads', async () => {
	seedJob();
	await accept();
	markChecked();
	const original = view().offers[0];
	expect(
		(
			await edit([
				{
					url: original.url,
					priceMinor: 2500,
					currency: 'GBP',
					reverseFound: false,
					checked: false,
					checkedById: 'forged'
				}
			])
		).status
	).toBe(200);
	expect(row()).toMatchObject({
		id: original.id,
		reverse_provider: 'vision',
		checked_at: 1000,
		checked_by_id: 'private-admin'
	});
	expect(
		(
			await edit([
				{ url: original.url, priceMinor: 3000, currency: 'GBP' },
				{ url: original.url, priceMinor: 3000, currency: 'GBP' }
			])
		).status
	).toBe(200);
	expect(view().offers).toHaveLength(1);
	expect(view().offers[0]).toMatchObject({ reverseFound: true, checked: true, checkedAt: 1000 });
});
it.each([{ title: 'Different' }, { variant: 'Red' }])(
	'clears checks after an ordinary product identity edit: %j',
	async (identity) => {
		seedJob();
		await accept();
		markChecked();
		const original = view().offers[0];
		expect((await edit([{ id: original.id, url: original.url }], identity)).status).toBe(200);
		expect(view().offers[0]).toMatchObject({ reverseFound: true, checked: false, checkedAt: null });
	}
);
it('retains reverse origin when an owned offer URL changes and rejects foreign IDs atomically', async () => {
	seedJob();
	await accept();
	markChecked();
	const original = view().offers[0];
	expect((await edit([{ id: original.id, url: 'https://shop.example/replacement' }])).status).toBe(
		200
	);
	expect(view().offers[0]).toMatchObject({ id: original.id, reverseFound: true, checked: false });
	context.connection.sqlite.exec(
		"INSERT INTO offers(id,product_id,url) VALUES ('foreign','other','https://shop.example/foreign')"
	);
	const before = row();
	expect((await edit([{ id: 'foreign', url: original.url }])).status).toBe(400);
	expect(row()).toEqual(before);
});
it('does not allow capture trust flags to assert a reverse origin or human check', () => {
	const product = saveCapture(
		context.connection,
		context.admin,
		parseCapture({
			title: 'Manual',
			offers: [
				{
					url: 'https://shop.example/manual',
					reverseFound: true,
					reverseProvider: 'serpapi',
					checked: true,
					checkedAt: 123,
					checkedById: 'admin'
				}
			]
		})
	);
	expect(product.offers[0]).toMatchObject({ reverseFound: false, checked: false, checkedAt: null });
});
it('clears existing checks when suggestion confirmation changes title or variant', async () => {
	seedJob();
	await accept();
	markChecked();
	expect((await accept('search', ['title', 'variant'])).status).toBe(200);
	expect(view().offers[0]).toMatchObject({ reverseFound: true, checked: false, checkedAt: null });
});
it('never downgrades reverse provenance when metadata accepts a duplicate URL', async () => {
	seedJob();
	await accept();
	markChecked();
	seedJob('metadata', 'metadata');
	await accept('metadata');
	expect(view().offers).toHaveLength(1);
	expect(view().offers[0]).toMatchObject({ reverseFound: true, checked: true });
});
it.each([false, true])(
	'uses manual offer fallback but excludes unchecked reverse prices: reverse=%s',
	async (reverse) => {
		if (reverse) {
			seedJob();
			await accept();
		} else
			context.connection.sqlite.exec(
				"INSERT INTO offers(id,product_id,url,price_minor,currency) VALUES ('manual','game','https://shop.example',2000,'GBP')"
			);
		const response = await catalogueActionsPost(
			context.connection,
			event({ operationId: randomUUID(), kind: 'add', productIds: ['game'], listIds: ['visible'] })
		);
		expect(response.status).toBe(200);
		expect(
			context.connection.sqlite
				.prepare("SELECT estimate_pence FROM entries WHERE product_id='game'")
				.get()
		).toEqual({ estimate_pence: reverse ? null : 2000 });
	}
);

it('pins accepted SerpAPI origin from the stored job and ignores submitted check flags on edit', async () => {
	seedJob('lens', 'vision', 'serpapi');
	expect((await accept('lens')).status).toBe(200);
	const original = view().offers[0];
	expect(row()).toMatchObject({ reverse_provider: 'serpapi', reverse_job_id: 'lens' });
	expect(
		(
			await edit([
				{
					id: original.id,
					url: original.url,
					checked: true,
					checkedAt: 123,
					checkedById: 'admin',
					reverseProvider: null
				}
			])
		).status
	).toBe(200);
	expect(row()).toMatchObject({
		reverse_provider: 'serpapi',
		checked_at: null,
		checked_by_id: null,
		checked_fingerprint: null
	});
	expect(view().offers[0]).toMatchObject({ reverseFound: true, checked: false });
});

it('publishes a compatible human check without returning its private actor or provenance', async () => {
	seedJob();
	await accept();
	markChecked();
	expect(view().offers[0]).toEqual({
		id: 'lookup-search-0',
		productId: 'game',
		url: 'https://shop.example/found',
		retailer: 'Shop',
		priceMinor: 2000,
		currency: 'GBP',
		observedAt: 123,
		reverseFound: true,
		checked: true,
		checkedAt: 1000,
		reviewFingerprint: JSON.stringify(['Game', 'Blue', 'https://shop.example/found'])
	});
});

it.each([true, false])(
	'uses only a compatible human-checked reverse price for list fallback: compatible=%s',
	async (compatible) => {
		seedJob();
		await accept();
		markChecked();
		if (!compatible)
			context.connection.sqlite.exec(
				"UPDATE products SET variant='Changed outside review' WHERE id='game'"
			);
		const response = await catalogueActionsPost(
			context.connection,
			event({ operationId: randomUUID(), kind: 'add', productIds: ['game'], listIds: ['visible'] })
		);
		expect(response.status).toBe(200);
		expect(
			context.connection.sqlite
				.prepare("SELECT estimate_pence FROM entries WHERE product_id='game'")
				.get()
		).toEqual({ estimate_pence: compatible ? 2000 : null });
	}
);
