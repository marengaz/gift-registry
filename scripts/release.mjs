import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const conventional =
	/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^\r\n()]+\))?!?: [^\r\n]+$/;
const semanticTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** @param {string} title */
export function validTitle(title) {
	return conventional.test(title);
}

/** @param {string} a @param {string} b */
function compareSemanticTags(a, b) {
	const av = a.slice(1).split('.').map(Number),
		bv = b.slice(1).split('.').map(Number);
	return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
}

/** @param {string | null} previous @param {string[]} messages */
export function nextVersion(previous, messages) {
	if (!messages.length) throw new Error('No commits to release');
	if (previous === null) return '0.1.0';
	if (!semanticTag.test(previous)) throw new Error('Invalid previous release tag');
	let [major, minor, patch] = previous.slice(1).split('.').map(Number);
	if (
		messages.some(
			(m) => /^[a-z]+(?:\([^\r\n()]+\))?!: /.test(m) || /^BREAKING[ -]CHANGE: /m.test(m)
		)
	) {
		major++;
		minor = patch = 0;
	} else if (messages.some((m) => /^feat(?:\([^\r\n()]+\))?: /.test(m))) {
		minor++;
		patch = 0;
	} else patch++;
	return `${major}.${minor}.${patch}`;
}

/**
 * Advances the patch version when rebuilding an already-released commit for OS updates.
 * @param {string | null} previous
 */
export function nextRebuildVersion(previous) {
	if (previous === null) return '0.1.0';
	if (!semanticTag.test(previous)) throw new Error('Invalid previous release tag');
	const [major, minor, patch] = previous.slice(1).split('.').map(Number);
	return `${major}.${minor}.${patch + 1}`;
}

/**
 * Resolves whether to publish and what semantic version to release.
 * @param {{
 *   tags: string[],
 *   sameCommitTags: string[],
 *   hasRelease: (tag: string) => Promise<boolean>,
 *   getMessages: (previous: string | null) => string[],
 *   rebuild?: boolean
 * }} options
 */
export async function resolveReleasePlan({
	tags,
	sameCommitTags,
	hasRelease,
	getMessages,
	rebuild = false
}) {
	const sorted = tags.filter((t) => semanticTag.test(t)).sort(compareSemanticTags);
	const sameSet = new Set(sameCommitTags);
	const latestSameCommitTag = [...sorted].reverse().find((t) => sameSet.has(t)) ?? null;
	const published = latestSameCommitTag ? await hasRelease(latestSameCommitTag) : false;
	if (published && !rebuild) return { publish: false };
	const previous = sorted.at(-1) ?? null;
	const version =
		published && rebuild
			? nextRebuildVersion(previous)
			: latestSameCommitTag
				? latestSameCommitTag.slice(1)
				: nextVersion(previous, getMessages(previous));
	return { publish: true, version, tag: `v${version}` };
}

/** @param {string[]} args */
function git(...args) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** @param {string} path */
async function api(path) {
	const response = await fetch(
		`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`,
		{
			headers: {
				Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
				Accept: 'application/vnd.github+json'
			}
		}
	);
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`GitHub API failed (${response.status})`);
	return response.json();
}

/** @param {string} name */
function requiredEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

async function main() {
	const [command, ...flags] = process.argv.slice(2);
	if (command === 'title') {
		if (flags.length) throw new Error('Unexpected arguments for title');
		const event = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8'));
		if (event.pull_request && !validTitle(event.pull_request.title))
			throw new Error('Use a Conventional Commit PR title, for example fix: correct a thumbnail');
		return;
	}
	if (command !== 'plan' || flags.some((flag) => flag !== '--rebuild'))
		throw new Error('Expected title or plan [--rebuild]');
	const rebuild = flags.includes('--rebuild');
	const sha = requiredEnv('GITHUB_SHA');
	if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Invalid release commit');
	const remote = await api('git/ref/heads/main');
	if (remote?.object.sha !== sha) {
		appendFileSync(requiredEnv('GITHUB_OUTPUT'), 'publish=false\n');
		return;
	}
	const tags = git('tag', '--merged', sha).split('\n').filter(Boolean);
	const sameCommitTags = git('tag', '--points-at', sha).split('\n').filter(Boolean);
	const plan = await resolveReleasePlan({
		tags,
		sameCommitTags,
		rebuild,
		hasRelease: async (tag) => Boolean(await api(`releases/tags/${tag}`)),
		getMessages: (previous) =>
			git('log', '--format=%B%x00', previous ? `${previous}..${sha}` : sha)
				.split('\0')
				.map((s) => s.trim())
				.filter(Boolean)
	});
	if (!plan.publish) {
		appendFileSync(requiredEnv('GITHUB_OUTPUT'), 'publish=false\n');
		return;
	}
	appendFileSync(
		requiredEnv('GITHUB_OUTPUT'),
		`publish=true\nversion=${plan.version}\ntag=${plan.tag}\n`
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
