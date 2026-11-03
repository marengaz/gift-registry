import { getDatabase } from '#lib/server/db/client.ts';
import { productsGet, productsPost } from '#lib/server/catalogue.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = (event) => productsGet(getDatabase(), event);
export const POST: RequestHandler = (event) => productsPost(getDatabase(), event);
