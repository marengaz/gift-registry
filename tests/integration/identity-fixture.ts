import { createDatabase, migrateDatabase } from '../../src/lib/server/db/client';
import { resolveActor } from '../../src/lib/server/access';

export const bootstrap = { administratorEmail: 'admin@example.test' };
export function fixture() {
	const connection = createDatabase({ filename: ':memory:' });
	migrateDatabase(connection);
	const s = connection.sqlite;
	for (const [id, email] of [
		['admin', 'admin@example.test'],
		['guest', 'guest@example.test'],
		['other', 'other@example.test']
	]) {
		s.prepare(
			'INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,?,?)'
		).run(id, id, email, Date.now(), Date.now());
		s.prepare(
			"INSERT INTO account (id,user_id,account_id,provider_id,created_at,updated_at) VALUES (?,?,?,'google',?,?)"
		).run(id, id, `google-${id}`, Date.now(), Date.now());
		s.prepare(
			'INSERT INTO session (id,user_id,token,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)'
		).run(`session-${id}`, id, `token-${id}`, Date.now() + 3600000, Date.now(), Date.now());
	}
	s.exec(
		"INSERT INTO recipients (id,name) VALUES ('child','Child'); INSERT INTO lists (id,recipient_id,name,occasion) VALUES ('visible','child','Birthday','Birthday'),('secret','child','Christmas','Christmas');"
	);
	const actor = (id: string) => resolveActor(connection, `session-${id}`, bootstrap)!;
	return { connection, actor, admin: actor('admin') };
}
