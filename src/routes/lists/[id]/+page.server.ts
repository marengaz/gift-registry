import { getDatabase } from '#lib/server/db/client.ts';
import { listsGet } from '#lib/server/catalogue.ts';
import { calculateListTotals } from '#lib/server/totals.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async (event) => {
	const connection = getDatabase();
	const result = await pageResult(listsGet(connection, event, event.params.id));
	return {
		...result,
		totals: result.administrator
			? calculateListTotals(connection, event.locals.actor, event.params.id)
			: null
	};
};
