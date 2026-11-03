import { getDatabase } from '#lib/server/db/client.ts';
import { metadataImage } from '#lib/server/enrichment/preview.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) => metadataImage(getDatabase(), event);
