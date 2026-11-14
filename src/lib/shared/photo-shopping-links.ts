export type LookupProvider = 'vision' | 'serpapi';
export type PhotoShoppingRequest = {
	operationId: string;
	kind: 'vision';
	provider: 'serpapi';
	mediaId: string;
};
export type OfferCheckRequest = {
	checked: boolean;
	reviewedURL: string;
	reviewFingerprint: string;
};
export type OfferReviewStatus = {
	reverseFound?: boolean;
	checked?: boolean;
	checkedAt?: number | null;
	reviewFingerprint?: string;
};
export type SerpApiSearchStatus = {
	configured: boolean;
	used: number;
	limit: number;
	remaining: number;
};
export function canonicalOfferURL(url: string): string {
	return new URL(url).href;
}
export function reviewFingerprint(
	product: { title: string; variant?: string | null },
	url: string
): string {
	return JSON.stringify([product.title, product.variant ?? null, canonicalOfferURL(url)]);
}
