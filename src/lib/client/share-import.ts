import { draftStore } from './drafts';
import { emptyDraft, type CaptureDraft } from '../catalogue-types';

const imageTypes = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
	'image/heic',
	'image/heif'
]);
const imageExtension = /\.(jpe?g|png|webp|avif|heic|heif)$/i;
function webUrl(value: string) {
	for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
		let candidate = match[0].replace(/[.,!?:;]+$/, '');
		for (const [open, close] of [
			['(', ')'],
			['[', ']'],
			['{', '}']
		]) {
			while (
				candidate.endsWith(close) &&
				candidate.split(close).length > candidate.split(open).length
			)
				candidate = candidate.slice(0, -1);
		}
		if (URL.canParse(candidate)) {
			const url = new URL(candidate);
			if (!url.username && !url.password) return url.href;
		}
	}
	return '';
}
export function parseShare(data: FormData): { draft: CaptureDraft; photos: File[] } {
	const text = (key: string) => {
		const value = data.get(key);
		return typeof value === 'string' ? value.trim() : '';
	};
	const title = text('title');
	const body = text('text');
	const url = text('url');
	const photos = data
		.getAll('photos')
		.filter((value): value is File => value instanceof File && value.size > 0);
	for (const photo of photos) {
		if (
			!imageTypes.has(photo.type.toLowerCase()) &&
			!(
				(!photo.type || photo.type === 'application/octet-stream') &&
				imageExtension.test(photo.name)
			)
		)
			throw new Error(
				'This file is not a supported photo. Share JPEG, PNG, WebP, AVIF or HEIC/HEIF, or paste its source link instead.'
			);
		if (photo.size > 12 * 1024 * 1024)
			throw new Error(
				'Each photo must be 12 MB or smaller. Keep the original and share a smaller copy.'
			);
	}
	if (!title && !body && !url && !photos.length)
		throw new Error('The share was empty. Copy the link or choose a photo and try again.');
	const draft = emptyDraft();
	draft.title = title && !webUrl(title) ? title : '';
	draft.sourceUrl = webUrl(url) || webUrl(body) || webUrl(title);
	draft.sourceText = [...new Set([title, body, url].filter(Boolean))].join('\n\n');
	return { draft, photos };
}
export async function importShare(data: FormData, store = draftStore) {
	const value = parseShare(data);
	return store.save({ ownerId: null, ...value, submit: false, incomingShare: true });
}

export function shareRecoveryResponse(message: string, status = 400) {
	const escaped = message.replace(
		/[&<>"']/g,
		(character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
	);
	return new Response(
		`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Share needs attention · Family gifts</title><style>body{font:1rem/1.6 system-ui,sans-serif;background:#f8f6f0;color:#213b43;max-width:38rem;margin:10vh auto;padding:1.5rem}a{color:inherit}h1{line-height:1.2}</style></head><body><main><h1>This share has not been saved</h1><p>${escaped}</p><p>Keep the original photo or link. <a href="/capture">Open Add an idea</a>, paste the link or choose the photo, and save it there.</p><p>To enable direct sharing, first open Family gifts online in Chrome and install it. Let setup finish, then share again.</p></main></body></html>`,
		{
			status,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
				'Content-Security-Policy':
					"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
			}
		}
	);
}
