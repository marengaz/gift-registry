import { error } from '@sveltejs/kit';
import { getDatabase } from '#lib/server/db/client.ts';
import { AccessError, requireAdministrator, visibleLists } from '#lib/server/access.ts';
import { peopleSettings } from '#lib/server/invitations.ts';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ locals }) => {
	const connection = getDatabase();
	try {
		const actor = requireAdministrator(connection, locals.actor);
		return { ...peopleSettings(connection, actor), lists: visibleLists(connection, actor) };
	} catch (caught) {
		if (caught instanceof AccessError) error(caught.status, caught.message);
		throw caught;
	}
};
