import { Context } from 'probot';
import semver from 'semver';
import { upsertProject } from './upsertProject';
import { ErrorCherryPickConflict } from './errors/ErrorCherryPickConflict';
import type { Log } from './logger';
import { reportError } from './reportError';

export const handleBackport = async ({
	context,
	pr,
	tags,
	assignee,
	log,
}: {
	context: Context;
	pr: {
		merge_commit_sha: string | null;
		node_id: string;
		title: string;
		author: string;
		number: number;
	};
	tags: string[];
	assignee: string;
	log: Log;
}) => {
	if (tags.length === 0) {
		log.debug('backport requested without tags');
		await context.octokit.issues.createComment({
			...context.issue(),
			body: 'Please provide a list of tags to backport',
		});
		return;
	}

	// Filter out the tags that are already in the project

	try {
		await Promise.allSettled(
			tags.map(async (tag): Promise<void> => {
				const tagLog = log.child({ tag });
				const result = await context.octokit.repos
					.getReleaseByTag({
						...context.repo(),
						tag,
					})
					.catch(() => undefined);

				if (result?.data) {
					tagLog.info('release already exists, skipping backport');
					await context.octokit.issues.createComment({
						...context.issue(),
						body: `${tag} already exists in the project`,
					});
					return;
				}

				const ver = semver.patch(tag) - 1;

				if (ver < 0) {
					tagLog.debug('tag has no previous patch version, skipping');
					return;
				}

				const previousTag = semver.major(tag) + '.' + semver.minor(tag) + '.' + ver;

				tagLog.debug({ previousTag }, 'backporting');

				try {
					await context.octokit.repos.getReleaseByTag({
						...context.repo(),
						tag: previousTag,
					});
				} catch (err) {
					tagLog.warn({ err, previousTag }, 'previous release tag not found, aborting backport');
					throw err;
				}
				try {
					await upsertProject(
						context,
						tag,
						{
							id: pr.node_id,
							sha: pr.merge_commit_sha,
							title: pr.title,
							number: pr.number,
							author: pr.author,
						},
						previousTag,
						assignee,
						tagLog,
					);
				} catch (err) {
					if (err instanceof ErrorCherryPickConflict) {
						tagLog.warn({ err }, 'backport has cherry-pick conflicts');
						await context.octokit.issues.createComment({
							...context.issue(),
							body: `
  Sorry, I couldn't do that backport because of conflicts. Could you please solve them?

  you can do so by running the following commands:
  \`\`\`
  git fetch
  git checkout ${err.arg.head}
  git cherry-pick ${err.arg.commits.join(' ')}
  // solve the conflict
  git push
  \`\`\`


  after that just run \`/backport ${tag}\` again
  `,
						});
						return;
					}
					await reportError(context, tagLog, err, { action: `/backport ${tag}` });
				}
			}),
		);
	} catch (err) {
		log.error({ err }, 'backport failed');
	}
};
