import { getDatabase } from '#lib/server/db/client.ts';
import { ownIdentity } from '#lib/server/people-api.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => ownIdentity(getDatabase(), event);
