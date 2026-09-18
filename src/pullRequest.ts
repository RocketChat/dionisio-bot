import type { Context } from 'probot';
import type { Log } from './logger';

const MERGEABILITY_ATTEMPTS = 3;
const MERGEABILITY_DELAY_MS = 1_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitHub computes mergeability asynchronously and reports `null` until it is ready.
 * Asking for the pull request is what triggers that computation, so re-requesting it is the
 * documented way out of the unknown state. Capped well inside the 9s webhook budget.
 */
export const getPullRequestWithMergeability = async (
	octokit: Context['octokit'],
	params: { owner: string; repo: string; pull_number: number },
	log: Log,
) => {
	let pr = await octokit.pulls.get(params);

	for (let attempt = 1; pr.data.mergeable === null && attempt < MERGEABILITY_ATTEMPTS; attempt++) {
		await delay(MERGEABILITY_DELAY_MS * attempt);
		pr = await octokit.pulls.get(params);
	}

	if (pr.data.mergeable === null) {
		log.warn({ ...params }, 'mergeability still unknown after retries');
	}

	return pr;
};
