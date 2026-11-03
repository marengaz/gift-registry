import { getDatabase } from '#lib/server/db/client.ts';
import { identificationGet, identificationPost } from '#lib/server/enrichment/settings.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => identificationGet(getDatabase(), event);
export const POST: RequestHandler = (event) => identificationPost(getDatabase(), event);
