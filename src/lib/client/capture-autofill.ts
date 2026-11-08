import {
	priceInput,
	type CaptureDraft,
	type CaptureEditedField,
	type ShoppingDraft
} from '../catalogue-types';
import type { ProductSuggestion } from '../server/enrichment/types';

type TextField = 'title' | 'description' | 'variant' | 'estimate';
type TextChange = { field: TextField; before: string; inserted: string };
export type AutofillPatch = {
	fields: TextChange[];
	offers?: { before: ShoppingDraft[]; inserted: ShoppingDraft[] };
};

export function markEdited(draft: CaptureDraft, field: CaptureEditedField) {
	if (!draft.editedFields?.includes(field))
		draft.editedFields = [...(draft.editedFields ?? []), field];
}

function edited(draft: CaptureDraft, field: CaptureEditedField) {
	return draft.editedFields?.includes(field) ?? false;
}

function shoppingUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
	} catch {
		return '';
	}
}

export function applySuggestion(draft: CaptureDraft, candidate: ProductSuggestion): AutofillPatch {
	const patch: AutofillPatch = { fields: [] };
	const insert = (field: TextField, value: string | null) => {
		if (value && !draft[field].trim() && !edited(draft, field)) {
			patch.fields.push({ field, before: draft[field], inserted: value });
			draft[field] = value;
		}
	};
	insert('title', candidate.title);
	insert('description', candidate.description);
	insert('variant', candidate.variant);
	const offer = candidate.offer;
	const currency = offer?.currency;
	const ambiguous = candidate.uncertainty.some((message) =>
		/(several|multiple).*(variants?|offers?|products?)|price range|conflicting price|unclear variant/i.test(
			message
		)
	);
	const exactPrice =
		!!offer &&
		!offer.fromPrice &&
		!ambiguous &&
		Number.isSafeInteger(offer.priceMinor) &&
		offer.priceMinor !== null &&
		offer.priceMinor >= 0;
	if (currency === 'GBP' && exactPrice) insert('estimate', priceInput(offer!.priceMinor, 'GBP'));
	if (
		offer &&
		currency &&
		/^[A-Z]{3}$/.test(currency) &&
		!draft.offers.length &&
		!edited(draft, 'offers')
	) {
		const url = shoppingUrl(offer.url);
		if (url) {
			const inserted = [
				{
					url,
					retailer: offer.retailer ?? '',
					price: exactPrice ? priceInput(offer.priceMinor, currency) : '',
					currency
				}
			];
			patch.offers = {
				before: draft.offers.map((value) => ({ ...value })),
				inserted: inserted.map((value) => ({ ...value }))
			};
			draft.offers = inserted;
		}
	}
	return patch;
}

export function undoAutofill(draft: CaptureDraft, patch: AutofillPatch) {
	for (const { field, before, inserted } of patch.fields)
		if (!edited(draft, field) && draft[field] === inserted) draft[field] = before;
	if (
		patch.offers &&
		!edited(draft, 'offers') &&
		JSON.stringify(draft.offers) === JSON.stringify(patch.offers.inserted)
	)
		draft.offers = patch.offers.before;
}
