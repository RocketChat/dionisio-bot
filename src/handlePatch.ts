import { Context } from 'probot';
import semver from 'semver';
import { upsertProject } from './upsertProject';
import { ErrorCherryPickConflict } from './errors/ErrorCherryPickConflict';
import type { Log } from './logger';
import { reportError } from './reportError';

export const handlePatch = async ({
	context,
	pr,
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
	assignee: string;
	log: Log;
}) => {
	const latestRelease = await context.octokit.repos.getLatestRelease(context.repo());

	const pathRelease = semver.inc(latestRelease.data.tag_name, 'patch');
	if (!pathRelease) {
		log.warn({ latestRelease: latestRelease.data.tag_name }, 'could not compute a patch version from the latest release');
		await context.octokit.issues.createComment({
			...context.issue(),
			body: 'Could not find a valid version to patch',
		});
		return;
	}

	log.info({ release: pathRelease, base: latestRelease.data.tag_name }, 'patch release requested');

	try {
		await upsertProject(
			context,
			pathRelease,
			{
				id: pr.node_id,
				sha: pr.merge_commit_sha,
				title: pr.title,
				number: pr.number,
				author: pr.author,
			},
			latestRelease.data.tag_name,
			assignee,
			log,
			'master',
		);
	} catch (err) {
		if (err instanceof ErrorCherryPickConflict) {
			log.warn({ err, release: pathRelease }, 'patch has cherry-pick conflicts');
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


after that just run \`/patch\` again
`,
			});
			return;
		}
		await reportError(context, log, err, { action: '/patch', extra: { release: pathRelease } });
	}
};
