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

/** @param {string | null} previous @param {string[]} messages */
export function nextVersion(previous, messages) {
	if (!messages.length) throw new Error('No commits to release');
	if (previous === null) return '0.1.0';
	if (!semanticTag.test(previous)) throw new Error('Invalid previous release tag');
	let [major, minor, patch] = previous.slice(1).split('.').map(Number);
	if (
		messages.some(
			(m) => /^[a-z]+(?:\([^\r\n()]+\))?!: /m.test(m) || /^BREAKING[ -]CHANGE: /m.test(m)
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
	if (process.argv[2] === 'title') {
		const event = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8'));
		if (event.pull_request && !validTitle(event.pull_request.title))
			throw new Error('Use a Conventional Commit PR title, for example fix: correct a thumbnail');
		return;
	}
	if (process.argv[2] !== 'plan') throw new Error('Expected title or plan');
	const sha = requiredEnv('GITHUB_SHA');
	if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Invalid release commit');
	const remote = await api('git/ref/heads/main');
	if (remote?.object.sha !== sha) {
		appendFileSync(requiredEnv('GITHUB_OUTPUT'), 'publish=false\n');
		return;
	}
	const tags = git('tag', '--merged', sha)
		.split('\n')
		.filter((t) => semanticTag.test(t));
	tags.sort((a, b) => {
		const av = a.slice(1).split('.').map(Number),
			bv = b.slice(1).split('.').map(Number);
		return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
	});
	const sameCommitTag = tags.find((tag) => git('rev-list', '-n', '1', tag) === sha);
	if (sameCommitTag && (await api(`releases/tags/${sameCommitTag}`))) {
		appendFileSync(requiredEnv('GITHUB_OUTPUT'), 'publish=false\n');
		return;
	}
	const previous = tags.at(-1) ?? null;
	const messages = git('log', '--format=%B%x00', previous ? `${previous}..${sha}` : sha)
		.split('\0')
		.map((s) => s.trim())
		.filter(Boolean);
	const version = sameCommitTag?.slice(1) ?? nextVersion(previous, messages);
	appendFileSync(
		requiredEnv('GITHUB_OUTPUT'),
		`publish=true\nversion=${version}\ntag=v${version}\n`
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
