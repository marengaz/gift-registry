import { getDatabase } from '#lib/server/db/client.ts';
import { wishlistPreview } from '#lib/server/enrichment/wishlist.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) => wishlistPreview(getDatabase(), event);
