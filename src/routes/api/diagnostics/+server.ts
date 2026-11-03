import { getDatabase } from '#lib/server/db/client.ts';
import { diagnosticsGet } from '#lib/server/diagnostics.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => diagnosticsGet(getDatabase(), event);
