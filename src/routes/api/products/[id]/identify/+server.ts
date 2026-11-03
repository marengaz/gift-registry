import { getDatabase } from '#lib/server/db/client.ts';
import { identifyGet, identifyPost } from '#lib/server/enrichment/jobs.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => identifyGet(getDatabase(), event, event.params.id);
export const POST: RequestHandler = (event) => identifyPost(getDatabase(), event, event.params.id);
