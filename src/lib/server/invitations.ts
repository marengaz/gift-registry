import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseConnection } from './db/client';
import {
	AccessError,
	normaliseEmail,
	requireAdministrator,
	requireAuthenticated,
	type Actor,
	type ListRole,
	type SiteRole
} from './access';
export type ListGrant = { listId: string; role: ListRole };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function normaliseListRole(role: string): ListRole {
	if (role === 'collaborator' || role === 'contributor') return 'contributor';
	if (role === 'buyer') return 'buyer';
	if (role === 'viewer') return 'viewer';
	throw new AccessError(400, 'Choose a valid list permission.');
}
export function validateSiteRole(role: unknown): SiteRole {
	if (role === 'administrator' || role === 'collaborator' || role === 'buyer' || role === 'guest')
		return role;
	throw new AccessError(400, 'Choose a valid site permission.');
}
function validateGrants(
	connection: DatabaseConnection,
	grants: { listId: string; role: string }[]
): ListGrant[] {
	if (!Array.isArray(grants)) throw new AccessError(400, 'Choose list permissions.');
	const seen = new Set<string>();
	const normalised: ListGrant[] = [];
	for (const grant of grants) {
		let role: ListRole | null = null;
		try {
			role = grant ? normaliseListRole(grant.role) : null;
		} catch {
			role = null;
		}
		if (
			!grant ||
			!role ||
			seen.has(grant.listId) ||
			!connection.sqlite
				.prepare('SELECT 1 FROM lists WHERE id=? AND archived_at IS NULL AND deleted_at IS NULL')
				.get(grant.listId)
		)
			throw new AccessError(400, 'Choose each active list once with a valid role.');
		seen.add(grant.listId);
		normalised.push({ listId: grant.listId, role });
	}
	return normalised;
}
function superAdministratorId(connection: DatabaseConnection): string | null {
	const row = connection.sqlite
		.prepare('SELECT administrator_id AS id FROM application_settings WHERE id=1')
		.get() as { id: string } | undefined;
	return row?.id ?? null;
}
function ensureHouseholdMember(connection: DatabaseConnection, userId: string) {
	if (connection.sqlite.prepare('SELECT 1 FROM household_members WHERE user_id=?').get(userId))
		return;
	const identity = connection.sqlite
		.prepare(
			`SELECT a.account_id AS googleSubject FROM user u JOIN account a ON a.user_id=u.id AND a.provider_id='google' WHERE u.id=? AND u.email_verified=1`
		)
		.get(userId) as { googleSubject: string } | undefined;
	if (!identity) throw new AccessError(400, 'Choose a person who has signed in with Google.');
	connection.sqlite
		.prepare(
			"INSERT INTO household_members (user_id,google_subject,accepted_at,role) VALUES (?,?,?,'guest') ON CONFLICT(user_id) DO NOTHING"
		)
		.run(userId, identity.googleSubject, Date.now());
}
function cleanupRedundantGrants(connection: DatabaseConnection, userId: string, role: SiteRole) {
	if (role === 'administrator' || role === 'collaborator')
		connection.sqlite.prepare('DELETE FROM grants WHERE user_id=?').run(userId);
	else if (role === 'buyer')
		connection.sqlite
			.prepare("DELETE FROM grants WHERE user_id=? AND role IN ('buyer','viewer')")
			.run(userId);
}
export function createInvitation(
	connection: DatabaseConnection,
	actor: Actor,
	input: { email: string; role?: SiteRole; grants: { listId: string; role: string }[] }
) {
	requireAdministrator(connection, actor);
	const email = normaliseEmail(input.email);
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		throw new AccessError(400, 'Enter an email address.');
	const role = validateSiteRole(input.role ?? 'guest');
	const validatedGrants = validateGrants(connection, input.grants);
	const grants =
		role === 'administrator' || role === 'collaborator'
			? []
			: role === 'buyer'
				? validatedGrants.filter((item) => item.role === 'contributor')
				: validatedGrants;
	const token = randomBytes(32).toString('base64url');
	const id = randomUUID();
	const expiresAt = Date.now() + 7 * 24 * 3600000;
	connection.sqlite
		.prepare(
			'INSERT INTO invitations (id,token_hash,email,role,grants_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?)'
		)
		.run(id, digest(token), email, role, JSON.stringify(grants), expiresAt, Date.now());
	return { id, token, expiresAt };
}
export function acceptInvitation(connection: DatabaseConnection, actor: Actor, token: string) {
	return connection.sqlite
		.transaction(() => {
			const fresh = requireAuthenticated(connection, actor);
			const invitation = connection.sqlite
				.prepare(
					'SELECT * FROM invitations WHERE token_hash=? AND accepted_at IS NULL AND expires_at>?'
				)
				.get(digest(token), Date.now()) as
				{ id: string; email: string; role: SiteRole; grants_json: string } | undefined;
			if (!invitation || normaliseEmail(fresh.email) !== invitation.email)
				throw new AccessError(
					403,
					'This invitation is unavailable or belongs to a different Google email.'
				);
			if (fresh.superAdministrator)
				throw new AccessError(400, 'The super administrator already has access.');
			const siteRole = validateSiteRole(invitation.role ?? 'guest');
			const grants = validateGrants(
				connection,
				JSON.parse(invitation.grants_json) as { listId: string; role: string }[]
			);
			connection.sqlite
				.prepare(
					'INSERT INTO household_members (user_id,google_subject,accepted_at,role) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role'
				)
				.run(fresh.userId, fresh.googleSubject, Date.now(), siteRole);
			for (const grant of grants)
				connection.sqlite
					.prepare(
						'INSERT INTO grants (user_id,list_id,role) VALUES (?,?,?) ON CONFLICT(user_id,list_id) DO UPDATE SET role=excluded.role'
					)
					.run(fresh.userId, grant.listId, grant.role);
			cleanupRedundantGrants(connection, fresh.userId, siteRole);
			connection.sqlite
				.prepare('UPDATE invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL')
				.run(Date.now(), invitation.id);
			return { accepted: true };
		})
		.immediate();
}
export function setSiteRole(
	connection: DatabaseConnection,
	actor: Actor,
	userId: string,
	role: SiteRole
) {
	const admin = requireAdministrator(connection, actor);
	const nextRole = validateSiteRole(role);
	if (userId === superAdministratorId(connection))
		throw new AccessError(400, 'The super administrator permission cannot be changed.');
	if (userId === admin.userId && nextRole !== 'administrator')
		throw new AccessError(400, 'You cannot remove your own administrator access.');
	connection.sqlite
		.transaction(() => {
			ensureHouseholdMember(connection, userId);
			connection.sqlite
				.prepare('UPDATE household_members SET role=? WHERE user_id=?')
				.run(nextRole, userId);
			cleanupRedundantGrants(connection, userId, nextRole);
		})
		.immediate();
}
export function setGrant(
	connection: DatabaseConnection,
	actor: Actor,
	userId: string,
	grant: { listId: string; role: string | null }
) {
	requireAdministrator(connection, actor);
	if (userId === superAdministratorId(connection))
		throw new AccessError(400, 'The super administrator already has access to all lists.');
	connection.sqlite
		.transaction(() => {
			ensureHouseholdMember(connection, userId);
			if (grant.role === null)
				connection.sqlite
					.prepare('DELETE FROM grants WHERE user_id=? AND list_id=?')
					.run(userId, grant.listId);
			else {
				const [validated] = validateGrants(connection, [
					{ listId: grant.listId, role: grant.role }
				]);
				connection.sqlite
					.prepare(
						'INSERT INTO grants (user_id,list_id,role) VALUES (?,?,?) ON CONFLICT(user_id,list_id) DO UPDATE SET role=excluded.role'
					)
					.run(userId, validated.listId, validated.role);
			}
		})
		.immediate();
}
export function revokeMember(connection: DatabaseConnection, actor: Actor, userId: string) {
	const admin = requireAdministrator(connection, actor);
	if (userId === superAdministratorId(connection))
		throw new AccessError(400, 'The super administrator cannot be revoked.');
	if (userId === admin.userId) throw new AccessError(400, 'You cannot revoke your own membership.');
	connection.sqlite
		.transaction(() => {
			connection.sqlite.prepare('DELETE FROM household_members WHERE user_id=?').run(userId);
			connection.sqlite.prepare('DELETE FROM session WHERE user_id=?').run(userId);
			const person = connection.sqlite.prepare('SELECT email FROM user WHERE id=?').get(userId) as
				{ email: string } | undefined;
			if (person)
				connection.sqlite
					.prepare('DELETE FROM invitations WHERE email=? AND accepted_at IS NULL')
					.run(normaliseEmail(person.email));
		})
		.immediate();
}
export function revokeInvitation(connection: DatabaseConnection, actor: Actor, id: string) {
	requireAdministrator(connection, actor);
	connection.sqlite.prepare('DELETE FROM invitations WHERE id=? AND accepted_at IS NULL').run(id);
}
export function peopleSettings(connection: DatabaseConnection, actor: Actor) {
	requireAdministrator(connection, actor);
	const superAdministrator =
		(connection.sqlite
			.prepare(
				'SELECT u.id,u.name,u.email FROM application_settings s JOIN user u ON u.id=s.administrator_id WHERE s.id=1'
			)
			.get() as { id: string; name: string; email: string } | undefined) ?? null;
	const people = (
		connection.sqlite
			.prepare(
				`SELECT u.id,u.name,u.email,COALESCE(m.role,'guest') AS role,CASE WHEN m.user_id IS NULL THEN 0 ELSE 1 END AS member
 FROM user u
 JOIN account a ON a.user_id=u.id AND a.provider_id='google'
 LEFT JOIN household_members m ON m.user_id=u.id
 LEFT JOIN application_settings s ON s.id=1
 WHERE u.email_verified=1 AND (s.administrator_id IS NULL OR u.id!=s.administrator_id)
 ORDER BY u.name`
			)
			.all() as { id: string; name: string; email: string; role: SiteRole; member: number }[]
	).map((person) => ({ ...person, member: Boolean(person.member) }));
	return {
		superAdministrator,
		people,
		grants: connection.sqlite
			.prepare(
				'SELECT g.user_id AS userId,g.list_id AS listId,g.role FROM grants g JOIN lists l ON l.id=g.list_id WHERE l.deleted_at IS NULL'
			)
			.all() as { userId: string; listId: string; role: ListRole }[],
		invitations: connection.sqlite
			.prepare(
				'SELECT id,email,role,expires_at AS expiresAt FROM invitations WHERE accepted_at IS NULL AND expires_at>? ORDER BY created_at DESC'
			)
			.all(Date.now()) as { id: string; email: string; role: SiteRole; expiresAt: number }[]
	};
}
