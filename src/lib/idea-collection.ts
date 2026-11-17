import { money, pence, type GiftEntry, type GiftList, type Product } from './catalogue-types';

export type CollectionKind = 'catalogue' | 'inbox' | 'list' | 'mine';
export type IdeaRow = { product: Product; entry?: GiftEntry };

export function ideaRows(products: Product[], kind: CollectionKind, listId?: string): IdeaRow[] {
	return products.flatMap((product) =>
		kind === 'mine'
			? product.entries.map((entry) => ({ product, entry }))
			: [{ product, entry: product.entries.find((entry) => entry.listId === listId) }]
	);
}

export function ideaPrice(row: IdeaRow): number | null {
	if (row.entry) return row.entry.estimatePence;
	const values = row.product.entries.length
		? row.product.entries.map((entry) => entry.estimatePence)
		: row.product.offers
				.filter((offer) => offer.currency === 'GBP')
				.map((offer) => offer.priceMinor);
	const known = values.filter((value): value is number => value !== null);
	return known.length ? Math.min(...known) : null;
}

export function ideaPriceLabel(row: IdeaRow): string {
	const price = ideaPrice(row);
	return (
		(!row.entry &&
		(row.product.entries.length > 1 || row.product.offers.length > 1) &&
		price !== null
			? 'From '
			: '') + money(price)
	);
}

export function filterIdeas(
	rows: IdeaRow[],
	query: Pick<URLSearchParams, 'get'>,
	lists: GiftList[]
): IdeaRow[] {
	const search = query.get('q')?.trim().toLocaleLowerCase('en-GB') ?? '';
	const listId = query.get('unlisted') === '1' ? 'unlisted' : query.get('list');
	const status = query.get('status');
	const allocation = query.get('allocation');
	const label = query.get('label');
	const author = query.get('contributor');
	const detail = query.get('detail');
	let maximum: number | null = null;
	try {
		maximum = pence(query.get('max') ?? '');
	} catch {}
	const entryMatches = (entry: GiftEntry) =>
		(!listId || entry.listId === listId) &&
		(!status || entry.state === status) &&
		(!allocation || entry.allocationSource === allocation) &&
		(maximum === null || (entry.estimatePence !== null && entry.estimatePence <= maximum)) &&
		(detail !== 'price' || entry.estimatePence === null);
	const includesSearch = (values: (string | null | undefined)[]) =>
		values.filter(Boolean).join(' ').toLocaleLowerCase('en-GB').includes(search);
	const filtered = rows.flatMap((row) => {
		const product = row.product;
		const entries = row.entry ? [row.entry] : product.entries;
		const productMatchesSearch =
			!search ||
			includesSearch([
				product.title,
				product.description,
				product.variant,
				product.contributorName,
				...product.labels.map((label) => label.name),
				...product.offers.map((offer) => offer.retailer)
			]);
		if (label && !product.labels.some((item) => item.id === label)) return [];
		if (author && product.contributorId !== author) return [];
		if (detail === 'photo' && product.media.length) return [];
		if (detail === 'link' && (product.sourceUrl || product.offers.length)) return [];
		if (!entries.length)
			return productMatchesSearch &&
				(!listId || (listId === 'unlisted' && !product.hasHiddenEntries)) &&
				!status &&
				!allocation &&
				(maximum === null || (ideaPrice(row) !== null && ideaPrice(row)! <= maximum)) &&
				(detail !== 'price' || ideaPrice(row) === null)
				? [row]
				: [];
		const matching = entries.filter((entry) => {
			if (!entryMatches(entry)) return false;
			if (productMatchesSearch) return true;
			const list = lists.find((list) => list.id === entry.listId);
			return !!list && includesSearch([list.recipientName, list.name, list.occasion]);
		});
		if (!matching.length) return [];
		return [row.entry ? row : { ...row, product: { ...product, entries: matching } }];
	});
	const sort = query.get('sort');
	if (!sort)
		filtered.sort(
			(a, b) =>
				(b.entry?.createdAt ?? b.product.createdAt) - (a.entry?.createdAt ?? a.product.createdAt)
		);
	if (sort === 'name')
		filtered.sort((a, b) => a.product.title.localeCompare(b.product.title, 'en-GB'));
	if (sort === 'price-low' || sort === 'price-high')
		filtered.sort((a, b) => {
			const left = ideaPrice(a),
				right = ideaPrice(b);
			if (left === null) return right === null ? 0 : 1;
			if (right === null) return -1;
			return sort === 'price-low' ? left - right : right - left;
		});
	return filtered;
}
