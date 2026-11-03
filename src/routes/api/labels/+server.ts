import { getDatabase } from '#lib/server/db/client.ts';
import { labelsPost } from '#lib/server/catalogue.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) => labelsPost(getDatabase(), event);
