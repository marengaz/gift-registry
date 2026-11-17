import type { OfferReviewStatus } from './shared/photo-shopping-links';
import type { projectProduct, visibleLists } from './server/access';
export type Product = NonNullable<ReturnType<typeof projectProduct>> & {
	contributorName?: string;
	hasHiddenEntries?: boolean;
};
export type GiftList = ReturnType<typeof visibleLists>[number];
export type SiteRole = 'administrator' | 'collaborator' | 'buyer' | 'guest';
export type Identity = {
	id: string;
	name: string;
	email: string;
	member: boolean;
	siteRole: SiteRole;
	superAdministrator: boolean;
	administrator: boolean;
	collaborator: boolean;
	buyer: boolean;
	canCapture: boolean;
	lists: GiftList[];
};
export type ShoppingDraft = OfferReviewStatus & {
	id?: string;
	url: string;
	retailer: string;
	price: string;
	currency: string;
};
export type CaptureEditedField =
	'title' | 'description' | 'variant' | 'estimate' | 'offers' | 'photos';
export type CaptureDraft = {
	title: string;
	description: string;
	variant: string;
	sourceUrl: string;
	sourceText: string;
	listIds: string[];
	estimate: string;
	entryEstimates: Record<string, string>;
	labels: string;
	offers: ShoppingDraft[];
	editedFields?: CaptureEditedField[];
	browserCapture?: {
		sourceUrl: string;
		imageUrl: string;
		capturedAt: number;
		pendingReview: boolean;
	};
};
export const emptyDraft = (): CaptureDraft => ({
	title: '',
	description: '',
	variant: '',
	sourceUrl: '',
	sourceText: '',
	listIds: [],
	estimate: '',
	entryEstimates: {},
	labels: '',
	offers: []
});
export function draftFromProduct(product: Product): CaptureDraft {
	return {
		title: product.title,
		description: product.description ?? '',
		variant: product.variant ?? '',
		sourceUrl: product.sourceUrl ?? '',
		sourceText: product.sourceText ?? '',
		listIds: product.entries.map((e) => e.listId),
		estimate: '',
		entryEstimates: Object.fromEntries(
			product.entries.map((e) => [e.listId, priceInput(e.estimatePence, 'GBP')])
		),
		labels: product.labels.map((l) => l.name).join(', '),
		offers: product.offers.map((o) => ({
			id: o.id,
			reverseFound: o.reverseFound,
			checked: o.checked,
			checkedAt: o.checkedAt,
			reviewFingerprint: o.reviewFingerprint,
			url: o.url,
			retailer: o.retailer ?? '',
			price: priceInput(o.priceMinor, o.currency ?? 'GBP'),
			currency: o.currency ?? 'GBP'
		}))
	};
}
export function currencyDigits(currency: string): number {
	if (!/^[A-Z]{3}$/.test(currency))
		throw new Error('Use a three-letter currency code, such as GBP.');
	return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).resolvedOptions()
		.maximumFractionDigits!;
}
export function parsePriceMinor(value: string, currency: string): number | null {
	if (!value.trim()) return null;
	const digits = currencyDigits(currency);
	const pattern = digits ? new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`) : /^\d+$/;
	if (!pattern.test(value))
		throw new Error(
			`Use up to ${digits} decimal places for ${currency}, or leave the price unknown.`
		);
	const [whole, part = ''] = value.split('.');
	const amount = Number(whole) * 10 ** digits + Number(part.padEnd(digits, '0'));
	if (!Number.isSafeInteger(amount)) throw new Error('This price is too large.');
	return amount;
}
export function priceInput(value: number | null | undefined, currency: string): string {
	return value == null
		? ''
		: (value / 10 ** currencyDigits(currency)).toFixed(currencyDigits(currency));
}
export function formatPrice(value: number, currency: string): string {
	return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(
		value / 10 ** currencyDigits(currency)
	);
}
export const pence = (value: string) => parsePriceMinor(value, 'GBP');
export function captureTitle(draft: CaptureDraft): string {
	if (draft.title.trim()) return draft.title.trim();
	if (draft.sourceUrl && URL.canParse(draft.sourceUrl))
		return 'Idea from ' + new URL(draft.sourceUrl).hostname.replace(/^www\./, '');
	return (
		(draft.description.trim() || draft.sourceText.trim()).split('\n')[0].slice(0, 120) ||
		'Untitled idea'
	);
}
export function capturePayload(draft: CaptureDraft) {
	return {
		title: captureTitle(draft),
		description: draft.description,
		variant: draft.variant,
		sourceUrl: draft.sourceUrl,
		sourceText: draft.sourceText,
		listIds: draft.listIds,
		estimatePence: pence(draft.estimate),
		entryEstimates: Object.fromEntries(
			Object.entries(draft.entryEstimates).map(([id, value]) => [id, pence(value)])
		),
		labels: draft.labels
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean),
		offers: draft.offers
			.filter((o) => o.url.trim())
			.map((o) => ({
				...(o.id ? { id: o.id } : {}),
				url: o.url,
				retailer: o.retailer,
				priceMinor: parsePriceMinor(o.price, o.currency),
				currency: o.currency
			}))
	};
}
export const money = (value: number | null | undefined) =>
	value == null ? 'Price unknown' : formatPrice(value, 'GBP');

export type GiftEntry = Product['entries'][number];
export type AssignmentMember = {
	id: string;
	name: string;
	email: string;
	role: 'contributor' | 'buyer' | 'viewer';
};

export type AllocationRecord = {
	action: string;
	createdAt: number;
	fromState: string;
	toState: string;
	resultingVersion: number;
};
