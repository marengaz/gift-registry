import { getDatabase } from '#lib/server/db/client.ts';
import { captureDetailsGet, captureDetailsPost } from '#lib/server/enrichment/gemini.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => captureDetailsGet(getDatabase(), event);
export const POST: RequestHandler = (event) => captureDetailsPost(getDatabase(), event);
