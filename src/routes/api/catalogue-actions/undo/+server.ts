import { getDatabase } from '#lib/server/db/client.ts';
import { catalogueActionsUndoPost } from '#lib/server/catalogue-actions.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) => catalogueActionsUndoPost(getDatabase(), event);
