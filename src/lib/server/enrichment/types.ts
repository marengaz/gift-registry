export type ProductSuggestion = {
	title: string | null;
	description: string | null;
	variant: string | null;
	imageUrl: string | null;
	sourceUrl: string;
	retrievedAt: number;
	source: 'json-ld' | 'open-graph' | 'retailer-page' | 'vision-page';
	offer: {
		url: string;
		retailer: string | null;
		priceMinor: number | null;
		currency: string | null;
		priceText: string | null;
		fromPrice: boolean;
	} | null;
	uncertainty: string[];
};
export type LookupResult = {
	suggestions: ProductSuggestion[];
	labels: string[];
	matchingPages: string[];
	message: string;
};
