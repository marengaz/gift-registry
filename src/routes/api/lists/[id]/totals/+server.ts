import { getDatabase } from '#lib/server/db/client.ts';
import { listTotalsGet } from '#lib/server/totals.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => listTotalsGet(getDatabase(), event, event.params.id);
