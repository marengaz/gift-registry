import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, uniqueIndex, index, check } from 'drizzle-orm/sqlite-core';
const now = sql`(unixepoch() * 1000)`;
export const identificationSettings = sqliteTable(
	'identification_settings',
	{
		id: integer('id').primaryKey().default(1),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
		monthlyLimitMicrodollars: integer('monthly_limit_microdollars').notNull().default(1_000_000),
		unitMicrodollars: integer('unit_microdollars').notNull().default(3500),
		pricingRevision: text('pricing_revision').notNull().default('vision-web-2026-11'),
		updatedAt: integer('updated_at').notNull().default(now)
	},
	(table) => [
		check('identification_singleton', sql`${table.id}=1`),
		check(
			'identification_allowance_valid',
			sql`typeof(${table.monthlyLimitMicrodollars})='integer' AND ${table.monthlyLimitMicrodollars}>=0 AND typeof(${table.unitMicrodollars})='integer' AND ${table.unitMicrodollars}>=3500`
		)
	]
);
export const lookupJobs = sqliteTable(
	'lookup_jobs',
	{
		id: text('id').primaryKey(),
		productId: text('product_id').notNull(),
		actorId: text('actor_id').notNull(),
		actorSessionId: text('actor_session_id').notNull(),
		operationId: text('operation_id').notNull(),
		fingerprint: text('fingerprint').notNull(),
		kind: text('kind', { enum: ['metadata', 'vision', 'attachment'] }).notNull(),
		mediaId: text('media_id'),
		state: text('state', {
			enum: ['queued', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled']
		})
			.notNull()
			.default('queued'),
		startedAt: integer('started_at'),
		leaseUntil: integer('lease_until'),
		dispatchedAt: integer('dispatched_at'),
		finishedAt: integer('finished_at'),
		resultJson: text('result_json'),
		errorText: text('error_text'),
		createdAt: integer('created_at').notNull().default(now)
	},
	(table) => [
		uniqueIndex('lookup_actor_operation_unique').on(table.actorId, table.operationId),
		index('lookup_product_index').on(table.productId),
		index('lookup_state_index').on(table.state)
	]
);
export const allowanceReservations = sqliteTable(
	'allowance_reservations',
	{
		jobId: text('job_id')
			.primaryKey()
			.references(() => lookupJobs.id, { onDelete: 'restrict' }),
		month: text('month').notNull(),
		amountMicrodollars: integer('amount_microdollars').notNull(),
		pricingRevision: text('pricing_revision').notNull(),
		projectId: text('project_id').notNull(),
		createdAt: integer('created_at').notNull().default(now)
	},
	(table) => [
		index('allowance_month_index').on(table.month),
		check(
			'allowance_amount_positive',
			sql`typeof(${table.amountMicrodollars})='integer' AND ${table.amountMicrodollars}>0`
		)
	]
);
