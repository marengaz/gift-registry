import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AccessError } from '../access';
import type { DatabaseConnection } from '../db/client';
import { identificationSettings, allowanceReservations } from '../db/enrichment-schema';
const settingsSchema = z.object({
	enabled: z.boolean(),
	monthlyLimitMicrodollars: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	unitMicrodollars: z.number().int().min(3500).max(Number.MAX_SAFE_INTEGER),
	pricingRevision: z.string().trim().min(1).max(100)
});
export function getIdentificationSettings(connection: DatabaseConnection) {
	connection.db.insert(identificationSettings).values({ id: 1 }).onConflictDoNothing().run();
	return connection.db
		.select()
		.from(identificationSettings)
		.where(eq(identificationSettings.id, 1))
		.get()!;
}
export function updateIdentificationSettings(connection: DatabaseConnection, input: unknown) {
	const value = settingsSchema.safeParse(input);
	if (!value.success)
		throw new AccessError(
			400,
			'Check the USD allowance and conservative unit cost (at least 3500 microdollars).'
		);
	getIdentificationSettings(connection);
	connection.db
		.update(identificationSettings)
		.set({ ...value.data, updatedAt: Date.now() })
		.where(eq(identificationSettings.id, 1))
		.run();
	return getIdentificationSettings(connection);
}
export function allowanceSummary(connection: DatabaseConnection, now = Date.now()) {
	const settings = getIdentificationSettings(connection);
	const month = new Date(now).toISOString().slice(0, 7);
	const visionReservedMicrodollars = connection.db
		.select({ total: sql<number>`coalesce(sum(${allowanceReservations.amountMicrodollars}),0)` })
		.from(allowanceReservations)
		.where(eq(allowanceReservations.month, month))
		.get()!.total;
	const geminiReservedMicrodollars = (
		connection.sqlite
			.prepare(
				'SELECT coalesce(sum(reserved_microdollars),0) AS total FROM gemini_capture_requests WHERE month=?'
			)
			.get(month) as { total: number }
	).total;
	const reservedMicrodollars = visionReservedMicrodollars + geminiReservedMicrodollars;
	return {
		...settings,
		month,
		reservedMicrodollars,
		remainingMicrodollars: Math.max(0, settings.monthlyLimitMicrodollars - reservedMicrodollars)
	};
}
export function reserveAllowance(
	connection: DatabaseConnection,
	jobId: string,
	projectId: string,
	now = Date.now()
) {
	return connection.sqlite
		.transaction(() => {
			const existing = connection.db
				.select()
				.from(allowanceReservations)
				.where(eq(allowanceReservations.jobId, jobId))
				.get();
			if (existing) return existing;
			const summary = allowanceSummary(connection, now);
			if (!summary.enabled)
				throw new AccessError(
					409,
					'Paid identification is disabled. Capture and retailer metadata still work.'
				);
			if (summary.remainingMicrodollars < summary.unitMicrodollars)
				throw new AccessError(
					409,
					'The monthly identification allowance is exhausted. Your idea is safe; enter details manually or try in a later month.'
				);
			const reservation = {
				jobId,
				month: summary.month,
				amountMicrodollars: summary.unitMicrodollars,
				pricingRevision: summary.pricingRevision,
				projectId,
				createdAt: now
			};
			connection.db.insert(allowanceReservations).values(reservation).run();
			return reservation;
		})
		.immediate();
}
