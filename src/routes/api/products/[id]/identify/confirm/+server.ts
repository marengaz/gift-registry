import { getDatabase } from '#lib/server/db/client.ts';
import { confirmSuggestion } from '#lib/server/enrichment/jobs.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) =>
	confirmSuggestion(getDatabase(), event, event.params.id);
