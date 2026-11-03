import sharp from 'sharp';
import { z } from 'zod';
import { AccessError, canCapture, requireMember } from '../access';
import type { CatalogueEvent } from '../catalogue';
import type { DatabaseConnection } from '../db/client';
import { apiResponse, assertSameOrigin, privateJson } from '../http';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../media';
import { publicFetch } from './fetch';
import { extractMetadata } from './metadata';
function contributor(connection: DatabaseConnection, event: CatalogueEvent) {
	const actor = requireMember(connection, event.locals.actor);
	if (!canCapture(connection, actor))
		throw new AccessError(403, 'Contributor permission is needed to read product metadata.');
	return actor;
}
export function metadataPreview(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	fetchPage: typeof publicFetch = publicFetch
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		contributor(connection, event);
		const parsed = z.object({ url: z.url() }).safeParse(await event.request.json());
		if (!parsed.success) throw new AccessError(400, 'Paste a product source link.');
		try {
			const page = await fetchPage(parsed.data.url);
			contributor(connection, event);
			if (
				!String(page.headers['content-type'] ?? '')
					.toLowerCase()
					.includes('text/html')
			)
				throw new Error('No page metadata');
			return {
				suggestions: extractMetadata(page.body.toString('utf8'), page.url),
				message: 'Review the imported details. Retailer prices and variants may change.'
			};
		} catch (error) {
			if (error instanceof AccessError) throw error;
			return {
				suggestions: [],
				message:
					'This source could not be read. Keep its link and add a screenshot or enter the details manually.'
			};
		}
	});
}
export async function metadataImage(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	fetchPage: typeof publicFetch = publicFetch
) {
	let response: Response | undefined;
	const failure = await apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		contributor(connection, event);
		const parsed = z.object({ url: z.url() }).safeParse(await event.request.json());
		if (!parsed.success) throw new AccessError(400, 'Choose a product image link.');
		try {
			const image = await fetchPage(parsed.data.url, { maxBytes: MAX_IMAGE_BYTES });
			const decoder = sharp(image.body, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false });
			const metadata = await decoder.metadata();
			if (!['jpeg', 'png', 'webp', 'gif', 'heif', 'avif', 'tiff'].includes(metadata.format ?? ''))
				throw new Error('Unsupported image');
			const bytes = await decoder
				.rotate()
				.resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
				.webp({ quality: 85 })
				.toBuffer();
			contributor(connection, event);
			response = new Response(new Uint8Array(bytes), {
				headers: {
					'Content-Type': 'image/webp',
					'Cache-Control': 'private, no-store',
					Vary: 'Cookie',
					'X-Content-Type-Options': 'nosniff'
				}
			});
			return {};
		} catch (error) {
			if (error instanceof AccessError) throw error;
			throw new AccessError(
				400,
				'The product picture could not be imported. Add your own photo or screenshot.'
			);
		}
	});
	return response ?? failure;
}
