import { readFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import { evidenceUrl } from './metadata';
export type VisionMatches = { labels: string[]; pages: string[] };
export type VisionProvider = {
	projectId: string;
	detect: (image: Buffer) => Promise<VisionMatches>;
};
export function visionConfiguration(environment: NodeJS.ProcessEnv = process.env) {
	return {
		ready: !!environment.VISION_PROJECT_ID && !!environment.VISION_CREDENTIALS_FILE,
		projectId: environment.VISION_PROJECT_ID ?? null
	};
}
export function createVisionProvider(
	environment: NodeJS.ProcessEnv = process.env
): VisionProvider | null {
	const config = visionConfiguration(environment);
	if (!config.ready) return null;
	return {
		projectId: config.projectId!,
		async detect(image) {
			const credentials = JSON.parse(await readFile(environment.VISION_CREDENTIALS_FILE!, 'utf8'));
			if (
				credentials.type !== 'service_account' ||
				credentials.project_id !== config.projectId ||
				!credentials.private_key ||
				!credentials.client_email
			)
				throw new Error(
					'Use a service-account credential from the configured personal Vision project.'
				);
			const auth = new GoogleAuth({
				projectId: config.projectId!,
				credentials,
				scopes: ['https://www.googleapis.com/auth/cloud-vision']
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			const headers = await Promise.race([
				auth.getRequestHeaders('https://vision.googleapis.com/'),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('Vision authentication timed out before image dispatch.')),
						10000
					);
				})
			]).finally(() => clearTimeout(timer));
			headers.set('content-type', 'application/json');
			headers.set('x-goog-user-project', config.projectId!);
			const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
				method: 'POST',
				headers,
				redirect: 'error',
				signal: AbortSignal.timeout(20000),
				body: JSON.stringify({
					requests: [
						{
							image: { content: image.toString('base64') },
							features: [{ type: 'WEB_DETECTION', maxResults: 5 }]
						}
					]
				})
			});
			const chunks: Uint8Array[] = [];
			let length = 0;
			if (!response.body) throw new Error('Vision returned an empty response.');
			for await (const chunk of response.body) {
				length += chunk.length;
				if (length > 1024 * 1024) {
					await response.body.cancel().catch(() => {});
					throw new Error('Vision returned an oversized response.');
				}
				chunks.push(chunk);
			}
			if (!response.ok)
				throw new Error('Vision could not confirm this request. Its allowance remains reserved.');
			const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			if (result.responses?.[0]?.error)
				throw new Error('Vision could not identify this image. Its allowance remains reserved.');
			const web = result.responses?.[0]?.webDetection ?? {};
			return {
				labels: (web.bestGuessLabels ?? [])
					.map((item: { label?: unknown }) =>
						typeof item.label === 'string' ? item.label.slice(0, 200) : ''
					)
					.filter(Boolean)
					.slice(0, 5),
				pages: (web.pagesWithMatchingImages ?? [])
					.map((item: { url?: unknown }) => evidenceUrl(item.url, 'https://vision.googleapis.com/'))
					.filter((url: unknown): url is string => typeof url === 'string')
					.slice(0, 3)
			};
		}
	};
}
