import { getDatabase } from '#lib/server/db/client.ts';
import { captureDuplicates } from '#lib/server/capture-duplicates.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => captureDuplicates(getDatabase(), event);
