import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { DatabaseConnection } from './db/client';
import { offers, products } from './db/schema';
import {
	canonicalOfferURL,
	reviewFingerprint,
	type LookupProvider,
	type OfferReviewStatus
} from '../shared/photo-shopping-links';
import type { ProductSuggestion } from './enrichment/types';

export function invalidateOfferChecks(connection: DatabaseConnection, productId: string) {
	connection.db
		.update(offers)
		.set({ checkedAt: null, checkedById: null, checkedFingerprint: null })
		.where(eq(offers.productId, productId))
		.run();
}
type PublicOffer = Pick<
	typeof offers.$inferSelect,
	'id' | 'productId' | 'url' | 'retailer' | 'priceMinor' | 'currency' | 'observedAt'
> &
	OfferReviewStatus;
export function publicOffers(
	connection: DatabaseConnection,
	product: { id: string; title: string; variant: string | null }
): PublicOffer[] {
	return connection.db
		.select({
			id: offers.id,
			productId: offers.productId,
			url: offers.url,
			retailer: offers.retailer,
			priceMinor: offers.priceMinor,
			currency: offers.currency,
			observedAt: offers.observedAt,
			reverseFound: sql<boolean>`${offers.reverseProvider} IS NOT NULL`.mapWith(Boolean),
			checkedAt: offers.checkedAt,
			checkedFingerprint: offers.checkedFingerprint
		})
		.from(offers)
		.where(eq(offers.productId, product.id))
		.all()
		.map((offer) => {
			const fingerprint = reviewFingerprint(product, offer.url);
			const checkedAt = offer.checkedFingerprint === fingerprint ? offer.checkedAt : null;
			return {
				id: offer.id,
				productId: offer.productId,
				url: offer.url,
				retailer: offer.retailer,
				priceMinor: offer.priceMinor,
				currency: offer.currency,
				observedAt: offer.observedAt,
				reverseFound: offer.reverseFound,
				checked: offer.reverseFound && checkedAt != null,
				checkedAt: offer.reverseFound ? checkedAt : null,
				reviewFingerprint: fingerprint
			};
		});
}
/** Call inside the freshly authorised suggestion-confirmation transaction. */
export function acceptSuggestedOffer(
	connection: DatabaseConnection,
	input: {
		productId: string;
		jobId: string;
		index: number;
		suggestion: ProductSuggestion;
		provider: LookupProvider;
		kind: string;
	}
) {
	const offer = input.suggestion.offer;
	if (!offer) return;
	const previous = connection.db
		.select()
		.from(offers)
		.where(eq(offers.productId, input.productId))
		.all();
	const canonicalURL = canonicalOfferURL(offer.url);
	const existing = previous
		.filter((saved) => canonicalOfferURL(saved.url) === canonicalURL)
		.sort((a, b) => Number(!!b.reverseProvider) - Number(!!a.reverseProvider))[0];
	const reverse = input.kind === 'vision';
	if (existing) {
		if (reverse && !existing.reverseProvider)
			connection.db
				.update(offers)
				.set({
					reverseProvider: input.provider,
					reverseJobId: input.jobId,
					checkedAt: null,
					checkedById: null,
					checkedFingerprint: null
				})
				.where(eq(offers.id, existing.id))
				.run();
		return;
	}
	connection.db
		.insert(offers)
		.values({
			id: `lookup-${input.jobId}-${input.index}`,
			productId: input.productId,
			url: canonicalURL,
			retailer: offer.retailer,
			priceMinor: offer.fromPrice ? null : offer.priceMinor,
			currency: offer.currency,
			observedAt: input.suggestion.retrievedAt,
			reverseProvider: reverse ? input.provider : null,
			reverseJobId: reverse ? input.jobId : null
		})
		.onConflictDoNothing()
		.run();
}
export function reconcileOffers(
	connection: DatabaseConnection,
	productId: string,
	links: {
		id?: string;
		url: string;
		retailer?: string | null;
		priceMinor?: number | null;
		currency?: string | null;
	}[]
) {
	const previous = connection.db.select().from(offers).where(eq(offers.productId, productId)).all();
	const product = connection.db.select().from(products).where(eq(products.id, productId)).get()!;
	for (const link of links)
		if (link.id && !previous.some((saved) => saved.id === link.id))
			throw new Error('foreign-offer-id');
	const groups = new Map<string, typeof links>();
	for (const link of links) {
		const url = canonicalOfferURL(link.url);
		groups.set(url, [...(groups.get(url) ?? []), link]);
	}
	const reserved = new Set(links.map((link) => link.id).filter((id) => id != null));
	const used = new Set<string>();
	const reconciled = [...groups.entries()].map(([url, duplicates]) => {
		const link = duplicates[0];
		const lineage = previous.filter(
			(saved) =>
				duplicates.some((item) => item.id === saved.id) || canonicalOfferURL(saved.url) === url
		);
		const reverse = lineage.find((saved) => saved.reverseProvider);
		const candidates = lineage.filter(
			(saved) =>
				!used.has(saved.id) &&
				(!reserved.has(saved.id) || duplicates.some((item) => item.id === saved.id))
		);
		const owned = candidates.find((saved) => duplicates.some((item) => item.id === saved.id));
		const exact = candidates.find(
			(saved) =>
				saved.priceMinor === (link.priceMinor ?? null) && saved.currency === (link.currency ?? null)
		);
		const retained = owned ?? candidates.find((saved) => saved.reverseProvider) ?? exact;
		if (retained) used.add(retained.id);
		const sameEvidence =
			retained &&
			canonicalOfferURL(retained.url) === url &&
			retained.priceMinor === (link.priceMinor ?? null) &&
			retained.currency === (link.currency ?? null);
		const compatible = lineage.find(
			(saved) =>
				saved.reverseProvider && saved.checkedFingerprint === reviewFingerprint(product, url)
		);
		return {
			id: retained?.id ?? randomUUID(),
			productId,
			url,
			retailer: link.retailer ?? null,
			priceMinor: link.priceMinor ?? null,
			currency: link.currency ?? null,
			observedAt: sameEvidence ? retained.observedAt : Date.now(),
			reverseProvider: reverse?.reverseProvider ?? null,
			reverseJobId: reverse?.reverseJobId ?? null,
			checkedAt: compatible?.checkedAt ?? null,
			checkedById: compatible?.checkedById ?? null,
			checkedFingerprint: compatible?.checkedFingerprint ?? null
		};
	});
	connection.db.delete(offers).where(eq(offers.productId, productId)).run();
	for (const offer of reconciled) connection.db.insert(offers).values(offer).run();
}
