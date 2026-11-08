import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { fixture } from '../tests/integration/identity-fixture';
import { createDatabase } from '../src/lib/server/db/client';
import { AccessError } from '../src/lib/server/access';
import { updateIdentificationSettings } from '../src/lib/server/enrichment/allowance';
import {
	finishGeminiEvaluation,
	getGeminiStatus,
	reserveGeminiEvaluation,
	runGeminiExtraction,
	type GeminiCaptureResult
} from '../src/lib/server/enrichment/gemini';

type FixtureCase = {
	id: string;
	kind: 'text' | 'image';
	sourceUrl?: string;
	text?: string;
	imageLines?: string[];
	expected: {
		titleContains?: string;
		priceMinor: number | null;
		currency?: string;
		ambiguous?: boolean;
	};
};
const args = process.argv.slice(2);
if (!args.includes('--live')) {
	console.log(
		'Live evaluation is opt-in. Run with --live [--limit 8] [--run-id UUID] after loading the project environment. It sends only versioned synthetic fixtures and reserves each request within the stored shared/monthly/evaluation allowances.'
	);
} else {
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index < 0 ? undefined : args[index + 1];
	};
	const runId = option('--run-id') ?? randomUUID();
	const limit = Number(option('--limit') ?? 8);
	if (!/^[a-f0-9-]{36}$/i.test(runId) || !Number.isInteger(limit) || limit < 1 || limit > 8)
		throw new Error('Use --run-id UUID and --limit between 1 and 8.');
	if (!process.env.DATABASE_PATH || !existsSync(process.env.DATABASE_PATH))
		throw new Error('Load the app environment with its existing DATABASE_PATH before evaluation.');
	const corpus = JSON.parse(
		readFileSync(new URL('./fixtures/gemini-capture.json', import.meta.url), 'utf8')
	) as { version: number; cases: FixtureCase[] };
	const central = createDatabase({ filename: process.env.DATABASE_PATH });
	const isolated = fixture();
	const reports: Record<string, unknown>[] = [];
	let passed = 0,
		failed = 0,
		fields = 0,
		fieldsPassed = 0,
		reserved = 0;
	try {
		const status = getGeminiStatus(central);
		if (!status.configured || !status.enabled)
			throw new Error(
				'Configure Gemini and enable AI in administrator settings before live evaluation.'
			);
		updateIdentificationSettings(isolated.connection, {
			enabled: true,
			monthlyLimitMicrodollars: status.monthlyLimitMicrodollars,
			unitMicrodollars: 3500,
			pricingRevision: 'isolated-evaluation'
		});
		for (const entry of corpus.cases.slice(0, limit)) {
			const hash = createHash('sha256')
				.update(`${runId}:${corpus.version}:${entry.id}`)
				.digest('hex');
			const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
			const fingerprint = createHash('sha256')
				.update(JSON.stringify({ version: corpus.version, fixture: entry, model: status.model }))
				.digest('hex');
			let ticket: ReturnType<typeof reserveGeminiEvaluation>;
			try {
				ticket = reserveGeminiEvaluation(central, operationId, fingerprint);
			} catch (error) {
				reports.push({
					id: entry.id,
					state: 'not-admitted',
					message:
						error instanceof AccessError
							? error.message
							: 'Evaluation admission could not complete.'
				});
				failed++;
				break;
			}
			let result: GeminiCaptureResult;
			const started = Date.now();
			if (ticket.replay) {
				if (!ticket.result) {
					reports.push({ id: entry.id, state: 'previous-attempt-uncertain', replay: true });
					failed++;
					break;
				}
				result = ticket.result;
			} else {
				reserved += status.reservationMicrodollars;
				try {
					let image: File | undefined;
					if (entry.kind === 'image') {
						const lines = (entry.imageLines ?? [])
							.map(
								(line, index) =>
									`<text x="30" y="${65 + index * 65}" font-family="Arial,sans-serif" font-size="32" fill="#111">${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</text>`
							)
							.join('');
						const art =
							lines ||
							'<rect x="170" y="120" width="100" height="100" fill="#b55"/><rect x="280" y="145" width="80" height="75" fill="#59a"/>';
						const bytes = await sharp(
							Buffer.from(
								`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="white"/>${art}</svg>`
							)
						)
							.png()
							.toBuffer();
						image = new File([bytes], `${entry.id}.png`, { type: 'image/png' });
					}
					result = await runGeminiExtraction(isolated.connection, isolated.admin, {
						operationId,
						kind: entry.kind,
						sourceUrl: entry.sourceUrl,
						text: entry.text,
						image,
						evaluation: true
					});
				} catch {
					result = {
						suggestions: [],
						failure: 'provider',
						diagnostic: 'evaluation-request-unavailable',
						message: 'Evaluation could not complete. The reservation remains held.'
					};
				}
				finishGeminiEvaluation(central, ticket, result);
			}
			if (result.failure) {
				reports.push({
					id: entry.id,
					state: 'provider-failure',
					diagnostic: result.diagnostic ?? result.failure,
					latencyMs: ticket.replay ? null : Date.now() - started,
					replay: ticket.replay
				});
				failed++;
				break;
			}
			const suggestion = result.suggestions[0];
			const checks: Record<string, boolean> = {
				price: (suggestion?.offer?.priceMinor ?? null) === entry.expected.priceMinor
			};
			if (entry.expected.titleContains)
				checks.title = !!suggestion?.title
					?.toLowerCase()
					.includes(entry.expected.titleContains.toLowerCase());
			if (entry.expected.currency)
				checks.currency = suggestion?.offer?.currency === entry.expected.currency;
			if (entry.expected.ambiguous) checks.ambiguity = result.ambiguity === true;
			const values = Object.values(checks);
			fields += values.length;
			fieldsPassed += values.filter(Boolean).length;
			const good = values.every(Boolean);
			if (good) passed++;
			else failed++;
			reports.push({
				id: entry.id,
				passed: good,
				checks,
				latencyMs: ticket.replay ? null : Date.now() - started,
				replay: ticket.replay,
				usage: result.usage ?? null
			});
		}
		console.log(
			JSON.stringify(
				{
					runId,
					model: status.model,
					fixtureVersion: corpus.version,
					liveRetailerFetching: false,
					attempted: reports.length,
					passed,
					failed,
					fieldsPassed,
					fieldsEvaluated: fields,
					reservedThisRunMicrodollars: reserved,
					remainingEvaluationMicrodollars: getGeminiStatus(central).evaluationRemainingMicrodollars,
					cases: reports
				},
				null,
				2
			)
		);
		if (failed) process.exitCode = 1;
	} finally {
		isolated.connection.close();
		central.close();
	}
}
