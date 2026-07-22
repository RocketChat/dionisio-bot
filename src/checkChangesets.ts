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

/** Conventional-commit breaking marker: `feat!: ...` or `feat(scope)!: ...` */
export const titleIndicatesBreaking = (title?: string): boolean => /^\w+(\([^)]*\))?!:/.test(title ?? '');

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

export const findChangesetProblems = (
	files: { filename: string; bumps: Bump[] }[],
	milestone: string | undefined,
	title: string | undefined,
): string[] => {
	const problems: string[] = [];

	const maxBump = maxBumpForMilestone(milestone);
	const invalid = maxBump && maxBump !== 'major' ? findInvalidBumps(files, maxBump) : [];
	if (invalid.length > 0) {
		problems.push(
			[
				`The milestone \`${milestone}\` only allows \`${maxBump}\` (or lower) changesets, but:`,
				'',
				...invalid.map(({ filename, invalid: bumps }) => `- \`${filename}\` declares \`${bumps.join('`, `')}\``),
			].join('\n'),
		);
	}

	const hasMajor = files.some(({ bumps }) => bumps.includes('major'));
	const breakingTitle = titleIndicatesBreaking(title);
	if (breakingTitle && !hasMajor) {
		problems.push('The PR title indicates a breaking change (`!`), but no changeset declares a `major` bump — at least one is required.');
	}
	if (!breakingTitle && hasMajor) {
		problems.push(
			'A changeset declares a `major` bump, but the PR title does not indicate a breaking change (use `type!: ...` or `type(scope)!: ...`).',
		);
	}

	return problems;
};

const formatReviewBody = (problems: string[]): string =>
	[`### Changeset mismatch`, '', ...problems.flatMap((problem) => [problem, '']), `Please align the PR title, milestone and changesets.`].join(
		'\n',
	);

/**
 * Requests changes when the PR title, milestone and changesets disagree about
 * the release bump (breaking change or bump higher than the milestone allows),
 * and dismisses that review once they are aligned.
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
		title?: string;
		milestone?: string;
		head: { owner: string; repo: string; sha: string };
	};
}): Promise<void> => {
	const files = await getChangesetFiles(octokit, owner, repo, pr.number, pr.head);
	const problems = findChangesetProblems(files, pr.milestone, pr.title);

	const reviews = await octokit.pulls.listReviews({ owner, repo, pull_number: pr.number });
	const botReview = reviews.data.find((review) => review.user?.login === GITHUB_LOGIN && review.state === 'CHANGES_REQUESTED');

	if (problems.length === 0) {
		if (botReview) {
			await octokit.pulls.dismissReview({
				owner,
				repo,
				pull_number: pr.number,
				review_id: botReview.id,
				message: 'Changesets now match the title and milestone',
			});
		}
		return;
	}

	const body = formatReviewBody(problems);

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
