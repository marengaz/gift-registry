import { describe, expect, it } from 'vitest';
import {
	accessiblePageEvidence,
	suggestionFromExtraction
} from '../../src/lib/server/enrichment/gemini-evidence';

const product = {
	title: 'Wooden train',
	description: 'A toy train.',
	variant: null,
	price: '12.50',
	currency: 'GBP',
	priceKind: 'exact',
	priceEvidence: '£12.50',
	imageIndex: null,
	ambiguous: false,
	suggested: false,
	uncertainty: []
};
const evidence = {
	kind: 'text' as const,
	text: 'Wooden train £12.50',
	sourceUrl: 'https://shop.example/train',
	imageUrls: ['https://images.example/train.webp']
};
describe('model output remains evidence, not authority', () => {
	it('requires a matching currency-attached amount rather than a numeric substring', () => {
		expect(
			suggestionFromExtraction({ ...product, price: '2.50' }, evidence).suggestions[0].offer
				?.priceMinor
		).toBeNull();
		expect(suggestionFromExtraction(product, evidence).suggestions[0].offer?.priceMinor).toBe(1250);
		expect(
			suggestionFromExtraction(
				{ ...product, currency: 'EUR', priceEvidence: '€12.50' },
				{ ...evidence, text: 'Train €12.50' }
			).suggestions[0].offer
		).toMatchObject({ priceMinor: 1250, currency: 'EUR' });
		expect(
			suggestionFromExtraction(
				{ ...product, price: '0', priceEvidence: '£0.00' },
				{ ...evidence, text: 'Gift £0.00' }
			).suggestions[0].offer?.priceMinor
		).toBe(0);
	});
	it('does not make an exact estimate from RRP, instalments or a range even when the model calls it exact', () => {
		for (const quote of ['RRP £12.50', '£12.50 per month', '£12.50–£25.00', 'From £12.50']) {
			const result = suggestionFromExtraction(
				{ ...product, priceEvidence: quote },
				{ ...evidence, text: quote }
			);
			expect(result.suggestions[0].offer?.priceMinor).toBeNull();
		}
	});
	it('accepts only bounded valid output and an index into observed image candidates', () => {
		expect(
			suggestionFromExtraction({ ...product, buyingUrl: 'https://invented.example/' }, evidence)
				.suggestions
		).toEqual([]);
		expect(
			suggestionFromExtraction({ ...product, imageIndex: 1 }, evidence).suggestions[0].imageUrl
		).toBeNull();
		expect(
			suggestionFromExtraction({ ...product, imageIndex: 0 }, evidence).suggestions[0].imageUrl
		).toBe(evidence.imageUrls[0]);
		expect(
			suggestionFromExtraction({ ...product, title: 'x'.repeat(501) }, evidence).suggestions
		).toEqual([]);
	});
	it('keeps product evidence while excluding account forms and unrelated navigation', () => {
		const result = accessiblePageEvidence(
			'<h1>Wooden train</h1><nav>Account</nav><main>Train £12.50<form>Private account note<input value="password"></form></main><script>cookie</script>',
			evidence.sourceUrl
		);
		expect(result).toMatchObject({ text: 'Train £12.50', useful: true, blocked: false });
		expect(
			accessiblePageEvidence('<h1>Access denied</h1><main>Captcha</main>', evidence.sourceUrl)
				.blocked
		).toBe(true);
	});
});
