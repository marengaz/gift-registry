import type { DatabaseConnection } from './db/client';
import {
	AccessError,
	requireAdministrator,
	requireAuthenticated,
	visibleLists,
	type Actor
} from './access';
import {
	createInvitation,
	peopleSettings,
	revokeInvitation,
	revokeMember,
	setGrant,
	type ListGrant
} from './invitations';
import { apiResponse, assertSameOrigin } from './http';
import { z } from 'zod';
const grant = z.object({
	listId: z.string().min(1),
	role: z.enum(['contributor', 'buyer', 'viewer'])
});
const operation = z.discriminatedUnion('action', [
	z.object({ action: z.literal('invite'), email: z.email(), grants: z.array(grant) }),
	z.object({
		action: z.literal('grant'),
		userId: z.string().min(1),
		listId: z.string().min(1),
		role: z.enum(['contributor', 'buyer', 'viewer']).nullable()
	}),
	z.object({ action: z.literal('revokeMember'), userId: z.string().min(1) }),
	z.object({ action: z.literal('revokeInvitation'), id: z.string().min(1) })
]);
export type PeopleEvent = { locals: { actor: Actor | null }; request: Request; url: URL };
export function peopleGet(connection: DatabaseConnection, event: PeopleEvent) {
	return apiResponse(() => {
		const actor = requireAdministrator(connection, event.locals.actor);
		return { ...peopleSettings(connection, actor), lists: visibleLists(connection, actor) };
	});
}
export function peoplePost(connection: DatabaseConnection, event: PeopleEvent) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const actor = requireAdministrator(connection, event.locals.actor);
		const parsed = operation.safeParse(await event.request.json());
		if (!parsed.success)
			throw new AccessError(400, 'Check the email address, person and list permissions.');
		const input = parsed.data;
		if (input.action === 'invite') {
			const result = createInvitation(connection, actor, {
				email: input.email,
				grants: input.grants as ListGrant[]
			});
			return {
				id: result.id,
				expiresAt: result.expiresAt,
				url: new URL(`/invite/${result.token}`, event.url.origin).href
			};
		}
		if (input.action === 'grant') setGrant(connection, actor, input.userId, input);
		if (input.action === 'revokeMember') revokeMember(connection, actor, input.userId);
		if (input.action === 'revokeInvitation') revokeInvitation(connection, actor, input.id);
		return { ok: true };
	});
}
export function ownIdentity(connection: DatabaseConnection, event: PeopleEvent) {
	return apiResponse(() => {
		const actor = requireAuthenticated(connection, event.locals.actor);
		return {
			id: actor.userId,
			name: actor.name,
			email: actor.email,
			member: actor.member,
			administrator: actor.administrator,
			lists: actor.member ? visibleLists(connection, actor) : []
		};
	});
}
