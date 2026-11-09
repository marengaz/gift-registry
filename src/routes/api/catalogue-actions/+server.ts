import { getDatabase } from '#lib/server/db/client.ts';
import { catalogueActionsGet, catalogueActionsPost } from '#lib/server/catalogue-actions.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => catalogueActionsGet(getDatabase(), event);
export const POST: RequestHandler = (event) => catalogueActionsPost(getDatabase(), event);
