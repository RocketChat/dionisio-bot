import { Probot } from 'probot';
import { applyLabels } from './handleQALabels';
import { handlePatch } from './handlePatch';
import { handleBackport } from './handleBackport';
import { run } from './Queue';
import { consoleProps } from './createPullRequest';
import { handleRebase } from './handleRebase';

export = (app: Probot) => {
	app.log.useLevelLabels = false;

	app.log.level = 'silent';

	app.on(['issues.milestoned', 'issues.demilestoned'], async (context): Promise<void> => {
		const { issue } = context.payload;

		if (!issue.pull_request) {
			return;
		}

		const pr = await context.octokit.pulls.get({
			...context.issue(),
			pull_number: issue.number,
		});

		if (pr.data.closed_at) {
			return;
		}

		await run(String(pr.data.number), () =>
			applyLabels(
				{
					...pr.data,
					milestone: pr.data.milestone?.title,
				},
				pr.data.head.repo?.owner.login ?? pr.data.base.repo.owner.login,
				pr.data.head.repo?.name ?? pr.data.base.repo.name,
				pr.data.base.ref,
				context,
			),
		);
	});

	app.on(
		['pull_request.opened', 'pull_request.synchronize', 'pull_request.labeled', 'pull_request.unlabeled'],
		async (context): Promise<void> => {
			if (context.payload.pull_request.closed_at) {
				return;
			}

			const { repo: ctxRepo } = context.payload.pull_request.head;

			if (!ctxRepo || !ctxRepo.owner || !ctxRepo.name) {
				return;
			}

			console.log(JSON.stringify(context.payload, null, 2));

			await run(String(context.payload.pull_request.number), () =>
				applyLabels(
					{
						...context.payload.pull_request,
						milestone: context.payload.pull_request.milestone?.title,
					},
					ctxRepo.owner.login,
					ctxRepo.name,
					context.payload.pull_request.head.ref,
					context,
				),
			);

			const { owner, repo } = context.repo();

			const suites = await context.octokit.checks.listSuitesForRef({
				owner,
				repo,
				ref: context.payload.pull_request.base.ref,
			});

			const suite = suites.data.check_suites.find((suite) => {
				return suite.app?.name === 'dionisio-bot';
			});

			if (!suite) {
				return;
			}

			try {
				await context.octokit.checks.rerequestSuite({
					owner,
					repo,
					check_suite_id: suite.id,
				});
			} catch (error) {
				console.log(error);
			}
		},
	);

	app.on(['issue_comment.created'], async (context): Promise<void> => {
		const { comment, issue } = context.payload;

		if (!issue.pull_request) {
			return;
		}

		const pr = await context.octokit.pulls.get({
			...context.issue(),
			pull_number: issue.number,
		});

		if (!pr.data) {
			return;
		}

		const orgs = await context.octokit.orgs.listForUser({
			username: comment.user.login,
		});

		if (!orgs.data.some(({ login }) => login === 'RocketChat')) {
			return;
		}

		const matcher = /^\/([\w]+)\b *(.*)?$/m;

		const [, command, args] = comment.body.match(matcher) || [];

		if (command === 'bark' || command === 'howl') {
			// add a reaction to the comment
			await context.octokit.reactions.createForIssueComment({
				...context.issue(),
				comment_id: comment.id,
				content: '+1',
			});

			await context.octokit.issues.createComment({
				...context.issue(),
				body: Math.random() > 0.5 ? 'AU AU' : 'woof',
			});
			return;
		}

		/**
		 * Gets the latest release of the repository
		 * check if exists a branch with the latest version
		 * triggers a workflow_dispatch event to create a new patch release
		 * creates a project with the latest version
		 */

		if (command === 'patch' && !args?.trim()) {
			// add a reaction to the comment
			await context.octokit.reactions.createForIssueComment({
				...context.issue(),
				comment_id: comment.id,
				content: '+1',
			});

			return handlePatch({
				context,
				pr: {
					...pr.data,
					author: pr.data.user?.login,
				},
				assignee: comment.user.login,
			});
		}
		if (command === 'backport' && args?.trim()) {
			const tags = args.split(' ').filter((arg) => /\d+\.\d+\.\d+/.test(arg));

			try {
				// add a reaction to the comment
				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: '+1',
				});

				await handleBackport({
					context,
					...consoleProps('handleBackport', {
						pr: { ...pr.data, author: pr.data.user?.login },
						tags,
						assignee: comment.user.login,
					}),
				});
			} catch (e) {
				// add a reaction to the comment
				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: '-1',
				});
				console.log('handleBackport->', e);
			}
			return;
		}

		if (command === 'rebase') {
			const [action, release, backportNumber] = pr.data.head.ref.split('-');

			if (action === 'backport' && /\d+\.\d+.\d+/.test(release) && Number.isInteger(parseInt(backportNumber))) {
				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: '+1',
				});

				await handleRebase(
					consoleProps('handleRebase ->>', {
						context,
						backportNumber: parseInt(backportNumber),
						release,
					}),
				);
			}
		}
	});

	app.on(['check_suite.requested'], async function check(context) {
		const startTime = new Date();
		// Do stuff
		const { head_branch: headBranch, head_sha: headSha } = context.payload.check_suite;

		console.log('AAAAAAAA->', headBranch, headSha);

		context.octokit.checks.create(
			context.repo({
				name: 'Auto label QA',
				head_branch: headBranch,
				head_sha: headSha,
				status: 'completed',
				started_at: startTime.toISOString(),
				conclusion: 'success',
				completed_at: new Date().toISOString(),
				output: {
					title: 'Labels are properly applied',
					summary: 'Labels are properly applied',
				},
			}),
		);
	});

	app.on(['check_suite.rerequested'], async function check(context) {
		const checkRuns = await context.octokit.checks.listForSuite(
			context.repo({
				check_suite_id: context.payload.check_suite.id,
			}),
		);

		await context.octokit.checks.update(
			context.repo({
				name: 'Auto label QA',
				conclusion: 'success',
				output: {
					title: 'Labels are properly applied',
					summary: 'Labels are properly applied',
				},
				check_run_id: checkRuns.data.check_runs[0].id,
			}),
		);
	});

	// app.on(["projects_v2_item.created"], (context) => {
	//   const card = context.payload;

	//   if (card.projects_v2_item.content_type !== "PullRequest") {
	//     return;
	//   }
	// });

	// app.on(["push"], async (context) => {
	//   if (!context.payload.base_ref?.startsWith("refs/heads/release")) {
	//     return;
	//   }

	//   const release = context.payload.base_ref.replace("refs/heads/release", "");

	//   const project = await getProjectsV2(context, release);

	//   if (!project) {
	//     return;
	//   }

	//   // List all cards in the project

	//   // Check if the card is already in the branch
	// });
};
// "pull_request.closed",
// "projects_v2_item.created",
// workflow_job.completed
// "workflow_run.completed"
