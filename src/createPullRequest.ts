import { Context } from 'probot';
import { cherryPick } from './cherryPick';
import { ErrorCherryPickConflict } from './errors/ErrorCherryPickConflict';
import type { Log } from './logger';

export const createPullRequest = async (
	context: Context,
	release: string,
	pr: {
		id: string;
		sha: string;
		number: number;
		title: string;
		author: string;
	},
	commit_sha: string,
	base: string,
	assignee: string,
	log: Log,
) => {
	const milestone = (
		await context.octokit.issues.listMilestones({
			...context.repo(),
			direction: 'desc',
			state: 'all',
		})
	).data.find((tag) => {
		const [major, minor] = release.split('.');
		return tag.title === `${major}.${minor}`;
	});

	const head = `backport-${release}-${pr.number}`;

	log.debug({ head, sha: commit_sha }, 'creating backport ref');
	const ref = await context.octokit.git
		.createRef({
			...context.repo(),
			ref: `refs/heads/${head}`,
			sha: commit_sha,
		})
		.catch((error: unknown) => {
			log.debug({ err: error, head }, 'backport ref not created, assuming it already exists');
			return undefined;
		});

	/**
	 * if the ref was created we should try to cherry pick
	 * if not just open the pull request
	 */
	if (ref) {
		try {
			await cherryPick({
				context,
				commits: [pr.sha],
				head,
				log,
			});
		} catch (e) {
			log.warn({ err: e, head, commits: [pr.sha] }, 'cherry-pick failed, reporting conflict');
			throw new ErrorCherryPickConflict({
				...context.repo(),
				commits: [pr.sha],
				head,
				base,
			});
		}
	}

	const pullRequest = await context.octokit.pulls.create({
		...context.repo(),
		title: pr.title,
		head,
		base: `release-${release}`,
		body: `Backport of #${pr.number}`,
	});
	log.info({ backportPr: pullRequest.data.number, head, release }, 'backport pull request created');

	await context.octokit.pulls.requestReviewers({
		...context.repo(),
		pull_number: pullRequest.data.number,
		reviewers: [pr.author],
	});

	await context.octokit.issues
		.update({
			...context.repo(),
			issue_number: pullRequest.data.number,
			...(milestone?.number && { milestone: milestone.number }),
			assignees: [assignee],
		})
		.catch((error: unknown) => {
			log.warn({ err: error, backportPr: pullRequest.data.number }, 'could not set milestone and assignee on backport pull request');
		});

	await context.octokit.issues.addLabels({
		...context.repo(),
		issue_number: pullRequest.data.number,
		labels: ['backport'],
	});

	return pullRequest;
};
