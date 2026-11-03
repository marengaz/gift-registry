import { getDatabase } from '#lib/server/db/client.ts';
import { listsGet } from '#lib/server/catalogue.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => pageResult(listsGet(getDatabase(), event));
