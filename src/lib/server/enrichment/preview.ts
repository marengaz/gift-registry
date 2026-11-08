import sharp from 'sharp';
import { z } from 'zod';
import { AccessError, canCapture, requireMember } from '../access';
import type { CatalogueEvent } from '../catalogue';
import type { DatabaseConnection } from '../db/client';
import { apiResponse, assertSameOrigin } from '../http';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../media';
import { publicFetch, PublicFetchError } from './fetch';
import { extractMetadata } from './metadata';
import { accessiblePageEvidence } from './gemini-evidence';
import { getGeminiStatus, runGeminiExtraction, type GeminiDependencies } from './gemini';
import type { ProductSuggestion } from './types';
function contributor(connection: DatabaseConnection, event: CatalogueEvent) {
	const actor = requireMember(connection, event.locals.actor);
	if (!canCapture(connection, actor))
		throw new AccessError(403, 'Contributor permission is needed to read product metadata.');
	return actor;
}
export function metadataPreview(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	fetchPage: typeof publicFetch = publicFetch,
	dependencies: GeminiDependencies = {}
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		contributor(connection, event);
		const parsed = z
			.object({ url: z.url(), assist: z.boolean().optional(), operationId: z.uuid().optional() })
			.safeParse(await event.request.json());
		if (!parsed.success) throw new AccessError(400, 'Paste a product source link.');
		if (parsed.data.assist && !parsed.data.operationId)
			throw new AccessError(400, 'Start a new details request.');
		try {
			const page = await fetchPage(parsed.data.url);
			contributor(connection, event);
			if (page.status < 200 || page.status >= 300)
				throw new PublicFetchError(`This shop could not provide the page (HTTP ${page.status}).`);
			if (
				!String(page.headers['content-type'] ?? '')
					.toLowerCase()
					.includes('text/html')
			)
				throw new Error('No page metadata');
			const html = page.body.toString('utf8');
			const evidence = accessiblePageEvidence(html, page.url);
			if (evidence.blocked)
				return {
					suggestions: [],
					blocked: true,
					message:
						'We could not read this shop page. Your link is kept. Add a screenshot or save the idea as it is.'
				};
			let suggestions = extractMetadata(html, page.url);
			let aiMessage = '';
			let aiAvailable = false;
			let aiUnavailable = false;
			if (parsed.data.assist) {
				const status = getGeminiStatus(connection, dependencies.environment);
				aiAvailable =
					status.configured &&
					status.enabled &&
					status.remainingMicrodollars >= status.reservationMicrodollars;
				if (suggestions.length > 1)
					return {
						suggestions: [],
						ambiguity: true,
						aiAvailable,
						message:
							'Several products are shown. Add a screenshot of the item you want, or enter its details.'
					};
				const first = suggestions[0];
				const complete =
					first?.title &&
					first.description &&
					first.imageUrl &&
					first.offer?.priceMinor != null &&
					first.offer.currency &&
					!first.offer.fromPrice &&
					!first.uncertainty.some((value) => /several|missing|could not/.test(value));
				if (!complete && evidence.useful && aiAvailable) {
					try {
						const result = await runGeminiExtraction(
							connection,
							event.locals.actor,
							{
								operationId: parsed.data.operationId!,
								kind: 'page',
								text: html,
								sourceUrl: page.url
							},
							dependencies
						);
						if (result.ambiguity) return { ...result, aiAvailable };
						const addition = result.suggestions[0];
						if (addition) {
							const merged: ProductSuggestion = first
								? {
										...addition,
										title: first.title || addition.title,
										description: first.description || addition.description,
										variant: first.variant || addition.variant,
										imageUrl: first.imageUrl || addition.imageUrl,
										offer:
											first.offer?.priceMinor != null || first.offer?.fromPrice
												? first.offer
												: addition.offer || first.offer,
										uncertainty: [...new Set([...first.uncertainty, ...addition.uncertainty])]
									}
								: addition;
							suggestions = [merged];
						}
						aiMessage = result.message;
						aiUnavailable = !!result.failure;
					} catch (error) {
						if (error instanceof AccessError && (error.status === 401 || error.status === 403))
							throw error;
						aiMessage =
							'AI details are unavailable. Keep the imported details, add a screenshot or enter anything you know.';
						aiUnavailable = true;
					}
				} else if (!complete && !aiAvailable) {
					aiMessage = !status.configured
						? 'AI details are not configured; available shop details were kept.'
						: !status.enabled
							? 'AI details are disabled; available shop details were kept.'
							: 'The AI allowance is exhausted; available shop details were kept.';
				}
			}
			return {
				suggestions,
				aiAvailable,
				aiUnavailable,
				message:
					aiMessage ||
					(suggestions.length
						? 'Review the imported details. Retailer prices and variants may change.'
						: 'No product details were found on this page. You can still save the link and fill in anything you know.')
			};
		} catch (error) {
			if (error instanceof AccessError) throw error;
			return {
				suggestions: [],
				blocked: /HTTP (401|403|429)|access denied|captcha|block automatic/i.test(
					error instanceof Error ? error.message : ''
				),
				message: `${error instanceof PublicFetchError ? error.message : 'This shop could not be reached.'} You can still save the link, add a photo or screenshot, or enter details yourself.`
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
