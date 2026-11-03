import { getDatabase } from '#lib/server/db/client.ts';
import { listsGet, listsPost } from '#lib/server/catalogue.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => listsGet(getDatabase(), event);
export const POST: RequestHandler = (event) => listsPost(getDatabase(), event);
