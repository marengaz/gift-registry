import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseConnection } from './db/client';
import {
	AccessError,
	normaliseEmail,
	requireAdministrator,
	requireAuthenticated,
	type Actor,
	type ListRole
} from './access';
export type ListGrant = { listId: string; role: ListRole };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
function validateGrants(connection: DatabaseConnection, grants: ListGrant[]) {
	if (!Array.isArray(grants)) throw new AccessError(400, 'Choose list permissions.');
	const seen = new Set<string>();
	for (const grant of grants) {
		if (
			!grant ||
			!['contributor', 'buyer', 'viewer'].includes(grant.role) ||
			seen.has(grant.listId) ||
			!connection.sqlite
				.prepare('SELECT 1 FROM lists WHERE id=? AND archived_at IS NULL AND deleted_at IS NULL')
				.get(grant.listId)
		)
			throw new AccessError(400, 'Choose each active list once with a valid role.');
		seen.add(grant.listId);
	}
}
export function createInvitation(
	connection: DatabaseConnection,
	actor: Actor,
	input: { email: string; grants: ListGrant[] }
) {
	requireAdministrator(connection, actor);
	const email = normaliseEmail(input.email);
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		throw new AccessError(400, 'Enter an email address.');
	validateGrants(connection, input.grants);
	const token = randomBytes(32).toString('base64url');
	const id = randomUUID();
	const expiresAt = Date.now() + 7 * 24 * 3600000;
	connection.sqlite
		.prepare(
			'INSERT INTO invitations (id,token_hash,email,grants_json,expires_at,created_at) VALUES (?,?,?,?,?,?)'
		)
		.run(id, digest(token), email, JSON.stringify(input.grants), expiresAt, Date.now());
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
				{ id: string; email: string; grants_json: string } | undefined;
			if (!invitation || normaliseEmail(fresh.email) !== invitation.email)
				throw new AccessError(
					403,
					'This invitation is unavailable or belongs to a different Google email.'
				);
			if (fresh.administrator) throw new AccessError(400, 'The administrator already has access.');
			const grants = JSON.parse(invitation.grants_json) as ListGrant[];
			validateGrants(connection, grants);
			connection.sqlite
				.prepare(
					'INSERT INTO household_members (user_id,google_subject,accepted_at) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING'
				)
				.run(fresh.userId, fresh.googleSubject, Date.now());
			for (const grant of grants)
				connection.sqlite
					.prepare(
						'INSERT INTO grants (user_id,list_id,role) VALUES (?,?,?) ON CONFLICT(user_id,list_id) DO UPDATE SET role=excluded.role'
					)
					.run(fresh.userId, grant.listId, grant.role);
			connection.sqlite
				.prepare('UPDATE invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL')
				.run(Date.now(), invitation.id);
			return { accepted: true };
		})
		.immediate();
}
export function setGrant(
	connection: DatabaseConnection,
	actor: Actor,
	userId: string,
	grant: { listId: string; role: ListRole | null }
) {
	requireAdministrator(connection, actor);
	if (!connection.sqlite.prepare('SELECT 1 FROM household_members WHERE user_id=?').get(userId))
		throw new AccessError(400, 'Choose an invited person who has signed in.');
	if (grant.role === null)
		connection.sqlite
			.prepare('DELETE FROM grants WHERE user_id=? AND list_id=?')
			.run(userId, grant.listId);
	else {
		validateGrants(connection, [{ listId: grant.listId, role: grant.role }]);
		connection.sqlite
			.prepare(
				'INSERT INTO grants (user_id,list_id,role) VALUES (?,?,?) ON CONFLICT(user_id,list_id) DO UPDATE SET role=excluded.role'
			)
			.run(userId, grant.listId, grant.role);
	}
}
export function revokeMember(connection: DatabaseConnection, actor: Actor, userId: string) {
	const admin = requireAdministrator(connection, actor);
	if (userId === admin.userId)
		throw new AccessError(400, 'The sole administrator cannot be revoked.');
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
	return {
		people: connection.sqlite
			.prepare(
				'SELECT u.id,u.name,u.email FROM household_members m JOIN user u ON u.id=m.user_id ORDER BY u.name'
			)
			.all() as { id: string; name: string; email: string }[],
		grants: connection.sqlite
			.prepare(
				'SELECT g.user_id AS userId,g.list_id AS listId,g.role FROM grants g JOIN lists l ON l.id=g.list_id WHERE l.deleted_at IS NULL'
			)
			.all() as { userId: string; listId: string; role: ListRole }[],
		invitations: connection.sqlite
			.prepare(
				'SELECT id,email,expires_at AS expiresAt FROM invitations WHERE accepted_at IS NULL AND expires_at>? ORDER BY created_at DESC'
			)
			.all(Date.now()) as { id: string; email: string; expiresAt: number }[]
	};
}
