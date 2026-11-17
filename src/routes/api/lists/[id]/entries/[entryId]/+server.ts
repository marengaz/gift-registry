import { getDatabase } from '#lib/server/db/client.ts';
import { listEntryDelete } from '#lib/server/catalogue.ts';
import type { RequestHandler } from './$types';
export const DELETE: RequestHandler = (event) =>
	listEntryDelete(getDatabase(), event, event.params.id, event.params.entryId);
