// import { cherryPickCommits } from "github-cherry-pick";
import { Context } from 'probot';
import { addPrToProject } from './addPrToProject';
import { createPullRequest } from './createPullRequest';
import type { Log } from './logger';

const getProject = async (context: Context, release: string, log: Log) => {
	const project = await getProjectsV2(context, release);
	if (project) {
		log.debug({ projectId: project.id, title: project.title }, 'project found');
		return project;
	}

	const projectCreated = await createProjectV2(
		context,
		release,
		'MDEyOk9yZ2FuaXphdGlvbjEyNTA4Nzg4', // ?? context.repo().owner,
	);

	const created = projectCreated.createProjectV2.projectV2;
	log.info({ projectId: created.id, title: created.title }, 'project created');
	return created;
};

const getReleaseBranchSha = async (context: Context, release: string, base: string, log: Log, workflowTarget?: string) => {
	const branch = await context.octokit.git
		.getRef({
			...context.repo(),
			ref: `heads/release-${release}`,
		})
		.catch(() => undefined);

	if (branch?.data) {
		return branch.data.object.sha;
	}

	const commitBase = await context.octokit.repos.getCommit({
		...context.repo(),
		ref: base,
	});

	const ref = `refs/heads/release-${release}`;
	const branchCreated = (
		await context.octokit.git.createRef({
			...context.repo(),
			ref,
			sha: commitBase.data.sha,
		})
	).data.object.sha;
	log.info({ ref, sha: branchCreated }, 'release branch created');

	await triggerWorkflow(context, workflowTarget ?? base);
	log.info({ base: workflowTarget ?? base }, 'release workflow dispatched');

	return branchCreated;
};

export const upsertProject = async (
	context: Context,
	release: string,
	pr: {
		id: string;
		sha: string | null;
		number: number;
		title: string;
		author: string;
	},
	base: string,
	assignee: string,
	log: Log,
	workflowTarget?: string,
) => {
	const project = await getProject(context, release, log);

	if (!project) {
		throw new Error('Something went wrong during getProject');
	}

	const releaseBranch = await getReleaseBranchSha(context, release, base, log, workflowTarget);

	log.debug({ release, base, pr: { number: pr.number, sha: pr.sha } }, 'upserting project');

	/**
	 * Creates the patch branch
	 * Created the pull request based on the new branch
	 * cherry-picks the old pr into the new one
	 */

	if (pr.sha !== null) {
		const pullRequest = await createPullRequest(context, release, { ...pr, sha: pr.sha }, releaseBranch, base, assignee, log);

		await addPrToProject(context, pr.id, project.id, log);

		await addPrToProject(context, pullRequest.data.node_id, project.id, log);

		await context.octokit.issues.createComment({
			...context.issue(),
			body: `Pull request #${pullRequest.data.number} added to Project: "${project.title}"`,
		});
		log.info({ backportPr: pullRequest.data.number, project: project.title }, 'pull requests added to project');
	}
};

const createProjectV2 = async (context: Context, release: string, owner: string) =>
	(await context.octokit.graphql({
		query: `
            mutation{
              createProjectV2(
                input: {
                  ownerId: "${owner}",
                  title: "Patch ${release}",
                }
              ){
                projectV2 {
                  id
                  title
                }
              }
            }
          `,
	})) as {
		createProjectV2: {
			projectV2: {
				id: string;
				title: string;
			};
		};
	};

export const getProjectsV2 = async (context: Context, release: string) => {
	const repo = await context.octokit.repos.get(context.repo());
	const login = repo.data.owner.login;
	const projects = (await context.octokit.graphql({
		query: `query{
          organization(login: "${login}"){
            projectsV2(first: 100, query: "is:open in:title ${release}") {
              nodes {
                id
                title
                number
              }
            }
          }}`,
	})) as {
		organization: {
			projectsV2: {
				nodes: {
					id: string;
					title: string;
					number: number;
				}[];
			};
		};
	};

	const project = projects.organization.projectsV2.nodes.find((project) => project.title === `Patch ${release}`);

	return project;
};

const triggerWorkflow = async (context: Context, base = 'master') =>
	context.octokit.actions.createWorkflowDispatch({
		...context.repo(),
		inputs: {
			'name': 'patch',
			'base-ref': base,
		},
		ref: 'refs/heads/develop',
		workflow_id: 'release.yml',
	});
