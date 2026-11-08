import { describe, expect, it } from 'vitest';
import { emptyDraft } from '../../src/lib/catalogue-types';
import { applySuggestion, markEdited, undoAutofill } from '../../src/lib/client/capture-autofill';
import type { ProductSuggestion } from '../../src/lib/server/enrichment/types';

const suggestion = (changes: Partial<ProductSuggestion> = {}): ProductSuggestion => ({
	title: 'Wooden train',
	description: 'A train with stacking blocks.',
	variant: 'Blue',
	imageUrl: null,
	sourceUrl: 'https://shop.example/train',
	retrievedAt: 1,
	source: 'json-ld',
	offer: {
		url: 'https://shop.example/train',
		retailer: 'Toy shop',
		priceMinor: 1299,
		currency: 'GBP',
		priceText: '£12.99',
		fromPrice: false
	},
	uncertainty: [],
	...changes
});

describe('capture autofill', () => {
	it('fills empty fields without changing the selected lists or existing notes', () => {
		const draft = emptyDraft();
		draft.description = 'Ask Grandma about this one';
		draft.listIds = ['lukes-birthday'];
		applySuggestion(draft, suggestion());
		expect(draft).toMatchObject({
			title: 'Wooden train',
			description: 'Ask Grandma about this one',
			variant: 'Blue',
			estimate: '12.99',
			listIds: ['lukes-birthday'],
			offers: [{ price: '12.99', currency: 'GBP', url: 'https://shop.example/train' }]
		});
	});
	it('remembers deliberately cleared fields across serialisation and later suggestions', () => {
		const draft = emptyDraft();
		applySuggestion(draft, suggestion());
		draft.title = '';
		draft.estimate = '';
		markEdited(draft, 'title');
		markEdited(draft, 'estimate');
		const reopened = JSON.parse(JSON.stringify(draft));
		applySuggestion(reopened, suggestion({ title: 'Another train' }));
		expect(reopened.title).toBe('');
		expect(reopened.estimate).toBe('');
		expect(reopened.editedFields).toEqual(['title', 'estimate']);
	});
	it('undoes only inserted values that the user has not subsequently edited', () => {
		const draft = emptyDraft();
		draft.variant = 'My chosen colour';
		const patch = applySuggestion(draft, suggestion());
		draft.description = 'My notes';
		markEdited(draft, 'description');
		markEdited(draft, 'title');
		draft.listIds = ['kates-christmas'];
		undoAutofill(draft, patch);
		expect(draft).toMatchObject({
			title: 'Wooden train',
			description: 'My notes',
			variant: 'My chosen colour',
			estimate: '',
			offers: [],
			listIds: ['kates-christmas']
		});
	});
	it('keeps foreign prices in their original minor units without inventing a GBP estimate', () => {
		const draft = emptyDraft();
		const foreign = suggestion();
		foreign.offer = { ...foreign.offer!, currency: 'JPY', priceMinor: 1500, priceText: '¥1500' };
		applySuggestion(draft, foreign);
		expect(draft.estimate).toBe('');
		expect(draft.offers[0]).toMatchObject({ price: '1500', currency: 'JPY' });
	});
	it('does not undo an offer that was changed after insertion', () => {
		const draft = emptyDraft();
		const patch = applySuggestion(draft, suggestion());
		draft.offers[0].retailer = 'My corrected shop';
		undoAutofill(draft, patch);
		expect(draft.offers[0].retailer).toBe('My corrected shop');
	});
	it('does not promote from-prices or ambiguous variants to exact shopping or list prices', () => {
		for (const candidate of [
			suggestion({ offer: { ...suggestion().offer!, fromPrice: true } }),
			suggestion({
				uncertainty: ['Several variants or offers are shown; confirm the exact variant.']
			})
		]) {
			const draft = emptyDraft();
			applySuggestion(draft, candidate);
			expect(draft.estimate).toBe('');
			expect(draft.offers[0]?.price).toBe('');
		}
	});
	it('preserves a genuine zero price and ignores unsafe shopping links', () => {
		const zero = suggestion({
			offer: { ...suggestion().offer!, priceMinor: 0, priceText: '£0.00' }
		});
		const draft = emptyDraft();
		applySuggestion(draft, zero);
		expect(draft.estimate).toBe('0.00');
		expect(draft.offers[0].price).toBe('0.00');
		const unsafe = emptyDraft();
		applySuggestion(
			unsafe,
			suggestion({ offer: { ...suggestion().offer!, url: 'javascript:alert(1)' } })
		);
		expect(unsafe.offers).toEqual([]);
	});
});
