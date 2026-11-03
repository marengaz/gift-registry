import { getDatabase } from '#lib/server/db/client.ts';
import { diagnosticsGet } from '#lib/server/diagnostics.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) => pageResult(diagnosticsGet(getDatabase(), event));
