import { getDatabase } from '#lib/server/db/client.ts';
import { checkOffer } from '#lib/server/offer-check.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) =>
	checkOffer(getDatabase(), event, event.params.id, event.params.offerId);
