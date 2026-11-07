import { getDatabase } from '#lib/server/db/client.ts';
import { productsGet } from '#lib/server/catalogue.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = (event) =>
	pageResult(
		productsGet(getDatabase(), {
			...event,
			url: new URL('/api/products', event.url)
		})
	);
