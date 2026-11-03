import { getDatabase } from '#lib/server/db/client.ts';
import { mediaGet } from '#lib/server/media.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => mediaGet(getDatabase(), event, event.params.id);
