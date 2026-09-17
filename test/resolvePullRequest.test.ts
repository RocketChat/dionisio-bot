import { resolvePullRequestForHead } from '../src/resolvePullRequest';
import type { Log } from '../src/logger';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Log;

const HEAD_SHA = 'aaaaaaa';
const EVENT = { owner: 'RocketChat', repo: 'Rocket.Chat' };

const pr = (number: number, overrides: Record<string, unknown> = {}) => ({
	number,
	state: 'open',
	head: { sha: HEAD_SHA },
	base: { repo: { name: 'Rocket.Chat', owner: { login: 'RocketChat' } } },
	...overrides,
});

const octokitWith = ({
	get,
	associated,
	list,
}: {
	get?: (n: number) => unknown;
	associated?: unknown[];
	list?: unknown[];
}) =>
	({
		pulls: {
			get: async ({ pull_number }: { pull_number: number }) => {
				if (!get) throw new Error('not found');
				return { data: get(pull_number) };
			},
			list: {},
		},
		repos: {
			listPullRequestsAssociatedWithCommit: async () => {
				if (!associated) throw new Error('commit not in this repo');
				return { data: associated };
			},
		},
		paginate: async () => list ?? [],
	}) as never;

const resolve = (octokit: never, hints: { number: number }[] = [], branch: string | null = 'feature') =>
	resolvePullRequestForHead(octokit, EVENT, HEAD_SHA, branch, hints, silentLog);

describe('resolvePullRequestForHead', () => {
	test('uses the check suite hint when it matches the head sha', async () => {
		const result = await resolve(octokitWith({ get: (n) => pr(n) }), [{ number: 42 }]);

		expect(result).toEqual({ number: 42, baseOwner: 'RocketChat', baseRepo: 'Rocket.Chat' });
	});

	test('ignores a hint whose head has moved on', async () => {
		const octokit = octokitWith({
			get: (n) => pr(n, { head: { sha: 'stale' } }),
			associated: [pr(7)],
		});

		expect(await resolve(octokit, [{ number: 42 }])).toMatchObject({ number: 7 });
	});

	test('ignores a hint for a closed pull request', async () => {
		const octokit = octokitWith({
			get: (n) => pr(n, { state: 'closed' }),
			associated: [pr(7)],
		});

		expect(await resolve(octokit, [{ number: 42 }])).toMatchObject({ number: 7 });
	});

	// Fork PRs: check_suite carries no head_branch, and the head commit is only reachable
	// through the base repository's network.
	test('resolves a fork pull request via commit association', async () => {
		const octokit = octokitWith({ associated: [pr(99)] });

		expect(await resolve(octokit, [], null)).toMatchObject({ number: 99 });
	});

	test('carries the base repository across from a fork', async () => {
		const forked = pr(99, { base: { repo: { name: 'Rocket.Chat', owner: { login: 'RocketChat' } } } });
		const result = await resolve(octokitWith({ associated: [forked] }), [], null);

		expect(result).toEqual({ number: 99, baseOwner: 'RocketChat', baseRepo: 'Rocket.Chat' });
	});

	// The invariant: several open PRs can share a head branch name, only one has this commit.
	test('picks the pull request whose tip is the head sha, not the most recent', async () => {
		const octokit = octokitWith({
			list: [pr(1, { head: { sha: 'other' } }), pr(2), pr(3, { head: { sha: 'another' } })],
		});

		expect(await resolve(octokit)).toMatchObject({ number: 2 });
	});

	test('returns null for a superseded sha rather than guessing', async () => {
		const octokit = octokitWith({ list: [pr(1, { head: { sha: 'newer' } })] });

		expect(await resolve(octokit)).toBeNull();
	});

	test('returns null when nothing matches at all', async () => {
		expect(await resolve(octokitWith({}), [], null)).toBeNull();
	});
});
