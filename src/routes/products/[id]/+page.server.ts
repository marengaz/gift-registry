import { getDatabase } from '#lib/server/db/client.ts';
import { productGet } from '#lib/server/catalogue.ts';
import { requireMember, visibleLists } from '#lib/server/access.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async (event) => {
	const product = await pageResult(productGet(getDatabase(), event, event.params.id));
	const actor = requireMember(getDatabase(), event.locals.actor);
	return { product, lists: visibleLists(getDatabase(), actor), administrator: actor.administrator };
};
