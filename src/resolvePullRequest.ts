import type { Context } from 'probot';
import type { Log } from './logger';

export interface ResolvedPullRequest {
	number: number;
	baseOwner: string;
	baseRepo: string;
}

interface PullRequestLike {
	number: number;
	state: string;
	head: { sha: string };
	base: { repo: { name: string; owner: { login: string } | null } | null };
}

/**
 * Finds the open pull request a check suite belongs to.
 *
 * Every candidate has to match `headSha`, which is what makes the answer unambiguous: several
 * open PRs can share a head branch name, but only one has that commit at its tip. Without the
 * invariant the lookup could report on one PR and merge another.
 */
export const resolvePullRequestForHead = async (
	octokit: Context['octokit'],
	event: { owner: string; repo: string },
	headSha: string,
	headBranch: string | null,
	hints: { number: number }[],
	log: Log,
): Promise<ResolvedPullRequest | null> => {
	const resolved = (pr: PullRequestLike): ResolvedPullRequest => ({
		number: pr.number,
		baseOwner: pr.base.repo?.owner?.login ?? event.owner,
		baseRepo: pr.base.repo?.name ?? event.repo,
	});

	const matches = (pr: PullRequestLike) => pr.state === 'open' && pr.head.sha === headSha;

	// The check suite names its own pull requests, but without a state, so confirm each one.
	for (const hint of hints) {
		try {
			const pr = await octokit.pulls.get({ ...event, pull_number: hint.number });
			if (matches(pr.data)) {
				return resolved(pr.data);
			}
		} catch (error) {
			log.debug({ err: error, prNumber: hint.number }, 'hinted pull request could not be read');
		}
	}

	// The only lookup that works for forks: the head commit is reachable from the base repository.
	try {
		const associated = await octokit.repos.listPullRequestsAssociatedWithCommit({ ...event, commit_sha: headSha });
		const match = associated.data.find(matches);
		if (match) {
			return resolved(match);
		}
	} catch (error) {
		log.debug({ err: error, headSha }, 'commit not found in the base repository, probably from a fork');
	}

	if (headBranch) {
		const byBranch = await octokit.paginate(octokit.pulls.list, {
			...event,
			state: 'open',
			head: `${event.owner}:${headBranch}`,
			sort: 'updated',
			direction: 'desc',
			per_page: 100,
		});
		const match = byBranch.find(matches);
		if (match) {
			return resolved(match);
		}
	}

	log.debug({ headSha, headBranch }, 'no open pull request has this commit at its head');
	return null;
};
