import { getDatabase } from '#lib/server/db/client.ts';
import { productGet } from '#lib/server/catalogue.ts';
import { canEditProduct, requireMember, visibleLists } from '#lib/server/access.ts';
import { pageResult } from '#lib/server/page.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async (event) => {
	const connection = getDatabase();
	const product = await pageResult(productGet(connection, event, event.params.id));
	const actor = requireMember(connection, event.locals.actor);
	return {
		product,
		lists: visibleLists(connection, actor),
		administrator: actor.administrator,
		collaborator: actor.collaborator,
		canEdit: canEditProduct(connection, actor, event.params.id)
	};
};
