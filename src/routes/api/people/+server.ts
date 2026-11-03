import { getDatabase } from '#lib/server/db/client.ts';
import { peopleGet, peoplePost } from '#lib/server/people-api.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => peopleGet(getDatabase(), event);
export const POST: RequestHandler = (event) => peoplePost(getDatabase(), event);
