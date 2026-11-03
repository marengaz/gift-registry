import { requireAdministrator } from '../access';
import type { CatalogueEvent } from '../catalogue';
import type { DatabaseConnection } from '../db/client';
import { apiResponse, assertSameOrigin } from '../http';
import { allowanceSummary, updateIdentificationSettings } from './allowance';
import { visionConfiguration } from './vision';
export function identificationGet(connection: DatabaseConnection, event: CatalogueEvent) {
	return apiResponse(() => {
		requireAdministrator(connection, event.locals.actor);
		return { ...allowanceSummary(connection), provider: visionConfiguration() };
	});
}
export function identificationPost(connection: DatabaseConnection, event: CatalogueEvent) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		const input = await event.request.json();
		return connection.sqlite
			.transaction(() => {
				requireAdministrator(connection, event.locals.actor);
				updateIdentificationSettings(connection, input);
				return { ...allowanceSummary(connection), provider: visionConfiguration() };
			})
			.immediate();
	});
}
