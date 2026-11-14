import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch() * 1000)`;
const createdAt = () => integer('created_at').notNull().default(now);

export const recipients = sqliteTable('recipients', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	createdAt: createdAt()
});

export const lists = sqliteTable(
	'lists',
	{
		id: text('id').primaryKey(),
		recipientId: text('recipient_id')
			.notNull()
			.references(() => recipients.id, { onDelete: 'restrict' }),
		name: text('name').notNull(),
		occasion: text('occasion'),
		archivedAt: integer('archived_at'),
		deletedAt: integer('deleted_at'),
		createdAt: createdAt()
	},
	(table) => [
		uniqueIndex('lists_recipient_occasion_unique')
			.on(table.recipientId, table.occasion)
			.where(sql`${table.occasion} IS NOT NULL AND ${table.deletedAt} IS NULL`),
		uniqueIndex('lists_recipient_general_unique')
			.on(table.recipientId)
			.where(sql`${table.occasion} IS NULL AND ${table.deletedAt} IS NULL`),
		check(
			'lists_occasion_not_empty',
			sql`${table.occasion} IS NULL OR length(trim(${table.occasion})) > 0`
		)
	]
);

export const products = sqliteTable(
	'products',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull(),
		description: text('description'),
		variant: text('variant'),
		sourceUrl: text('source_url'),
		sourceText: text('source_text'),
		contributorId: text('contributor_id').notNull(),
		deletedAt: integer('deleted_at'),
		deletionToken: text('deletion_token'),
		createdAt: createdAt(),
		updatedAt: integer('updated_at').notNull().default(now)
	},
	(table) => [index('products_contributor_index').on(table.contributorId)]
);

export const entries = sqliteTable(
	'entries',
	{
		id: text('id').primaryKey(),
		productId: text('product_id')
			.notNull()
			.references(() => products.id, { onDelete: 'restrict' }),
		listId: text('list_id')
			.notNull()
			.references(() => lists.id, { onDelete: 'restrict' }),
		estimatePence: integer('estimate_pence'),
		actualPence: integer('actual_pence'),
		state: text('state', { enum: ['available', 'allocated', 'purchased'] })
			.notNull()
			.default('available'),
		buyerId: text('buyer_id'),
		allocationSource: text('allocation_source', { enum: ['self', 'administrator'] }),
		allocatedById: text('allocated_by_id'),
		allocatedAt: integer('allocated_at'),
		purchasedAt: integer('purchased_at'),
		version: integer('version').notNull().default(0),
		createdAt: createdAt(),
		updatedAt: integer('updated_at').notNull().default(now)
	},
	(table) => [
		uniqueIndex('entries_product_list_unique').on(table.productId, table.listId),
		index('entries_list_index').on(table.listId),
		index('entries_buyer_index').on(table.buyerId),
		check(
			'entries_estimate_integer_pence',
			sql`${table.estimatePence} IS NULL OR (typeof(${table.estimatePence}) = 'integer' AND ${table.estimatePence} >= 0)`
		),
		check(
			'entries_actual_integer_pence',
			sql`${table.actualPence} IS NULL OR (typeof(${table.actualPence}) = 'integer' AND ${table.actualPence} >= 0)`
		),
		check(
			'entries_version_nonnegative',
			sql`typeof(${table.version}) = 'integer' AND ${table.version} >= 0`
		),
		check(
			'entries_allocation_consistent',
			sql`(
    ${table.state} = 'available' AND ${table.buyerId} IS NULL AND ${table.allocationSource} IS NULL AND ${table.allocatedById} IS NULL AND ${table.actualPence} IS NULL
  ) OR (
    ${table.state} IN ('allocated', 'purchased') AND ${table.buyerId} IS NOT NULL AND ${table.allocatedById} IS NOT NULL AND ${table.allocationSource} IS NOT NULL AND ${table.allocationSource} IN ('self', 'administrator') AND (${table.state} = 'purchased' OR ${table.actualPence} IS NULL)
  )`
		)
	]
);

export const labels = sqliteTable('labels', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique()
});
export const productLabels = sqliteTable(
	'product_labels',
	{
		productId: text('product_id')
			.notNull()
			.references(() => products.id, { onDelete: 'cascade' }),
		labelId: text('label_id')
			.notNull()
			.references(() => labels.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.productId, table.labelId] })]
);

export const offers = sqliteTable(
	'offers',
	{
		id: text('id').primaryKey(),
		productId: text('product_id')
			.notNull()
			.references(() => products.id, { onDelete: 'cascade' }),
		url: text('url').notNull(),
		retailer: text('retailer'),
		priceMinor: integer('price_minor'),
		currency: text('currency'),
		observedAt: integer('observed_at').notNull().default(now),
		reverseProvider: text('reverse_provider', { enum: ['vision', 'serpapi'] }),
		reverseJobId: text('reverse_job_id'),
		checkedAt: integer('checked_at'),
		checkedById: text('checked_by_id'),
		checkedFingerprint: text('checked_fingerprint')
	},
	(table) => [
		index('offers_product_index').on(table.productId),
		check(
			'offers_reverse_provider_valid',
			sql`${table.reverseProvider} IS NULL OR ${table.reverseProvider} IN ('vision','serpapi')`
		),
		check(
			'offers_check_consistent',
			sql`(${table.checkedAt} IS NULL AND ${table.checkedById} IS NULL AND ${table.checkedFingerprint} IS NULL) OR (${table.reverseProvider} IS NOT NULL AND typeof(${table.checkedAt}) = 'integer' AND ${table.checkedAt} > 0 AND ${table.checkedById} IS NOT NULL AND ${table.checkedFingerprint} IS NOT NULL)`
		),
		check(
			'offers_price_integer_minor',
			sql`${table.priceMinor} IS NULL OR (typeof(${table.priceMinor}) = 'integer' AND ${table.priceMinor} >= 0 AND ${table.currency} IS NOT NULL)`
		),
		check(
			'offers_currency_code',
			sql`${table.currency} IS NULL OR ${table.currency} GLOB '[A-Z][A-Z][A-Z]'`
		)
	]
);

export const media = sqliteTable(
	'media',
	{
		id: text('id').primaryKey(),
		productId: text('product_id')
			.notNull()
			.references(() => products.id, { onDelete: 'cascade' }),
		storagePath: text('storage_path').notNull().unique(),
		mimeType: text('mime_type').notNull(),
		byteSize: integer('byte_size').notNull(),
		originalName: text('original_name'),
		createdAt: createdAt()
	},
	(table) => [
		index('media_product_index').on(table.productId),
		check(
			'media_size_nonnegative',
			sql`typeof(${table.byteSize}) = 'integer' AND ${table.byteSize} >= 0`
		)
	]
);

export const allocationHistory = sqliteTable(
	'allocation_history',
	{
		id: text('id').primaryKey(),
		entryId: text('entry_id')
			.notNull()
			.references(() => entries.id, { onDelete: 'restrict' }),
		actorId: text('actor_id').notNull(),
		actionId: text('action_id').notNull(),
		action: text('action').notNull(),
		fromState: text('from_state').notNull(),
		toState: text('to_state').notNull(),
		fromBuyerId: text('from_buyer_id'),
		toBuyerId: text('to_buyer_id'),
		resultingVersion: integer('resulting_version').notNull(),
		resultJson: text('result_json').notNull(),
		createdAt: createdAt()
	},
	(table) => [
		uniqueIndex('allocation_actor_action_unique').on(table.actorId, table.actionId),
		index('allocation_entry_index').on(table.entryId)
	]
);

export const captureReceipts = sqliteTable(
	'capture_receipts',
	{
		actorId: text('actor_id').notNull(),
		operationId: text('operation_id').notNull(),
		productId: text('product_id')
			.notNull()
			.references(() => products.id, { onDelete: 'restrict' }),
		resultJson: text('result_json').notNull(),
		createdAt: createdAt()
	},
	(table) => [primaryKey({ columns: [table.actorId, table.operationId] })]
);

export const listDeletionReceipts = sqliteTable(
	'list_deletion_receipts',
	{
		actorId: text('actor_id').notNull(),
		operationId: text('operation_id').notNull(),
		listId: text('list_id')
			.notNull()
			.references(() => lists.id, { onDelete: 'restrict' }),
		fingerprint: text('fingerprint').notNull(),
		resultJson: text('result_json').notNull(),
		createdAt: createdAt()
	},
	(table) => [primaryKey({ columns: [table.actorId, table.operationId] })]
);

export const catalogueActions = sqliteTable(
	'catalogue_actions',
	{
		id: text('id').primaryKey(),
		actorId: text('actor_id').notNull(),
		operationId: text('operation_id').notNull(),
		fingerprint: text('fingerprint').notNull(),
		kind: text('kind', { enum: ['add', 'delete', 'undo'] }).notNull(),
		snapshotsJson: text('snapshots_json').notNull(),
		resultJson: text('result_json').notNull(),
		undoneAt: integer('undone_at'),
		createdAt: createdAt()
	},
	(table) => [
		uniqueIndex('catalogue_actions_actor_operation_unique').on(table.actorId, table.operationId),
		check('catalogue_actions_kind', sql`${table.kind} IN ('add', 'delete', 'undo')`)
	]
);

export const catalogueLatestActions = sqliteTable('catalogue_latest_actions', {
	actorId: text('actor_id').primaryKey(),
	actionId: text('action_id')
		.notNull()
		.references(() => catalogueActions.id, { onDelete: 'restrict' })
});

export {
	identificationSettings,
	lookupJobs,
	allowanceReservations,
	serpapiSearchReservations
} from './enrichment-schema';
