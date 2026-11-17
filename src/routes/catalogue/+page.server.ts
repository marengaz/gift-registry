import { getDatabase } from '#lib/server/db/client.ts';
import { productsGet } from '#lib/server/catalogue.ts';
import { catalogueActionsGet } from '#lib/server/catalogue-actions.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async (event) => {
	const connection = getDatabase();
	const [catalogue, catalogueStatus] = await Promise.all([
		pageResult(
			productsGet(connection, {
				...event,
				url: new URL('/api/products', event.url)
			})
		),
		pageResult(catalogueActionsGet(connection, event))
	]);
	return { ...catalogue, catalogueStatus };
};
