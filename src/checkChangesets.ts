import type { Context } from 'probot';

const { GITHUB_LOGIN = 'dionisio-bot[bot]' } = process.env;

export type Bump = 'patch' | 'minor' | 'major';

const BUMP_RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

/**
 * Milestone x.y.z with z > 0 only allows patch bumps;
 * x.y.0 allows up to minor; x.0.0 allows major.
 * Milestones without a version (e.g. "Backlog") impose no restriction.
 */
export const maxBumpForMilestone = (milestone?: string): Bump | null => {
	const match = milestone?.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
	if (!match) {
		return null;
	}
	if (parseInt(match[3] ?? '0') > 0) {
		return 'patch';
	}
	if (parseInt(match[2]) > 0) {
		return 'minor';
	}
	return 'major';
};

export const parseChangesetBumps = (content: string): Bump[] => {
	const [, frontmatter] = content.match(/^---\r?\n([\s\S]*?)\r?\n---/) ?? [];
	if (!frontmatter) {
		return [];
	}
	return [...frontmatter.matchAll(/:\s*['"]?(patch|minor|major)['"]?\s*$/gm)].map((m) => m[1] as Bump);
};

export const findInvalidBumps = (files: { filename: string; bumps: Bump[] }[], maxBump: Bump): { filename: string; invalid: Bump[] }[] =>
	files
		.map(({ filename, bumps }) => ({
			filename,
			invalid: bumps.filter((bump) => BUMP_RANK[bump] > BUMP_RANK[maxBump]),
		}))
		.filter(({ invalid }) => invalid.length > 0);

const isChangesetFile = (filename: string) => /^\.changeset\/[^/]+\.md$/.test(filename) && filename !== '.changeset/README.md';

const getChangesetFiles = async (
	octokit: Context['octokit'],
	owner: string,
	repo: string,
	prNumber: number,
	head: { owner: string; repo: string; sha: string },
): Promise<{ filename: string; bumps: Bump[] }[]> => {
	const files = await octokit.paginate(octokit.pulls.listFiles, {
		owner,
		repo,
		pull_number: prNumber,
		per_page: 100,
	});

	const changesets = files.filter((file) => isChangesetFile(file.filename) && file.status !== 'removed');

	return Promise.all(
		changesets.map(async ({ filename }) => {
			const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
				owner: head.owner,
				repo: head.repo,
				path: filename,
				ref: head.sha,
				headers: {
					'Accept': 'application/vnd.github.raw+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			});
			return { filename, bumps: typeof data === 'string' ? parseChangesetBumps(data) : [] };
		}),
	);
};

const formatReviewBody = (milestone: string, maxBump: Bump, invalid: { filename: string; invalid: Bump[] }[]): string =>
	[
		`### Changeset x Milestone mismatch`,
		'',
		`The milestone \`${milestone}\` only allows \`${maxBump}\` (or lower) changesets, but:`,
		'',
		...invalid.map(({ filename, invalid: bumps }) => `- \`${filename}\` declares \`${bumps.join('`, `')}\``),
		'',
		`Please adjust the changeset bump or the milestone.`,
	].join('\n');

/**
 * Requests changes when a changeset declares a bump higher than the milestone allows,
 * and dismisses that review once the changesets (or milestone) are fixed.
 */
export const enforceChangesetMilestone = async ({
	octokit,
	owner,
	repo,
	pr,
}: {
	octokit: Context['octokit'];
	owner: string;
	repo: string;
	pr: {
		number: number;
		milestone?: string;
		head: { owner: string; repo: string; sha: string };
	};
}): Promise<void> => {
	const maxBump = maxBumpForMilestone(pr.milestone);

	const invalid =
		maxBump && maxBump !== 'major' ? findInvalidBumps(await getChangesetFiles(octokit, owner, repo, pr.number, pr.head), maxBump) : [];

	const reviews = await octokit.pulls.listReviews({ owner, repo, pull_number: pr.number });
	const botReview = reviews.data.find((review) => review.user?.login === GITHUB_LOGIN && review.state === 'CHANGES_REQUESTED');

	if (invalid.length === 0) {
		if (botReview) {
			await octokit.pulls.dismissReview({
				owner,
				repo,
				pull_number: pr.number,
				review_id: botReview.id,
				message: 'Changesets now match the milestone',
			});
		}
		return;
	}

	const body = formatReviewBody(pr.milestone as string, maxBump as Bump, invalid);

	if (botReview?.body === body) {
		return;
	}

	await octokit.pulls.createReview({
		owner,
		repo,
		pull_number: pr.number,
		event: 'REQUEST_CHANGES',
		body,
	});

	if (botReview) {
		await octokit.pulls.dismissReview({
			owner,
			repo,
			pull_number: pr.number,
			review_id: botReview.id,
			message: 'Superseded by an updated review',
		});
	}
};
