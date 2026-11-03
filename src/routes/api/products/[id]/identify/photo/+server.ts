import { getDatabase } from '#lib/server/db/client.ts';
import { attachIdentificationPhoto } from '#lib/server/enrichment/jobs.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) =>
	attachIdentificationPhoto(getDatabase(), event, event.params.id);
