import type { Context } from 'probot';
import type { Log } from './logger';

export type MergeStrategy = 'queue' | 'auto-merge' | 'squash';

export type StrategySkipReason = 'merge-queue-unknown' | 'squash-disabled' | 'squash-not-clean';

export interface MergeCapabilities {
	/** `null` when the lookup failed — treated as "there might be a queue", never as "there isn't". */
	hasMergeQueue: boolean | null;
	allowAutoMerge: boolean;
	mergeableState: string;
	allowDirectSquash: boolean;
}

export type StrategyChoice = { strategy: MergeStrategy } | { skip: StrategySkipReason };

/**
 * Picks how to merge from what the branch actually supports, rather than discovering it by
 * failing. The old ladder tried the merge queue, then auto-merge, then an immediate squash, and
 * could not tell "this branch has no merge queue" from "the queue refused this PR" — so a
 * rejected enqueue fell through to a squash that bypassed the queue entirely.
 */
export const chooseMergeStrategy = (caps: MergeCapabilities): StrategyChoice => {
	// A branch with a queue is merged through the queue or not at all.
	if (caps.hasMergeQueue === true) {
		return { strategy: 'queue' };
	}

	if (caps.allowAutoMerge) {
		return { strategy: 'auto-merge' };
	}

	// Without a definite answer, never take the path that bypasses a queue.
	if (caps.hasMergeQueue === null) {
		return { skip: 'merge-queue-unknown' };
	}

	if (!caps.allowDirectSquash) {
		return { skip: 'squash-disabled' };
	}

	// `clean` is GitHub's own "every branch protection requirement is satisfied".
	if (caps.mergeableState !== 'clean') {
		return { skip: 'squash-not-clean' };
	}

	return { strategy: 'squash' };
};

const MERGE_QUEUE_QUERY = `query ($owner: String!, $repo: String!, $branch: String!) {
	repository(owner: $owner, name: $repo) {
		mergeQueue(branch: $branch) {
			id
		}
	}
}`;

const CAPABILITY_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { capabilities: Omit<MergeCapabilities, 'mergeableState' | 'allowDirectSquash'>; expiresAt: number }>();

/**
 * Branch protection and repository settings change rarely, so this is cached briefly to keep two
 * extra calls off the hot path of every check suite completion.
 */
export const getMergeCapabilities = async (
	octokit: Context['octokit'],
	owner: string,
	repo: string,
	baseRef: string,
	log: Log,
): Promise<Omit<MergeCapabilities, 'mergeableState' | 'allowDirectSquash'>> => {
	const key = `${owner}/${repo}#${baseRef}`;
	const cached = cache.get(key);

	if (cached && cached.expiresAt > Date.now()) {
		return cached.capabilities;
	}

	const [hasMergeQueue, allowAutoMerge] = await Promise.all([
		(async (): Promise<boolean | null> => {
			try {
				const result = (await octokit.graphql(MERGE_QUEUE_QUERY, { owner, repo, branch: baseRef })) as {
					repository?: { mergeQueue?: { id?: string } | null } | null;
				};
				return Boolean(result.repository?.mergeQueue?.id);
			} catch (error) {
				log.warn({ err: error, owner, repo, baseRef }, 'could not determine whether the base branch has a merge queue');
				return null;
			}
		})(),
		(async (): Promise<boolean> => {
			try {
				const { data } = await octokit.repos.get({ owner, repo });
				return Boolean(data.allow_auto_merge);
			} catch (error) {
				log.warn({ err: error, owner, repo }, 'could not read the repository merge settings');
				return false;
			}
		})(),
	]);

	const capabilities = { hasMergeQueue, allowAutoMerge };
	cache.set(key, { capabilities, expiresAt: Date.now() + CAPABILITY_TTL_MS });

	return capabilities;
};
