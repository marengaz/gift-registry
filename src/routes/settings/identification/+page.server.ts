import { getDatabase } from '#lib/server/db/client.ts';
import { identificationGet } from '#lib/server/enrichment/settings.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => pageResult(identificationGet(getDatabase(), event));
