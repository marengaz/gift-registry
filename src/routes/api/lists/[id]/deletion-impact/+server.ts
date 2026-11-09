import { getDatabase } from '#lib/server/db/client.ts';
import { listDeletionImpactGet } from '#lib/server/list-lifecycle.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) =>
	listDeletionImpactGet(getDatabase(), event, event.params.id);
