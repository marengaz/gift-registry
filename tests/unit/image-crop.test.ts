import { describe, expect, it } from 'vitest';
import { cropPixels, normaliseCrop } from '../../src/lib/client/image-crop';

describe('image crop selection', () => {
	it('maps the selected percentage area to integer source pixels without exceeding the image', () => {
		expect(cropPixels({ left: 10, top: 20, width: 50, height: 40 }, 400, 300)).toEqual({
			left: 40,
			top: 60,
			width: 200,
			height: 120
		});
		expect(cropPixels({ left: 99, top: 99, width: 100, height: 100 }, 3, 2)).toEqual({
			left: 2,
			top: 1,
			width: 1,
			height: 1
		});
	});
	it('keeps pointer and keyboard selections within a nonempty image rectangle', () => {
		expect(normaliseCrop({ left: -5, top: 200, width: 0, height: 80 })).toEqual({
			left: 0,
			top: 99,
			width: 1,
			height: 1
		});
		expect(() => normaliseCrop({ left: NaN, top: 0, width: 10, height: 10 })).toThrow();
		expect(() => cropPixels({ left: 0, top: 0, width: 100, height: 100 }, 0, 2)).toThrow();
	});
});
