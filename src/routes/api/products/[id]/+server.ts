import { getDatabase } from '#lib/server/db/client.ts';
import { productGet, productPatch } from '#lib/server/catalogue.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => productGet(getDatabase(), event, event.params.id);
export const PATCH: RequestHandler = (event) => productPatch(getDatabase(), event, event.params.id);
