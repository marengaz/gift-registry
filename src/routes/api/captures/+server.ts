import { getDatabase } from '#lib/server/db/client.ts';
import { capturesPost } from '#lib/server/capture-sync.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) => capturesPost(getDatabase(), event);
