import { fail, redirect } from '@sveltejs/kit';
import { getDatabase } from '#lib/server/db/client.ts';
import { acceptInvitation } from '#lib/server/invitations.ts';
import { AccessError } from '#lib/server/access.ts';
import { assertSameOrigin } from '#lib/server/http.ts';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = ({ locals, params }) => {
	if (!locals.actor) redirect(303, `/login?next=${encodeURIComponent('/invite/' + params.token)}`);
	return { email: locals.actor.email };
};
export const actions: Actions = {
	default: async ({ locals, params, request, url }) => {
		try {
			assertSameOrigin(request, url);
			if (!locals.actor)
				redirect(303, `/login?next=${encodeURIComponent('/invite/' + params.token)}`);
			acceptInvitation(getDatabase(), locals.actor, params.token);
		} catch (error) {
			if (error instanceof AccessError) return fail(error.status, { message: error.message });
			throw error;
		}
		redirect(303, '/');
	}
};
