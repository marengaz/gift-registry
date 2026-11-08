export type CropBox = { left: number; top: number; width: number; height: number };
export const fullImage: CropBox = { left: 0, top: 0, width: 100, height: 100 };

export function normaliseCrop(value: CropBox): CropBox {
	if (!Object.values(value).every(Number.isFinite)) throw new Error('Choose a valid image area.');
	const left = Math.min(99, Math.max(0, value.left));
	const top = Math.min(99, Math.max(0, value.top));
	return {
		left,
		top,
		width: Math.min(100 - left, Math.max(1, value.width)),
		height: Math.min(100 - top, Math.max(1, value.height))
	};
}

export function cropPixels(value: CropBox, width: number, height: number): CropBox {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
		throw new Error('This image has no usable dimensions.');
	const box = normaliseCrop(value);
	const left = Math.min(width - 1, Math.floor((box.left / 100) * width));
	const top = Math.min(height - 1, Math.floor((box.top / 100) * height));
	return {
		left,
		top,
		width: Math.min(width - left, Math.max(1, Math.round((box.width / 100) * width))),
		height: Math.min(height - top, Math.max(1, Math.round((box.height / 100) * height)))
	};
}

async function decode(file: File) {
	if (typeof createImageBitmap === 'function') {
		const bitmap = await createImageBitmap(file);
		return {
			source: bitmap,
			width: bitmap.width,
			height: bitmap.height,
			close: () => bitmap.close()
		};
	}
	const url = URL.createObjectURL(file);
	const image = new Image();
	try {
		image.src = url;
		await image.decode();
		return {
			source: image,
			width: image.naturalWidth,
			height: image.naturalHeight,
			close: () => URL.revokeObjectURL(url)
		};
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

export async function cropImage(file: File, selection: CropBox, quarterTurns = 0): Promise<File> {
	if (file.size > 12 * 1024 * 1024) throw new Error('Choose an image of 12 MB or smaller.');
	let image: Awaited<ReturnType<typeof decode>>;
	try {
		image = await decode(file);
	} catch {
		throw new Error('This browser could not edit the image. Try a JPEG, PNG or WebP copy.');
	}
	try {
		if (image.width * image.height > 30_000_000)
			throw new Error('Choose an image of 30 megapixels or smaller.');
		const turns = ((Math.round(quarterTurns) % 4) + 4) % 4;
		const rotated = document.createElement('canvas');
		rotated.width = turns % 2 ? image.height : image.width;
		rotated.height = turns % 2 ? image.width : image.height;
		const context = rotated.getContext('2d');
		if (!context) throw new Error('Image editing is unavailable in this browser.');
		context.translate(rotated.width / 2, rotated.height / 2);
		context.rotate((turns * Math.PI) / 2);
		context.drawImage(image.source, -image.width / 2, -image.height / 2);
		const pixels = cropPixels(selection, rotated.width, rotated.height);
		const output = document.createElement('canvas');
		output.width = pixels.width;
		output.height = pixels.height;
		const result = output.getContext('2d');
		if (!result) throw new Error('Image editing is unavailable in this browser.');
		result.drawImage(
			rotated,
			pixels.left,
			pixels.top,
			pixels.width,
			pixels.height,
			0,
			0,
			pixels.width,
			pixels.height
		);
		const blob = await new Promise<Blob>((resolve, reject) =>
			output.toBlob(
				(value) =>
					value ? resolve(value) : reject(new Error('The edited image could not be kept.')),
				'image/webp',
				0.9
			)
		);
		const name = file.name.replace(/\.[^.]+$/, '') || 'image';
		return new File([blob], `${name}-crop.${blob.type === 'image/webp' ? 'webp' : 'png'}`, {
			type: blob.type
		});
	} finally {
		image.close();
	}
}
