import { describe, expect, it } from 'vitest';
import { emptyDraft, capturePayload, priceInput, formatPrice } from '../../src/lib/catalogue-types';
describe('original-currency shopping prices', () => {
	for (const [currency, price, minor] of [
		['GBP', '12.50', 1250],
		['JPY', '1500', 1500],
		['KWD', '1.235', 1235]
	] as const) {
		it(`stores ${currency} using its own minor units while gift estimates remain GBP pence`, () => {
			const draft = emptyDraft();
			draft.title = 'Gift';
			draft.estimate = '12.50';
			draft.offers = [{ url: 'https://example.test', retailer: 'Test', currency, price }];
			expect(capturePayload(draft)).toMatchObject({
				estimatePence: 1250,
				offers: [{ currency, priceMinor: minor }]
			});
		});
	}
});

it('formats original currency prices without changing their scale', () => {
	expect(priceInput(1500, 'JPY')).toBe('1500');
	expect(formatPrice(1500, 'JPY')).toBe('JP¥1,500');
	expect(priceInput(1235, 'KWD')).toBe('1.235');
	expect(priceInput(null, 'GBP')).toBe('');
});
