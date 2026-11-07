import collector from './browser-product.js?raw';
import { emptyDraft, parsePriceMinor, priceInput, type CaptureDraft } from '../catalogue-types';
import { draftStore } from './drafts';

const shops: Record<string, string> = {
	'smythstoys.com': 'Smyths',
	'thetoyshop.com': 'The Entertainer',
	'argos.co.uk': 'Argos',
	'currys.co.uk': 'Currys',
	'etsy.com': 'Etsy',
	'hamleys.com': 'Hamleys',
	'lego.com': 'LEGO',
	'theworks.co.uk': 'The Works',
	'johnlewis.com': 'John Lewis'
};
function httpsUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 4000) return '';
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
	} catch {
		return '';
	}
}
export function browserCaptureButton(origin: string): string {
	return `javascript:(${collector.trim()})(${JSON.stringify(new URL('/capture', origin).href)});void 0`;
}
export function parseBrowserCapture(hash: string): CaptureDraft {
	const invalid = () =>
		new Error(
			'This browser capture is invalid. Open the shop product page and choose Save gift again.'
		);
	if (!hash.startsWith('#gift=') || hash.length > 64000) throw invalid();
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(decodeURIComponent(hash.slice(6)));
	} catch {
		throw invalid();
	}
	if (!value || typeof value !== 'object' || value.version !== 1) throw invalid();
	const sourceUrl = httpsUrl(value.sourceUrl);
	const host = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : '';
	const retailer = Object.hasOwn(shops, host) ? shops[host] : '';
	if (
		!sourceUrl ||
		!retailer ||
		typeof value.title !== 'string' ||
		!value.title.trim() ||
		value.title.length > 500
	)
		throw invalid();
	const field = (key: string, maximum: number) =>
		typeof value[key] === 'string' ? (value[key] as string).slice(0, maximum) : '';
	const draft = emptyDraft();
	draft.title = value.title.trim();
	draft.sourceUrl = sourceUrl;
	draft.description = field('description', 4000);
	draft.variant = field('variant', 500);
	const imageUrl = httpsUrl(value.imageUrl);
	const currency =
		typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) ? value.currency : '';
	const priceText = field('priceText', 80);
	const fromPrice = value.fromPrice !== false;
	let priceMinor: number | null = null;
	if (!fromPrice && currency) {
		const plain = currency === 'GBP' ? priceText.replace(/^£\s*/, '') : priceText;
		if (/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(plain)) {
			try {
				priceMinor = parsePriceMinor(plain.replaceAll(',', ''), currency);
			} catch {}
		}
	}
	if (currency)
		draft.offers = [
			{ url: sourceUrl, retailer, currency, price: priceInput(priceMinor, currency) }
		];
	if (currency === 'GBP' && priceMinor !== null) draft.estimate = priceInput(priceMinor, 'GBP');
	const capturedAt = Date.now();
	draft.sourceText = [
		`Captured from your browser at ${sourceUrl} on ${new Date(capturedAt).toISOString()}. Review the exact product, variant and current price before saving.`,
		priceText
			? `Displayed ${fromPrice ? 'from-price or variant range' : 'price'}: ${priceText} ${currency || '(currency missing)'}.`
			: '',
		imageUrl ? `Product photo: ${imageUrl}` : ''
	]
		.filter(Boolean)
		.join('\n');
	draft.browserCapture = { sourceUrl, imageUrl, capturedAt, pendingReview: true };
	return draft;
}
export async function importBrowserCapture(hash: string, store = draftStore) {
	return store.save({ ownerId: null, draft: parseBrowserCapture(hash), photos: [] });
}
