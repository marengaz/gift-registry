import { describe, expect, it } from 'vitest';
import { filterIdeas, ideaRows, ideaPrice } from '../../src/lib/idea-collection';
import type { GiftEntry, GiftList, Product } from '../../src/lib/catalogue-types';

function product(
	id: string,
	entries: Pick<GiftEntry, 'listId' | 'state' | 'estimatePence'>[] = []
): Product {
	return {
		id,
		title: id,
		description: null,
		variant: null,
		contributorName: 'Parent',
		contributorId: 'parent',
		sourceUrl: null,
		sourceText: null,
		createdAt: 1,
		updatedAt: 1,
		offers: [],
		media: [],
		labels: [],
		entries: entries.map((entry, index) => ({
			id: id + index,
			productId: id,
			actualPence: null,
			allocationSource: entry.state === 'available' ? null : 'self',
			buyerId: entry.state === 'available' ? null : 'buyer',
			allocatedById: entry.state === 'available' ? null : 'buyer',
			allocatedAt: null,
			purchasedAt: null,
			version: 0,
			createdAt: 1,
			updatedAt: 1,
			...entry
		}))
	};
}
const shared = product('Shared toy', [
	{ listId: 'birthday', state: 'allocated', estimatePence: 2000 },
	{ listId: 'christmas', state: 'purchased', estimatePence: 500 }
]);
const lists = [
	{ id: 'birthday', name: 'Birthday', recipientName: 'Luke' },
	{ id: 'christmas', name: 'Christmas', recipientName: 'Kate' }
] as GiftList[];

describe('idea collections', () => {
	it('includes and excludes contrasting ideas for organisation filters', () => {
		const inbox = product('Inbox');
		inbox.contributorId = 'other';
		const complete = product('Complete', [
			{ listId: 'birthday', state: 'available', estimatePence: 1000 }
		]);
		complete.sourceUrl = 'https://shop.example/item';
		complete.media = [{ id: 'photo', mimeType: 'image/webp', originalName: null }];
		const rows = ideaRows([complete, inbox], 'catalogue');
		for (const query of [
			'contributor=other',
			'unlisted=1',
			'list=unlisted',
			'detail=photo',
			'detail=link'
		])
			expect(
				filterIdeas(rows, new URLSearchParams(query), lists).map((row) => row.product.id)
			).toEqual(['Inbox']);
		expect(
			filterIdeas(rows, new URLSearchParams('contributor=parent'), lists).map(
				(row) => row.product.id
			)
		).toEqual(['Complete']);
	});
	it('distinguishes self reservations from administrator assignments on each owned entry', () => {
		const assigned = {
			...shared,
			entries: shared.entries.map((entry) => ({
				...entry,
				allocationSource:
					entry.listId === 'birthday' ? ('self' as const) : ('administrator' as const)
			}))
		};
		const rows = ideaRows([assigned], 'mine');
		expect(
			filterIdeas(rows, new URLSearchParams('allocation=self'), lists).map(
				(row) => row.entry?.listId
			)
		).toEqual(['birthday']);
		expect(
			filterIdeas(rows, new URLSearchParams('allocation=administrator'), lists).map(
				(row) => row.entry?.listId
			)
		).toEqual(['christmas']);
	});
	it('orders complete known-price results, names and dates independently', () => {
		const cheap = product('Zulu', [{ listId: 'birthday', state: 'available', estimatePence: 500 }]);
		const expensive = product('Alpha', [
			{ listId: 'birthday', state: 'available', estimatePence: 1000 }
		]);
		const unknown = product('Middle', [
			{ listId: 'birthday', state: 'available', estimatePence: null }
		]);
		cheap.entries[0].createdAt = 3;
		unknown.entries[0].createdAt = 2;
		const rows = ideaRows([unknown, expensive, cheap], 'list', 'birthday');
		for (const [sort, expected] of [
			['', ['Zulu', 'Middle', 'Alpha']],
			['name', ['Alpha', 'Middle', 'Zulu']],
			['price-low', ['Zulu', 'Alpha', 'Middle']],
			['price-high', ['Alpha', 'Zulu', 'Middle']]
		] as const)
			expect(
				filterIdeas(rows, new URLSearchParams({ sort }), lists).map((row) => row.product.id)
			).toEqual(expected);
	});
	it('correlates recipient and occasion searches with the same status and budget, while keeping product text global', () => {
		const rows = ideaRows([shared], 'catalogue');
		for (const query of [
			'q=Kate&status=allocated',
			'q=Luke&max=10',
			'q=Christmas&status=allocated'
		])
			expect(filterIdeas(rows, new URLSearchParams(query), lists)).toEqual([]);
		const match = filterIdeas(rows, new URLSearchParams('q=Kate&status=purchased'), lists);
		expect(match).toHaveLength(1);
		expect(match[0].product.entries.map((entry) => entry.listId)).toEqual(['christmas']);
		expect(ideaPrice(match[0])).toBe(500);
		expect(
			filterIdeas(rows, new URLSearchParams('q=Shared+toy&status=allocated'), lists)
		).toHaveLength(1);
	});
	it('matches list, budget and state against the same membership', () => {
		const rows = ideaRows([shared], 'catalogue');
		expect(filterIdeas(rows, new URLSearchParams('list=birthday&status=purchased'), lists)).toEqual(
			[]
		);
		expect(filterIdeas(rows, new URLSearchParams('list=birthday&max=10'), lists)).toEqual([]);
		expect(ideaPrice(filterIdeas(rows, new URLSearchParams('list=birthday'), lists)[0])).toBe(2000);
		expect(
			filterIdeas(rows, new URLSearchParams('list=christmas&status=purchased&max=10'), lists)
		).toHaveLength(1);
	});
	it('keeps each owned allocation distinct for state, price and recipient searches', () => {
		const rows = ideaRows([shared], 'mine');
		const pending = filterIdeas(rows, new URLSearchParams('status=allocated'), lists);
		expect(pending).toHaveLength(1);
		expect(ideaPrice(pending[0])).toBe(2000);
		expect(
			filterIdeas(rows, new URLSearchParams('q=Kate'), lists).map((row) => row.entry?.listId)
		).toEqual(['christmas']);
	});
	it('includes zero, excludes unknown estimates from a budget and puts unknown prices last in both directions', () => {
		const unknown = product('Unknown', [
			{ listId: 'birthday', state: 'available', estimatePence: null }
		]);
		const free = product('Free', [{ listId: 'birthday', state: 'available', estimatePence: 0 }]);
		const rows = ideaRows([unknown, free, shared], 'list', 'birthday');
		expect(
			filterIdeas(rows, new URLSearchParams('max=0'), lists).map((row) => row.product.id)
		).toEqual(['Free']);
		for (const sort of ['price-low', 'price-high'])
			expect(filterIdeas(rows, new URLSearchParams({ sort }), lists).at(-1)?.product.id).toBe(
				'Unknown'
			);
	});
	it('does not interpret foreign offer minor units as a GBP budget', () => {
		const foreign = product('Foreign');
		foreign.offers = [{ currency: 'JPY', priceMinor: 100 }] as Product['offers'];
		const rows = ideaRows([foreign], 'inbox');
		expect(ideaPrice(rows[0])).toBeNull();
		expect(filterIdeas(rows, new URLSearchParams('max=10'), lists)).toEqual([]);
		expect(filterIdeas(rows, new URLSearchParams('detail=price'), lists)).toHaveLength(1);
	});
});
