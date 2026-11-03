import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { AccessError, requireMember, requireMediaAccess } from './access';
import type { DatabaseConnection } from './db/client';
import { apiResponse } from './http';
import type { CatalogueEvent } from './catalogue';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 30_000_000;
export type MediaOptions = { mediaRoot?: string };
export type PreparedMedia = {
	id: string;
	storagePath: string;
	mimeType: string;
	byteSize: number;
	originalName: string;
};
export function mediaRoot(options: MediaOptions = {}) {
	return resolve(options.mediaRoot ?? process.env.MEDIA_PATH ?? 'data/media');
}
/** Immutable originals and stripped raster previews share an opaque directory outside public assets. */
export async function prepareMedia(files: File[], options: MediaOptions = {}) {
	const root = mediaRoot(options);
	const prepared: PreparedMedia[] = [];
	const created: string[] = [];
	const cleanup = async () => {
		await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
	};
	try {
		for (const file of files) {
			if (file.size > MAX_IMAGE_BYTES)
				throw new AccessError(
					413,
					'Each photo must be 12 MB or smaller. Choose a smaller photo and try again.'
				);
			if (!file.size) throw new AccessError(400, 'This photo is empty. Choose another photo.');
			const bytes = Buffer.from(await file.arrayBuffer());
			let preview: Buffer;
			let format: string;
			try {
				const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, animated: false });
				const metadata = await image.metadata();
				format = metadata.format ?? '';
				if (!['jpeg', 'png', 'webp', 'gif', 'heif', 'avif', 'tiff'].includes(format))
					throw new Error('Unsupported raster');
				if (
					!metadata.width ||
					!metadata.height ||
					metadata.width * metadata.height > MAX_IMAGE_PIXELS
				)
					throw new Error('Image too large');
				preview = await image
					.rotate()
					.resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
					.webp({ quality: 85 })
					.toBuffer();
			} catch {
				throw new AccessError(
					400,
					'This photo could not be opened safely. Use a JPEG, PNG or WebP photo under 30 megapixels. Your draft has not been saved.'
				);
			}
			const id = randomUUID();
			const directory = join(root, id);
			await mkdir(directory, { recursive: true });
			created.push(directory);
			await writeFile(join(directory, 'original'), bytes, { flag: 'wx' });
			await writeFile(join(directory, 'preview.webp'), preview, { flag: 'wx' });
			prepared.push({
				id,
				storagePath: `${id}/original`,
				mimeType: `image/${format === 'heif' ? 'heic' : format}`,
				byteSize: bytes.length,
				originalName: file.name
			});
		}
		return { media: prepared, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}
export async function mediaGet(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	id: string,
	options: MediaOptions = {}
) {
	let response: Response | undefined;
	const failure = await apiResponse(async () => {
		const actor = requireMember(connection, event.locals.actor);
		const item = requireMediaAccess(connection, actor, id);
		const root = mediaRoot(options);
		const original = resolve(root, item.storagePath);
		if (!original.startsWith(root + '/')) throw new AccessError(404, 'Image not found.');
		const download = event.url.searchParams.get('original') === '1';
		let bytes: Buffer;
		try {
			bytes = await readFile(download ? original : join(original, '..', 'preview.webp'));
		} catch {
			throw new AccessError(404, 'Image not found.');
		}
		response = new Response(new Uint8Array(bytes), {
			headers: {
				'Content-Type': download ? 'application/octet-stream' : 'image/webp',
				'Content-Disposition': download ? `attachment; filename="photo-${item.id}"` : 'inline',
				'Cache-Control': 'private, no-store',
				Vary: 'Cookie',
				'X-Content-Type-Options': 'nosniff'
			}
		});
		return {};
	});
	return response ?? failure;
}
