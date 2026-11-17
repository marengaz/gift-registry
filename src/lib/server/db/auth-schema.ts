import { integer, sqliteTable, text, primaryKey, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { lists } from './schema';

export const user = sqliteTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
	image: text('image'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});
export const session = sqliteTable('session', {
	id: text('id').primaryKey(),
	token: text('token').notNull().unique(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent')
});
export const account = sqliteTable('account', {
	id: text('id').primaryKey(),
	accountId: text('account_id').notNull(),
	providerId: text('provider_id').notNull(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	idToken: text('id_token'),
	accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
	refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
	scope: text('scope'),
	password: text('password'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});
export const verification = sqliteTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});
export const applicationSettings = sqliteTable(
	'application_settings',
	{
		id: integer('id').primaryKey(),
		administratorId: text('administrator_id')
			.notNull()
			.unique()
			.references(() => user.id),
		administratorGoogleSubject: text('administrator_google_subject').notNull().unique()
	},
	(table) => [check('application_settings_singleton', sql`${table.id} = 1`)]
);
export const householdMembers = sqliteTable(
	'household_members',
	{
		userId: text('user_id')
			.primaryKey()
			.references(() => user.id, { onDelete: 'cascade' }),
		googleSubject: text('google_subject').notNull().unique(),
		acceptedAt: integer('accepted_at').notNull(),
		role: text('role', { enum: ['administrator', 'collaborator', 'buyer', 'guest'] })
			.notNull()
			.default('guest')
	},
	(table) => [
		check(
			'household_members_role',
			sql`${table.role} IN ('administrator','collaborator','buyer','guest')`
		)
	]
);
export const grants = sqliteTable(
	'grants',
	{
		userId: text('user_id')
			.notNull()
			.references(() => householdMembers.userId, { onDelete: 'cascade' }),
		listId: text('list_id')
			.notNull()
			.references(() => lists.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['contributor', 'buyer', 'viewer'] }).notNull()
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.listId] }),
		check('grants_role', sql`${table.role} IN ('contributor','buyer','viewer')`)
	]
);
export const invitations = sqliteTable(
	'invitations',
	{
		id: text('id').primaryKey(),
		tokenHash: text('token_hash').notNull().unique(),
		email: text('email').notNull(),
		role: text('role', { enum: ['administrator', 'collaborator', 'buyer', 'guest'] })
			.notNull()
			.default('guest'),
		grantsJson: text('grants_json').notNull(),
		expiresAt: integer('expires_at').notNull(),
		acceptedAt: integer('accepted_at'),
		createdAt: integer('created_at').notNull()
	},
	(table) => [
		check(
			'invitations_role',
			sql`${table.role} IN ('administrator','collaborator','buyer','guest')`
		)
	]
);
