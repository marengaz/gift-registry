import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AccessError, canReadProduct, requireAdministrator } from './access';
import type { CatalogueEvent } from './catalogue';
import type { DatabaseConnection } from './db/client';
import { offers, products } from './db/schema';
import { apiResponse, assertSameOrigin } from './http';
import { canonicalOfferURL, reviewFingerprint } from '../shared/photo-shopping-links';
const checkSchema = z.object({
	checked: z.boolean(),
	reviewedURL: z.string().url(),
	reviewFingerprint: z.string().min(1)
});
export function checkOffer(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	productId: string,
	offerId: string
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const input = checkSchema.safeParse(await event.request.json());
		if (!input.success)
			throw new AccessError(
				400,
				'Review the current shopping link and product before checking it.'
			);
		return connection.sqlite
			.transaction(() => {
				const actor = requireAdministrator(connection, event.locals.actor);
				if (!canReadProduct(connection, actor, productId))
					throw new AccessError(404, 'Idea not found.');
				const product = connection.db
					.select()
					.from(products)
					.where(eq(products.id, productId))
					.get();
				const offer = connection.db
					.select()
					.from(offers)
					.where(and(eq(offers.id, offerId), eq(offers.productId, productId)))
					.get();
				if (!product || !offer || !offer.reverseProvider)
					throw new AccessError(404, 'Reverse-found shopping link not found.');
				const fingerprint = reviewFingerprint(product, offer.url);
				if (
					canonicalOfferURL(input.data.reviewedURL) !== canonicalOfferURL(offer.url) ||
					input.data.reviewFingerprint !== fingerprint
				)
					throw new AccessError(
						409,
						'The product or shopping link changed. Review its current details before checking it.'
					);
				const checkedAt = input.data.checked ? Date.now() : null;
				connection.db
					.update(offers)
					.set({
						checkedAt,
						checkedById: input.data.checked ? actor.userId : null,
						checkedFingerprint: input.data.checked ? fingerprint : null
					})
					.where(eq(offers.id, offer.id))
					.run();
				return { checked: input.data.checked, checkedAt };
			})
			.immediate();
	});
}
