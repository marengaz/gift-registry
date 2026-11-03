import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './identity-fixture';
import { parseCapture, productPatch, saveCapture } from '../../src/lib/server/catalogue';
import { projectProduct } from '../../src/lib/server/access';
import { acceptInvitation, createInvitation } from '../../src/lib/server/invitations';

let context: ReturnType<typeof fixture>;
afterEach(() => {
	vi.restoreAllMocks();
	context?.connection.close();
});

it('preserves the original offer observation through cosmetic edits, but dates new price evidence', async () => {
	context = fixture();
	const { connection, admin } = context;
	const original = parseCapture({
		title: 'Train',
		offers: [
			{ url: 'https://shop.example/train', retailer: 'Shop', priceMinor: 2000, currency: 'GBP' }
		]
	});
	const product = saveCapture(connection, admin, original);
	const offer = product.offers[0];
	connection.sqlite.prepare('UPDATE offers SET observed_at=1234 WHERE id=?').run(offer.id);
	async function edit(priceMinor: number, url = original.offers[0].url) {
		const target = new URL('http://localhost:4173/api/products/' + product.id);
		return productPatch(
			connection,
			{
				url: target,
				locals: { actor: admin },
				request: new Request(target, {
					method: 'PATCH',
					headers: { origin: target.origin, 'content-type': 'application/json' },
					body: JSON.stringify({
						...original,
						title: 'Blue train',
						labels: ['Age 5'],
						offers: [{ ...original.offers[0], retailer: 'Shop renamed', priceMinor, url }]
					})
				})
			},
			product.id
		);
	}
	const edited = await (await edit(2000)).json();
	expect(edited.offers[0]).toMatchObject({
		id: offer.id,
		observedAt: 1234,
		retailer: 'Shop renamed'
	});
	const repriced = await (await edit(2500)).json();
	expect(repriced.offers[0].observedAt).toBeGreaterThan(1234);
	expect(repriced.offers[0].id).not.toBe(offer.id);
	const relinked = await (await edit(2500, 'https://shop.example/different-train')).json();
	expect(relinked.offers[0].id).not.toBe(repriced.offers[0].id);
});

it('does not re-authorise unrelated product memberships while projecting one product', () => {
	context = fixture();
	const { connection, admin, actor } = context;
	acceptInvitation(
		connection,
		actor('guest'),
		createInvitation(connection, admin, {
			email: 'guest@example.test',
			grants: [{ listId: 'visible', role: 'viewer' }]
		}).token
	);
	const insertProduct = connection.sqlite.prepare(
		'INSERT INTO products (id,title,contributor_id) VALUES (?, ?, ?)'
	);
	const insertEntry = connection.sqlite.prepare(
		'INSERT INTO entries (id,product_id,list_id) VALUES (?, ?, ?)'
	);
	for (let index = 0; index < 101; index++) {
		insertProduct.run(`product-${index}`, 'Train', 'admin');
		insertEntry.run(`entry-${index}`, `product-${index}`, 'visible');
	}
	insertEntry.run('hidden-membership', 'product-0', 'secret');
	const guest = actor('guest');
	const queries = vi.spyOn(connection.sqlite, 'prepare');
	const projected = projectProduct(connection, guest, 'product-0');
	expect(projected?.entries.map((entry) => entry.id)).toEqual(['entry-0']);
	expect(queries.mock.calls.length).toBeLessThan(40);
});
