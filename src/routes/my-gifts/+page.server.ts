import { getDatabase } from '#lib/server/db/client.ts';
import { myGiftsGet } from '#lib/server/allocations.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => pageResult(myGiftsGet(getDatabase(), event));
