import { getDatabase } from '#lib/server/db/client.ts';
import { allocationGet, allocationPost } from '#lib/server/allocations.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => allocationGet(getDatabase(), event, event.params.id);
export const POST: RequestHandler = (event) =>
	allocationPost(getDatabase(), event, event.params.id);
