import { authSetup } from '#lib/server/auth.ts';
export const load = ({ locals }: { locals: App.Locals }) => ({
	setup: authSetup(),
	person: locals.actor
		? {
				id: locals.actor.userId,
				name: locals.actor.name,
				email: locals.actor.email,
				member: locals.actor.member,
				administrator: locals.actor.administrator
			}
		: null
});
