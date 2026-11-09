import { AccessError, canCapture, projectProduct, requireMember } from './access';
import type { CatalogueEvent } from './catalogue';
import type { DatabaseConnection } from './db/client';
import { apiResponse } from './http';

function productUrl(value: string) {
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
		url.hash = '';
		for (const key of [...url.searchParams.keys()])
			if (/^utm_/i.test(key) || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
		url.searchParams.sort();
		return url.href;
	} catch {
		return '';
	}
}
export function captureDuplicates(connection: DatabaseConnection, event: CatalogueEvent) {
	return apiResponse(() => {
		const actor = requireMember(connection, event.locals.actor);
		if (!canCapture(connection, actor)) throw new AccessError(403, 'Contributor access is needed.');
		const source = event.url.searchParams.get('url') ?? '';
		if (source.length > 4000) throw new AccessError(400, 'This link is too long.');
		const normalised = productUrl(source);
		if (!normalised) return { matches: [] };
		const candidates = connection.sqlite
			.prepare(
				'SELECT id,source_url FROM products WHERE source_url IS NOT NULL AND deleted_at IS NULL'
			)
			.all() as { id: string; source_url: string }[];
		const matches: { id: string; title: string }[] = [];
		for (const candidate of candidates) {
			if (productUrl(candidate.source_url) !== normalised) continue;
			const visible = projectProduct(connection, actor, candidate.id);
			if (visible) matches.push({ id: visible.id, title: visible.title });
			if (matches.length === 5) break;
		}
		return { matches };
	});
}
