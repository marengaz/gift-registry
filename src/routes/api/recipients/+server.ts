import { getDatabase } from '#lib/server/db/client.ts';
import { recipientsPost } from '#lib/server/catalogue.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = (event) => recipientsPost(getDatabase(), event);
