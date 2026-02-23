import { Probot, Context } from 'probot';
import { applyLabels } from './handleQALabels';
import { handlePatch } from './handlePatch';
import { handleBackport } from './handleBackport';
import { run } from './Queue';
import { consoleProps } from './createPullRequest';
import { handleRebase } from './handleRebase';
import { handleJira, isJiraTaskKey } from './handleJira';
import { runQAChecks, formatCheckRunOutput, CHECK_RUN_NAME, type PullRequestForQA } from './qaChecks';

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

		try {
			const { owner, repo } = context.repo();
			await runDionisioQACheckForRef(context.octokit, owner, repo, pr.data.head.sha, pr.data.head.ref);
		} catch (error) {
			console.log(error);
		}
	});

	app.on(
		['pull_request.opened', 'pull_request.synchronize', 'pull_request.edited', 'pull_request.labeled', 'pull_request.unlabeled'],
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

			try {
				const { owner, repo } = context.repo();
				const { head } = context.payload.pull_request;
				await runDionisioQACheckForRef(context.octokit, owner, repo, head.sha, head.ref);
			} catch (error) {
				console.log(error);
			}
		},
	);

	app.on(['issue_comment.created'], async (context): Promise<void> => {
		const { comment, issue } = context.payload;
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

		if (command === 'jira') {
			if (!args?.trim()) {
				// reacts with thinking face
				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: 'confused',
				});
				return;
			}
			const rawArg = args.trim().replace(/^["']|["']$/g, '');
			const asSubtask = isJiraTaskKey(rawArg);

			await context.octokit.reactions.createForIssueComment({
				...context.issue(),
				comment_id: comment.id,
				content: 'eyes',
			});

			try {
				await handleJira({
					context,
					boardName: rawArg,
					...(asSubtask ? { parentTaskKey: rawArg } : {}),
					pr: {
						number: issue.number,
						title: issue.title,
						body: issue.body,
						html_url: issue.html_url,
						labels: issue.labels.map((label) => label.name),
						milestone: issue.milestone?.title ?? undefined,
						user: issue.user,
					},
					requestedBy: comment.user.login,
					commentId: comment.id,
				});

				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: '+1',
				});
			} catch (e) {
				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: '-1',
				});
				console.log('handleJira->', e);
			} finally {
				await context.octokit.reactions.deleteForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: 'eyes',
				});
			}
		}

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

	async function runDionisioQACheckForRef(
		octokit: Context['octokit'],
		owner: string,
		repo: string,
		headSha: string,
		headBranch: string,
	): Promise<void> {
		const startTime = new Date();
		const repoParams = { owner, repo };

		const prs = await octokit.pulls.list({
			...repoParams,
			state: 'open',
			head: `${owner}:${headBranch}`,
			sort: 'updated',
			direction: 'desc',
			per_page: 1,
		});

		const pr = prs.data[0];
		if (!pr) {
			await octokit.checks.create({
				...repoParams,
				name: CHECK_RUN_NAME,
				head_sha: headSha,
				status: 'completed',
				started_at: startTime.toISOString(),
				completed_at: new Date().toISOString(),
				conclusion: 'neutral',
				output: {
					title: 'No open PR',
					summary: 'There is no open pull request for this branch. Open a PR to run Dionisio QA checks.',
				},
			});
			return;
		}

		const fullPr = await octokit.pulls.get({ ...repoParams, pull_number: pr.number });
		const prForQA: PullRequestForQA = {
			mergeable: fullPr.data.mergeable ?? undefined,
			labels: fullPr.data.labels.map((l) => ({ name: (l as { name: string }).name })),
			mergeable_state: fullPr.data.mergeable_state ?? 'unknown',
			milestone: fullPr.data.milestone?.title,
			url: fullPr.data.html_url ?? fullPr.data.url,
			number: fullPr.data.number,
		};

		const result = await runQAChecks(prForQA, owner, repo, fullPr.data.head.ref, octokit);

		if (!result) {
			const runs = await octokit.checks.listForRef({ ...repoParams, ref: headSha });
			const existing = runs.data.check_runs.find((r) => r.name === CHECK_RUN_NAME);
			if (existing) {
				await octokit.checks.update({
					...repoParams,
					check_run_id: existing.id,
					conclusion: 'neutral',
					output: { title: 'Could not run checks', summary: 'Dionisio QA could not run.' },
				});
			} else {
				await octokit.checks.create({
					...repoParams,
					name: CHECK_RUN_NAME,
					head_sha: headSha,
					status: 'completed',
					started_at: startTime.toISOString(),
					completed_at: new Date().toISOString(),
					conclusion: 'neutral',
					output: {
						title: 'Could not run checks',
						summary: 'Dionisio QA could not run (e.g. missing package.json on base ref).',
					},
				});
			}
			return;
		}

		const { title, summary } = formatCheckRunOutput(result);
		const runs = await octokit.checks.listForRef({ ...repoParams, ref: headSha });
		const existing = runs.data.check_runs.find((r) => r.name === CHECK_RUN_NAME);

		if (existing) {
			await octokit.checks.update({
				...repoParams,
				check_run_id: existing.id,
				conclusion: result.readyToMerge ? 'success' : 'failure',
				output: { title, summary },
				completed_at: new Date().toISOString(),
			});
		} else {
			await octokit.checks.create({
				...repoParams,
				name: CHECK_RUN_NAME,
				head_sha: headSha,
				status: 'completed',
				started_at: startTime.toISOString(),
				completed_at: new Date().toISOString(),
				conclusion: result.readyToMerge ? 'success' : 'failure',
				output: { title, summary },
			});
		}
	}

	async function runDionisioQACheck(context: Context<'check_suite.requested' | 'check_suite.rerequested'>) {
		const { head_branch: headBranch, head_sha: headSha } = context.payload.check_suite;
		const { owner, repo } = context.repo();
		await runDionisioQACheckForRef(context.octokit, owner, repo, headSha, headBranch ?? headSha);
	}

	app.on(['check_suite.requested'], async function check(context) {
		await runDionisioQACheck(context);
	});

	app.on(['check_suite.rerequested'], async function check(context) {
		const checkRuns = await context.octokit.checks.listForSuite(
			context.repo({
				check_suite_id: context.payload.check_suite.id,
			}),
		);

		const dionisioRun = checkRuns.data.check_runs.find((r) => r.name === CHECK_RUN_NAME);
		if (!dionisioRun) {
			await runDionisioQACheck(context);
			return;
		}

		const { owner, repo } = context.repo();
		const prs = await context.octokit.pulls.list({
			owner,
			repo,
			state: 'open',
			head: `${owner}:${context.payload.check_suite.head_branch}`,
			sort: 'updated',
			direction: 'desc',
			per_page: 1,
		});

		const pr = prs.data[0];
		if (!pr) {
			await context.octokit.checks.update(
				context.repo({
					name: CHECK_RUN_NAME,
					check_run_id: dionisioRun.id,
					conclusion: 'neutral',
					output: {
						title: 'No open PR',
						summary: 'There is no open pull request for this branch.',
					},
				}),
			);
			return;
		}

		const fullPr = await context.octokit.pulls.get({
			owner,
			repo,
			pull_number: pr.number,
		});

		const prForQA: PullRequestForQA = {
			mergeable: fullPr.data.mergeable ?? undefined,
			labels: fullPr.data.labels.map((l) => ({ name: (l as { name: string }).name })),
			mergeable_state: fullPr.data.mergeable_state ?? 'unknown',
			milestone: fullPr.data.milestone?.title,
			url: fullPr.data.html_url ?? fullPr.data.url,
			number: fullPr.data.number,
		};

		const result = await runQAChecks(prForQA, owner, repo, fullPr.data.head.ref, context.octokit);

		if (!result) {
			await context.octokit.checks.update(
				context.repo({
					name: CHECK_RUN_NAME,
					check_run_id: dionisioRun.id,
					conclusion: 'neutral',
					output: {
						title: 'Could not run checks',
						summary: 'Dionisio QA could not run.',
					},
				}),
			);
			return;
		}

		const { title, summary } = formatCheckRunOutput(result);
		await context.octokit.checks.update(
			context.repo({
				name: CHECK_RUN_NAME,
				check_run_id: dionisioRun.id,
				conclusion: result.readyToMerge ? 'success' : 'failure',
				output: { title, summary },
				completed_at: new Date().toISOString(),
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
