import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from './identity-fixture';
import { listTotalsGet } from '../../src/lib/server/totals';
import { allocationPost } from '../../src/lib/server/allocations';
import { productPatch, type CatalogueEvent } from '../../src/lib/server/catalogue';
let context: ReturnType<typeof fixture>;
beforeEach(() => {
	context = fixture();
	context.connection.sqlite.exec(
		"INSERT INTO products(id,title,contributor_id) VALUES('one','One','admin'),('two','Two','admin'),('three','Three','admin'); INSERT INTO entries(id,product_id,list_id,estimate_pence) VALUES('one','one','visible',2000),('two','two','visible',3000),('three','three','visible',NULL)"
	);
});
afterEach(() => context.connection.close());
function event(body?: unknown): CatalogueEvent {
	const url = new URL('http://localhost:4173/api/lists/visible/totals');
	return {
		url,
		locals: { actor: context.admin },
		request: new Request(url, {
			method: body ? 'POST' : 'GET',
			headers: { origin: url.origin, 'content-type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {})
		})
	};
}
async function act(id: string, action: string, version: number, extra = {}) {
	const response = await allocationPost(
		context.connection,
		event({ action, actionId: randomUUID(), expectedVersion: version, ...extra }),
		id
	);
	expect(response.status).toBe(200);
}
async function totals() {
	return (await listTotalsGet(context.connection, event(), 'visible')).json();
}
describe('administrator GBP list totals', () => {
	it('sums all estimates, allocated including purchased, and actual purchases with separate unknown counts', async () => {
		await act('one', 'reserve', 0);
		await act('two', 'reserve', 0);
		await act('two', 'purchase', 1, { actualPence: 2500 });
		expect(await totals()).toEqual({
			all: { pence: 5000, unknown: 1, count: 3 },
			allocated: { pence: 5000, unknown: 0, count: 2 },
			purchased: { pence: 2500, unknown: 0, count: 1, estimatedCount: 0 }
		});
		expect(
			(
				await productPatch(
					context.connection,
					event({
						title: 'Two',
						listIds: ['visible'],
						offers: [{ url: 'https://example.test', priceMinor: 99999, currency: 'USD' }]
					}),
					'two'
				)
			).status
		).toBe(200);
		expect(
			context.connection.sqlite
				.prepare('SELECT actual_pence,estimate_pence FROM entries WHERE id=?')
				.get('two')
		).toEqual({ actual_pence: 2500, estimate_pence: 3000 });
		expect(await totals()).toMatchObject({ purchased: { pence: 2500 }, all: { pence: 5000 } });
		await act('two', 'undo', 2);
		await act('two', 'clear', 3);
		await act('one', 'release', 1);
		expect(await totals()).toMatchObject({
			allocated: { pence: 0, unknown: 0, count: 0 },
			purchased: { pence: 0, count: 0 }
		});
	});
	it('counts zero as known and labels purchased estimate fallback and untranslated foreign unknowns', async () => {
		context.connection.sqlite.exec(
			"UPDATE entries SET estimate_pence=0 WHERE id='one'; INSERT INTO offers(id,product_id,url,price_minor,currency) VALUES('usd','three','https://example.test',1000,'USD')"
		);
		for (const id of ['one', 'two', 'three']) {
			await act(id, 'reserve', 0);
			await act(id, 'purchase', 1);
		}
		expect(await totals()).toEqual({
			all: { pence: 3000, unknown: 1, count: 3 },
			allocated: { pence: 3000, unknown: 1, count: 3 },
			purchased: { pence: 3000, unknown: 1, count: 3, estimatedCount: 2 }
		});
		expect(
			(
				await productPatch(
					context.connection,
					event({
						title: 'Two',
						listIds: ['visible'],
						offers: [{ url: 'https://example.test', priceMinor: 99999, currency: 'USD' }]
					}),
					'two'
				)
			).status
		).toBe(200);
		expect(await totals()).toMatchObject({
			purchased: { pence: 3000, unknown: 1 },
			all: { pence: 3000 }
		});
	});
	it('denies totals to guests and unauthenticated users and retains archived list history', async () => {
		expect(
			(
				await listTotalsGet(
					context.connection,
					{ ...event(), locals: { actor: context.actor('guest') } },
					'visible'
				)
			).status
		).toBe(403);
		expect(
			(await listTotalsGet(context.connection, { ...event(), locals: { actor: null } }, 'visible'))
				.status
		).toBe(401);
		context.connection.sqlite.exec("UPDATE lists SET archived_at=1 WHERE id='visible'");
		expect(await totals()).toMatchObject({ all: { pence: 5000, unknown: 1 } });
		expect((await listTotalsGet(context.connection, event(), 'missing')).status).toBe(404);
	});
});
