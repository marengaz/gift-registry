import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { AccessError, canCapture, requireMember, type Actor } from '../access';
import type { CatalogueEvent } from '../catalogue';
import type { DatabaseConnection } from '../db/client';
import { apiResponse, assertSameOrigin } from '../http';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../media';
import { allowanceSummary, getIdentificationSettings } from './allowance';
import { publicUrl } from './fetch';
import {
	accessiblePageEvidence,
	extractionInstruction,
	extractionJsonSchema,
	suggestionFromExtraction
} from './gemini-evidence';
import type { ProductSuggestion } from './types';

export type GeminiDependencies = { environment?: NodeJS.ProcessEnv; transport?: typeof fetch };
export type GeminiCaptureInput = {
	operationId: string;
	kind: 'page' | 'text' | 'image';
	sourceUrl?: string;
	text?: string;
	image?: File;
	evaluation?: boolean;
};
export type GeminiCaptureResult = {
	suggestions: ProductSuggestion[];
	message: string;
	ambiguity?: boolean;
	failure?: 'provider' | 'invalid-output';
	diagnostic?: string;
	usage?: { inputTokens: number; outputTokens: number; estimatedCostMicrodollars: number };
};
type StoredRequest = {
	fingerprint: string;
	month: string;
	state: string;
	result_json: string | null;
};
const reservationMicrodollars = 20_000;
const maximumInputTokens = 32768;
const maximumOutputTokens = 2048;
// Allowlisted pricing is at most $0.30/M input and $2.50/M output. The $0.02
// reservation covers those limits plus framing margin; Interactions caps thinking
// and visible output together. Count the schema as text during token preflight.
const supportedModels = new Set(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
class ProviderError extends Error {
	constructor(public status: number) {
		super('The AI service could not accept the request.');
	}
}

function dollars(value: string | undefined, fallback: string) {
	const text = value ?? fallback;
	if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return 0;
	const [whole, fraction = ''] = text.split('.');
	const amount = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
	return Number.isSafeInteger(amount) ? amount : 0;
}
function configuration(environment: NodeJS.ProcessEnv) {
	const model = environment.GEMINI_MODEL || 'gemini-3.5-flash-lite';
	return {
		model,
		key: environment.GEMINI_API_KEY || '',
		configured: !!environment.GEMINI_API_KEY && supportedModels.has(model),
		monthlyLimitMicrodollars: dollars(environment.GEMINI_MONTHLY_BUDGET_USD, '2.00'),
		evaluationLimitMicrodollars: dollars(environment.GEMINI_EVAL_BUDGET_USD, '0.25')
	};
}
export function getGeminiStatus(connection: DatabaseConnection, environment = process.env) {
	const settings = configuration(environment);
	const admin = allowanceSummary(connection);
	const totals = connection.sqlite
		.prepare(
			`SELECT coalesce(sum(reserved_microdollars),0) AS total, coalesce(sum(CASE WHEN evaluation=1 THEN reserved_microdollars ELSE 0 END),0) AS evaluation FROM gemini_capture_requests WHERE month=?`
		)
		.get(admin.month) as { total: number; evaluation: number };
	return {
		configured: settings.configured,
		enabled: admin.enabled,
		model: settings.model,
		month: admin.month,
		monthlyLimitMicrodollars: Math.min(
			settings.monthlyLimitMicrodollars,
			admin.monthlyLimitMicrodollars
		),
		evaluationLimitMicrodollars: settings.evaluationLimitMicrodollars,
		reservedMicrodollars: totals.total,
		sharedReservedMicrodollars: admin.reservedMicrodollars,
		evaluationReservedMicrodollars: totals.evaluation,
		remainingMicrodollars: Math.max(
			0,
			Math.min(settings.monthlyLimitMicrodollars - totals.total, admin.remainingMicrodollars)
		),
		evaluationRemainingMicrodollars: Math.max(
			0,
			Math.min(
				settings.evaluationLimitMicrodollars - totals.evaluation,
				settings.monthlyLimitMicrodollars - totals.total,
				admin.remainingMicrodollars
			)
		),
		reservationMicrodollars
	};
}
function contributor(connection: DatabaseConnection, actor: Actor | null | undefined) {
	const current = requireMember(connection, actor);
	if (!canCapture(connection, current))
		throw new AccessError(403, 'Contributor permission is needed to fill gift details.');
	return current;
}
function safeSource(value = '') {
	if (!value) return '';
	if (value.length > 4000) throw new AccessError(400, 'The product link is too long.');
	try {
		return publicUrl(value).href;
	} catch {
		throw new AccessError(400, 'Use a public HTTPS product link, or leave it blank.');
	}
}
function admitRequest(
	connection: DatabaseConnection,
	actorId: string,
	operationId: string,
	fingerprint: string,
	evaluation: boolean,
	environment: NodeJS.ProcessEnv
) {
	return connection.sqlite
		.transaction(() => {
			const previous = connection.sqlite
				.prepare(
					'SELECT fingerprint,month,state,result_json FROM gemini_capture_requests WHERE actor_id=? AND operation_id=?'
				)
				.get(actorId, operationId) as StoredRequest | undefined;
			if (previous) {
				if (previous.fingerprint !== fingerprint)
					throw new AccessError(409, 'These request details changed. Start a new lookup.');
				return { month: previous.month, previous };
			}
			const status = getGeminiStatus(connection, environment);
			if (!status.configured) throw new AccessError(409, 'AI details are not configured.');
			if (!status.enabled) throw new AccessError(409, 'AI details are disabled.');
			if (
				status.remainingMicrodollars < reservationMicrodollars ||
				(evaluation && status.evaluationRemainingMicrodollars < reservationMicrodollars)
			)
				throw new AccessError(
					409,
					'The AI allowance is exhausted. You can still save this idea and enter details yourself.'
				);
			connection.sqlite
				.prepare(
					'INSERT INTO gemini_capture_requests (actor_id,operation_id,fingerprint,month,evaluation,reserved_microdollars,state,created_at) VALUES (?,?,?,?,?,?,?,?)'
				)
				.run(
					actorId,
					operationId,
					fingerprint,
					status.month,
					evaluation ? 1 : 0,
					reservationMicrodollars,
					'running',
					Date.now()
				);
			return { month: status.month, previous: undefined };
		})
		.immediate();
}

export type GeminiEvaluationTicket = {
	actorId: string;
	operationId: string;
	replay: boolean;
	result: GeminiCaptureResult | null;
};
/** Trusted local evaluation tooling only; no HTTP route admits evaluation work. */
export function reserveGeminiEvaluation(
	connection: DatabaseConnection,
	operationId: string,
	fingerprint: string,
	environment = process.env
): GeminiEvaluationTicket {
	if (!z.uuid().safeParse(operationId).success || !/^[a-f0-9]{64}$/.test(fingerprint))
		throw new AccessError(400, 'The evaluation identifier is invalid.');
	const administrator = connection.sqlite
		.prepare('SELECT administrator_id AS id FROM application_settings WHERE id=1')
		.get() as { id: string } | undefined;
	if (!administrator?.id)
		throw new AccessError(
			409,
			'Sign in as the configured administrator before running an evaluation.'
		);
	const admitted = admitRequest(
		connection,
		administrator.id,
		operationId,
		fingerprint,
		true,
		environment
	);
	return {
		actorId: administrator.id,
		operationId,
		replay: !!admitted.previous,
		result: admitted.previous?.result_json ? JSON.parse(admitted.previous.result_json) : null
	};
}
export function finishGeminiEvaluation(
	connection: DatabaseConnection,
	ticket: GeminiEvaluationTicket,
	result: GeminiCaptureResult
) {
	connection.sqlite
		.prepare(
			'UPDATE gemini_capture_requests SET state=?,result_json=? WHERE actor_id=? AND operation_id=? AND evaluation=1'
		)
		.run(
			result.failure ? 'uncertain' : 'complete',
			JSON.stringify(result),
			ticket.actorId,
			ticket.operationId
		);
}
async function providerJson(url: string, body: unknown, key: string, transport: typeof fetch) {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const response = await transport(url, {
					method: 'POST',
					redirect: 'error',
					signal: controller.signal,
					headers: {
						'content-type': 'application/json',
						'x-goog-api-key': key,
						'Api-Revision': '2026-05-20'
					},
					body: JSON.stringify(body)
				});
				if (!response.ok) {
					await response.body?.cancel();
					throw new ProviderError(response.status);
				}
				const reader = response.body?.getReader();
				if (!reader) throw new Error('No provider response');
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				try {
					for (;;) {
						const next = await reader.read();
						if (next.done) break;
						bytes += next.value.byteLength;
						if (bytes > 128_000) {
							await reader.cancel();
							throw new Error('Provider response too large');
						}
						chunks.push(next.value);
					}
				} finally {
					reader.releaseLock();
				}
				return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error('Provider timed out'));
				}, 20_000);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function runGeminiExtraction(
	connection: DatabaseConnection,
	actor: Actor | null | undefined,
	input: GeminiCaptureInput,
	dependencies: GeminiDependencies = {}
): Promise<GeminiCaptureResult> {
	const author = contributor(connection, actor);
	if (!z.uuid().safeParse(input.operationId).success)
		throw new AccessError(400, 'Start a new details request.');
	const environment = dependencies.environment ?? process.env;
	const config = configuration(environment);
	if (!config.configured)
		throw new AccessError(
			409,
			'AI details are not configured. You can still save the idea and enter details yourself.'
		);
	if (!getIdentificationSettings(connection).enabled)
		throw new AccessError(
			409,
			'AI details are disabled. Capture and retailer metadata still work.'
		);
	const sourceUrl = safeSource(input.sourceUrl);
	let text = input.text?.trim() || '';
	let imageUrls: string[] = [];
	let imageBytes: Buffer | undefined;
	if (input.kind === 'page') {
		const evidence = accessiblePageEvidence(text, sourceUrl);
		if (evidence.blocked || !evidence.useful)
			return {
				suggestions: [],
				message: 'We could not read this shop page. Add a screenshot or enter its details yourself.'
			};
		text = evidence.text;
		imageUrls = evidence.imageUrls;
	} else if (input.kind === 'text') {
		if (!text || text.length > 16000)
			throw new AccessError(400, 'Paste up to 16,000 characters of product details.');
	} else if (input.kind === 'image') {
		if (!input.image || input.image.size <= 0 || input.image.size > MAX_IMAGE_BYTES)
			throw new AccessError(400, 'Choose an image of 12 MB or less.');
		try {
			const decoder = sharp(Buffer.from(await input.image.arrayBuffer()), {
				limitInputPixels: MAX_IMAGE_PIXELS,
				animated: false
			});
			const info = await decoder.metadata();
			if (!['jpeg', 'png', 'webp', 'heif', 'avif'].includes(info.format || ''))
				throw new Error('Unsupported image');
			imageBytes = await decoder
				.rotate()
				.resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
				.webp({ quality: 85 })
				.toBuffer();
			text = 'Read only the selected product image. Return unknown for anything not visible.';
		} catch {
			throw new AccessError(
				400,
				'This image could not be read. Try a smaller JPEG, PNG or WebP copy.'
			);
		}
	} else throw new AccessError(400, 'Choose a link, image or product text.');
	contributor(connection, author);
	const fingerprint = createHash('sha256')
		.update(
			JSON.stringify({
				kind: input.kind,
				text,
				sourceUrl,
				imageUrls,
				model: config.model,
				evaluation: input.evaluation === true
			})
		)
		.update(imageBytes ?? '')
		.digest('hex');
	const admitted = admitRequest(
		connection,
		author.userId,
		input.operationId,
		fingerprint,
		input.evaluation === true,
		environment
	);
	if (admitted.previous) {
		return admitted.previous.result_json
			? JSON.parse(admitted.previous.result_json)
			: {
					suggestions: [],
					message:
						'This details request is already being checked. Your idea is safe; keep editing or save what you have.'
				};
	}
	const transport = dependencies.transport ?? fetch;
	const prompt = JSON.stringify({ sourceUrl, evidence: text, candidateImages: imageUrls });
	const inputParts: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
	const tokenParts: Record<string, unknown>[] = [
		{ text: prompt },
		{ text: JSON.stringify(extractionJsonSchema) }
	];
	if (imageBytes) {
		inputParts.push({
			type: 'image',
			data: imageBytes.toString('base64'),
			mime_type: 'image/webp'
		});
		tokenParts.push({
			inlineData: { data: imageBytes.toString('base64'), mimeType: 'image/webp' }
		});
	}
	let result: GeminiCaptureResult;
	try {
		const counted = await providerJson(
			`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:countTokens`,
			{
				generateContentRequest: {
					model: `models/${config.model}`,
					contents: [{ role: 'user', parts: tokenParts }],
					systemInstruction: { parts: [{ text: extractionInstruction }] }
				}
			},
			config.key,
			transport
		);
		if (
			typeof counted.totalTokens !== 'number' ||
			!Number.isInteger(counted.totalTokens) ||
			counted.totalTokens < 1 ||
			counted.totalTokens > maximumInputTokens
		)
			throw new Error('Input token limit');
		contributor(connection, author);
		if (
			!getIdentificationSettings(connection).enabled ||
			admitted.month !== new Date().toISOString().slice(0, 7)
		)
			throw new AccessError(409, 'AI settings changed. Keep the idea and try again later.');
		const response = await providerJson(
			'https://generativelanguage.googleapis.com/v1beta/interactions',
			{
				model: config.model,
				input: inputParts,
				system_instruction: extractionInstruction,
				store: false,
				generation_config: {
					max_output_tokens: maximumOutputTokens,
					thinking_level: 'minimal',
					thinking_summaries: 'none'
				},
				response_format: {
					type: 'text',
					mime_type: 'application/json',
					schema: extractionJsonSchema
				}
			},
			config.key,
			transport
		);
		contributor(connection, author);
		if (response.status !== 'completed' || !Array.isArray(response.steps))
			throw new Error('Incomplete model output');
		const outputs = response.steps.filter(
			(step: unknown) =>
				!!step &&
				typeof step === 'object' &&
				(step as Record<string, unknown>).type === 'model_output'
		) as { content?: { type?: string; text?: string }[] }[];
		const output = outputs
			.flatMap((step) => (Array.isArray(step.content) ? step.content : []))
			.filter((part) => part.type === 'text' && typeof part.text === 'string')
			.map((part) => part.text)
			.join('');
		if (!output || output.length > 16000) throw new Error('Unreadable model output');
		result = suggestionFromExtraction(JSON.parse(output), {
			kind: input.kind,
			text,
			sourceUrl,
			imageUrls
		});
		const usage = response.usage as Record<string, unknown> | undefined;
		const inputTokens = usage?.total_input_tokens;
		const visible = usage?.total_output_tokens;
		const thinking = usage?.total_thought_tokens ?? 0;
		if (
			typeof inputTokens === 'number' &&
			typeof visible === 'number' &&
			typeof thinking === 'number' &&
			[inputTokens, visible, thinking].every((value) => Number.isSafeInteger(value) && value >= 0)
		) {
			const outputTokens = visible + thinking;
			const inputRate = config.model === 'gemini-3.1-flash-lite' ? 0.25 : 0.3;
			const outputRate = config.model === 'gemini-3.1-flash-lite' ? 1.5 : 2.5;
			result.usage = {
				inputTokens,
				outputTokens,
				estimatedCostMicrodollars: Math.ceil(inputTokens * inputRate + outputTokens * outputRate)
			};
		}
		connection.sqlite
			.prepare(
				"UPDATE gemini_capture_requests SET state='complete',result_json=? WHERE actor_id=? AND operation_id=?"
			)
			.run(JSON.stringify(result), author.userId, input.operationId);
		return result;
	} catch (error) {
		result = {
			suggestions: [],
			failure: 'provider',
			diagnostic:
				error instanceof ProviderError
					? `provider-http-${error.status}`
					: 'provider-response-unavailable',
			message:
				error instanceof ProviderError && error.status === 402
					? 'AI help is unavailable. The administrator needs to check the Google billing balance. Your idea is kept; enter anything you know or save it as it is.'
					: 'The details could not be read reliably. Your idea is safe; add anything you know or save it as it is.'
		};
		connection.sqlite
			.prepare(
				"UPDATE gemini_capture_requests SET state='uncertain',result_json=? WHERE actor_id=? AND operation_id=?"
			)
			.run(JSON.stringify(result), author.userId, input.operationId);
		if (error instanceof AccessError) throw error;
		return result;
	}
}

export function captureDetailsGet(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	dependencies: GeminiDependencies = {}
) {
	return apiResponse(() => {
		contributor(connection, event.locals.actor);
		return getGeminiStatus(connection, dependencies.environment);
	});
}
export function captureDetailsPost(
	connection: DatabaseConnection,
	event: CatalogueEvent,
	dependencies: GeminiDependencies = {}
) {
	return apiResponse(async () => {
		assertSameOrigin(event.request, event.url);
		contributor(connection, event.locals.actor);
		const data = await event.request.formData();
		const kind = data.get('kind');
		if (kind !== 'image' && kind !== 'text')
			throw new AccessError(400, 'Choose an image or product text.');
		const text = data.get('text'),
			image = data.get('image'),
			source = data.get('sourceUrl');
		return runGeminiExtraction(
			connection,
			event.locals.actor,
			{
				operationId: String(data.get('operationId') || ''),
				kind,
				text: typeof text === 'string' ? text : '',
				image: image instanceof File ? image : undefined,
				sourceUrl: typeof source === 'string' ? source : ''
			},
			dependencies
		);
	});
}
