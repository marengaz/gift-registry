import { publicOffers } from './offer-review';
import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseConnection } from './db/client';
import { entries, lists, media, productLabels, labels, products, recipients } from './db/schema';

export type SiteRole = 'administrator' | 'collaborator' | 'buyer' | 'guest';
export type ListRole = 'contributor' | 'buyer' | 'viewer';
export type Actor = {
	userId: string;
	sessionId: string;
	googleSubject: string;
	email: string;
	name: string;
	siteRole: SiteRole;
	superAdministrator: boolean;
	administrator: boolean;
	collaborator: boolean;
	buyer: boolean;
	member: boolean;
};
export type AdministratorIdentity = {
	administratorEmail?: string;
	administratorGoogleSubject?: string;
};
export class AccessError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}
export const normaliseEmail = (email: string) => email.trim().toLowerCase();

type Identity = { userId: string; email: string; name: string; googleSubject: string };
function currentIdentity(connection: DatabaseConnection, sessionId: string): Identity | undefined {
	return connection.sqlite
		.prepare(
			`SELECT u.id AS userId,u.email,u.name,a.account_id AS googleSubject
 FROM session s JOIN user u ON u.id=s.user_id JOIN account a ON a.user_id=u.id AND a.provider_id='google'
 WHERE s.id=? AND s.expires_at>? AND u.email_verified=1`
		)
		.get(sessionId, Date.now()) as Identity | undefined;
}

/** Call only with the session ID obtained from Better Auth's verified request session. */
export function resolveActor(
	connection: DatabaseConnection,
	sessionId: string,
	configured: AdministratorIdentity = {}
): Actor | null {
	const identity = currentIdentity(connection, sessionId);
	if (!identity) return null;
	return connection.sqlite
		.transaction(() => {
			let settings = connection.sqlite
				.prepare(
					'SELECT administrator_id AS id,administrator_google_subject AS subject FROM application_settings WHERE id=1'
				)
				.get() as { id: string; subject: string } | undefined;
			const matches = configured.administratorGoogleSubject
				? identity.googleSubject === configured.administratorGoogleSubject
				: !!configured.administratorEmail &&
					normaliseEmail(identity.email) === normaliseEmail(configured.administratorEmail);
			if (!settings && matches) {
				connection.sqlite
					.prepare(
						'INSERT INTO application_settings (id,administrator_id,administrator_google_subject) VALUES (1,?,?)'
					)
					.run(identity.userId, identity.googleSubject);
				settings = { id: identity.userId, subject: identity.googleSubject };
			}
			const superAdministrator =
				settings?.id === identity.userId && settings.subject === identity.googleSubject;
			const membership = connection.sqlite
				.prepare('SELECT role FROM household_members WHERE user_id=? AND google_subject=?')
				.get(identity.userId, identity.googleSubject) as { role: SiteRole } | undefined;
			const siteRole: SiteRole = superAdministrator
				? 'administrator'
				: (membership?.role ?? 'guest');
			const administrator = superAdministrator || siteRole === 'administrator';
			const collaborator = administrator || siteRole === 'collaborator';
			const buyer = collaborator || siteRole === 'buyer';
			const member = superAdministrator || !!membership;
			return {
				...identity,
				sessionId,
				siteRole,
				superAdministrator,
				administrator,
				collaborator,
				buyer,
				member
			};
		})
		.immediate();
}
export function requireAuthenticated(
	connection: DatabaseConnection,
	actor: Actor | null | undefined
): Actor {
	if (!actor) throw new AccessError(401, 'Sign in with Google to continue.');
	const fresh = resolveActor(connection, actor.sessionId);
	if (!fresh || fresh.userId !== actor.userId || fresh.googleSubject !== actor.googleSubject)
		throw new AccessError(401, 'Your session has ended. Sign in again.');
	return fresh;
}
export function requireMember(
	connection: DatabaseConnection,
	actor: Actor | null | undefined
): Actor {
	const fresh = requireAuthenticated(connection, actor);
	if (!fresh.member) throw new AccessError(403, 'An invitation is needed to access family gifts.');
	return fresh;
}
export function requireAdministrator(
	connection: DatabaseConnection,
	actor: Actor | null | undefined
): Actor {
	const fresh = requireMember(connection, actor);
	if (!fresh.administrator) throw new AccessError(403, 'Only the administrator can do this.');
	return fresh;
}
export function requireCollaborator(
	connection: DatabaseConnection,
	actor: Actor | null | undefined
): Actor {
	const fresh = requireMember(connection, actor);
	if (!fresh.collaborator)
		throw new AccessError(403, 'Collaborator or administrator access is needed.');
	return fresh;
}
export function listRole(
	connection: DatabaseConnection,
	actor: Actor,
	listId: string
): ListRole | null {
	const fresh = requireMember(connection, actor);
	const list = connection.db.select().from(lists).where(eq(lists.id, listId)).get();
	if (!list || list.deletedAt !== null || (!fresh.administrator && list.archivedAt !== null))
		return null;
	if (fresh.administrator || fresh.collaborator) return 'contributor';
	const granted =
		(
			connection.sqlite
				.prepare('SELECT role FROM grants WHERE user_id=? AND list_id=?')
				.get(fresh.userId, listId) as { role: ListRole } | undefined
		)?.role ?? null;
	if (fresh.buyer) return granted === 'contributor' ? 'contributor' : 'buyer';
	return granted;
}
export function requireListRole(
	connection: DatabaseConnection,
	actor: Actor,
	listId: string,
	roles: ListRole[]
): Actor {
	const role = listRole(connection, actor, listId);
	if (!role || !roles.includes(role))
		throw new AccessError(403, 'You do not have permission for this list.');
	return requireMember(connection, actor);
}
/** A site-wide buyer/collaborator/admin or active contributor/buyer list grant permits capture, including the author's unlisted inbox. */
export function canCapture(connection: DatabaseConnection, actor: Actor): boolean {
	const fresh = requireMember(connection, actor);
	return (
		fresh.administrator ||
		fresh.collaborator ||
		fresh.buyer ||
		!!connection.sqlite
			.prepare(
				`SELECT 1 FROM grants g JOIN lists l ON l.id=g.list_id WHERE g.user_id=? AND g.role IN ('contributor','buyer') AND l.archived_at IS NULL AND l.deleted_at IS NULL LIMIT 1`
			)
			.get(fresh.userId)
	);
}
export function visibleLists(connection: DatabaseConnection, actor: Actor) {
	const fresh = requireMember(connection, actor);
	return connection.db
		.select({ list: lists, recipient: recipients })
		.from(lists)
		.innerJoin(recipients, eq(lists.recipientId, recipients.id))
		.where(isNull(lists.deletedAt))
		.all()
		.filter(({ list }) => fresh.administrator || listRole(connection, fresh, list.id) !== null)
		.map(({ list, recipient }) => ({
			id: list.id,
			recipientId: list.recipientId,
			name: list.name,
			occasion: list.occasion,
			archivedAt: list.archivedAt,
			createdAt: list.createdAt,
			recipientName: recipient.name,
			role: fresh.administrator ? ('administrator' as const) : listRole(connection, fresh, list.id)
		}));
}
export function visibleEntries(
	connection: DatabaseConnection,
	actor: Actor,
	filter: { listId?: string; productId?: string } = {}
) {
	const fresh = requireMember(connection, actor);
	return connection.db
		.select({ entry: entries })
		.from(entries)
		.innerJoin(products, eq(entries.productId, products.id))
		.innerJoin(lists, eq(entries.listId, lists.id))
		.where(
			and(
				isNull(products.deletedAt),
				isNull(lists.deletedAt),
				filter.listId ? eq(entries.listId, filter.listId) : undefined,
				filter.productId ? eq(entries.productId, filter.productId) : undefined
			)
		)
		.all()
		.map(({ entry }) => entry)
		.filter(
			(entry) =>
				fresh.administrator ||
				(listRole(connection, fresh, entry.listId) !== null &&
					(entry.state === 'available' || entry.buyerId === fresh.userId))
		);
}
export function canReadProduct(
	connection: DatabaseConnection,
	actor: Actor,
	productId: string
): boolean {
	const fresh = requireMember(connection, actor);
	const product = connection.db.select().from(products).where(eq(products.id, productId)).get();
	if (!product || product.deletedAt !== null) return false;
	if (fresh.administrator || fresh.collaborator) return true;
	const memberships = connection.db
		.select({ entry: entries })
		.from(entries)
		.innerJoin(lists, eq(entries.listId, lists.id))
		.where(and(eq(entries.productId, productId), isNull(lists.deletedAt)))
		.all()
		.map(({ entry }) => entry);
	if (memberships.length === 0) return product.contributorId === fresh.userId;
	return memberships.some(
		(entry) =>
			listRole(connection, fresh, entry.listId) !== null &&
			(entry.state === 'available' || entry.buyerId === fresh.userId)
	);
}
export function canEditProduct(
	connection: DatabaseConnection,
	actor: Actor,
	productId: string
): boolean {
	const fresh = requireMember(connection, actor);
	if (!canReadProduct(connection, fresh, productId)) return false;
	if (fresh.administrator || fresh.collaborator) return true;
	const product = connection.db.select().from(products).where(eq(products.id, productId)).get();
	return !!product && product.contributorId === fresh.userId && canCapture(connection, fresh);
}
export function hasIdentifyRole(
	connection: DatabaseConnection,
	actor: Actor,
	productId: string
): boolean {
	const fresh = requireMember(connection, actor);
	if (fresh.administrator || fresh.collaborator) return true;
	const product = connection.db.select().from(products).where(eq(products.id, productId)).get();
	if (product && product.contributorId === fresh.userId && canCapture(connection, fresh))
		return true;
	return !!connection.sqlite
		.prepare(
			`SELECT 1 FROM entries e JOIN grants g ON g.list_id=e.list_id JOIN lists l ON l.id=e.list_id WHERE e.product_id=? AND g.user_id=? AND g.role='contributor' AND l.archived_at IS NULL AND l.deleted_at IS NULL LIMIT 1`
		)
		.get(productId, fresh.userId);
}
export function canIdentifyProduct(
	connection: DatabaseConnection,
	actor: Actor,
	productId: string
): boolean {
	const fresh = requireMember(connection, actor);
	return (
		canReadProduct(connection, fresh, productId) && hasIdentifyRole(connection, fresh, productId)
	);
}
export function requireMediaAccess(connection: DatabaseConnection, actor: Actor, mediaId: string) {
	const image = connection.db.select().from(media).where(eq(media.id, mediaId)).get();
	if (!image || !canReadProduct(connection, actor, image.productId))
		throw new AccessError(404, 'Image not found.');
	return image;
}
export function projectProduct(connection: DatabaseConnection, actor: Actor, productId: string) {
	const fresh = requireMember(connection, actor);
	if (!canReadProduct(connection, fresh, productId)) return null;
	const product = connection.db.select().from(products).where(eq(products.id, productId)).get()!;
	const {
		contributorId,
		deletedAt: _deletedAt,
		deletionToken: _deletionToken,
		...details
	} = product;
	return {
		...details,
		...(fresh.administrator || fresh.collaborator ? { contributorId } : {}),
		entries: visibleEntries(connection, fresh, { productId }),
		offers: publicOffers(connection, product),
		media: connection.db
			.select({ id: media.id, mimeType: media.mimeType, originalName: media.originalName })
			.from(media)
			.where(eq(media.productId, productId))
			.all(),
		labels: connection.db
			.select({ id: labels.id, name: labels.name })
			.from(productLabels)
			.innerJoin(labels, eq(labels.id, productLabels.labelId))
			.where(eq(productLabels.productId, productId))
			.all()
	};
}
export function eligibleListMembers(connection: DatabaseConnection, actor: Actor, listId: string) {
	const administrator = requireAdministrator(connection, actor);
	if (
		!connection.sqlite
			.prepare('SELECT 1 FROM lists WHERE id=? AND archived_at IS NULL AND deleted_at IS NULL')
			.get(listId)
	)
		return [];
	const byId = new Map<string, { id: string; name: string; email: string; role: ListRole }>();
	const superAdmin = connection.sqlite
		.prepare(
			`SELECT u.id,u.name,u.email FROM application_settings s JOIN user u ON u.id=s.administrator_id JOIN account a ON a.user_id=u.id AND a.provider_id='google' AND a.account_id=s.administrator_google_subject WHERE s.id=1 AND u.email_verified=1`
		)
		.get() as { id: string; name: string; email: string } | undefined;
	if (superAdmin) byId.set(superAdmin.id, { ...superAdmin, role: 'contributor' });
	else
		byId.set(administrator.userId, {
			id: administrator.userId,
			name: administrator.name,
			email: administrator.email,
			role: 'contributor'
		});
	const siteWide = connection.sqlite
		.prepare(
			`SELECT u.id,u.name,u.email,m.role AS siteRole FROM household_members m JOIN user u ON u.id=m.user_id JOIN account a ON a.user_id=u.id AND a.provider_id='google' AND a.account_id=m.google_subject WHERE m.role IN ('administrator','collaborator','buyer') AND u.email_verified=1`
		)
		.all() as { id: string; name: string; email: string; siteRole: SiteRole }[];
	for (const person of siteWide)
		if (!byId.has(person.id))
			byId.set(person.id, {
				id: person.id,
				name: person.name,
				email: person.email,
				role: person.siteRole === 'buyer' ? 'buyer' : 'contributor'
			});
	const members = connection.sqlite
		.prepare(
			`SELECT u.id,u.name,u.email,g.role FROM grants g JOIN household_members m ON m.user_id=g.user_id JOIN user u ON u.id=g.user_id JOIN account a ON a.user_id=u.id AND a.provider_id='google' AND a.account_id=m.google_subject WHERE g.list_id=? AND u.email_verified=1`
		)
		.all(listId) as { id: string; name: string; email: string; role: ListRole }[];
	for (const member of members) {
		const existing = byId.get(member.id);
		if (!existing) byId.set(member.id, member);
		else if (existing.role === 'buyer' && member.role === 'contributor')
			byId.set(member.id, { ...existing, role: 'contributor' });
	}
	return [...byId.values()];
}
