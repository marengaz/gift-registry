import { getDatabase } from '#lib/server/db/client.ts';
import { listsGet, listPatch } from '#lib/server/catalogue.ts';
import { listDelete } from '#lib/server/list-lifecycle.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => listsGet(getDatabase(), event, event.params.id);
export const PATCH: RequestHandler = (event) => listPatch(getDatabase(), event, event.params.id);
export const DELETE: RequestHandler = (event) => listDelete(getDatabase(), event, event.params.id);
