import { getDatabase } from '#lib/server/db/client.ts';
import { quidcoLookup } from '#lib/server/enrichment/quidco.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => quidcoLookup(getDatabase(), event);
