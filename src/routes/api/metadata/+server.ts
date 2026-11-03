import { getDatabase } from '#lib/server/db/client.ts';
import { metadataPreview } from '#lib/server/enrichment/preview.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) => metadataPreview(getDatabase(), event);
