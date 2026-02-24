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

	function extractErrorMessage(error: unknown): string {
		const e = error as { status?: number; message?: string; errors?: { message?: string }[] };
		const parts: string[] = [];
		if (e.status) parts.push(`status=${e.status}`);
		if (e.message) parts.push(e.message);
		if (e.errors?.length) parts.push(e.errors.map((x) => x.message ?? JSON.stringify(x)).join('; '));
		return parts.join(' — ') || 'Unknown error';
	}

	async function mergePrWithSquash(octokit: Context['octokit'], owner: string, repo: string, pullNumber: number): Promise<string | null> {
		try {
			await octokit.pulls.merge({ owner, repo, pull_number: pullNumber, merge_method: 'squash' });
			return null;
		} catch (error: unknown) {
			console.log('mergePrWithSquash failed:', error);
			return extractErrorMessage(error);
		}
	}

	async function enableMergeWhenReady(octokit: Context['octokit'], pullRequestNodeId: string): Promise<string | null> {
		try {
			await octokit.graphql(
				`mutation EnablePullRequestAutoMerge($input: EnablePullRequestAutoMergeInput!) {
					enablePullRequestAutoMerge(input: $input) {
						pullRequest { autoMergeRequest { enabledAt } }
					}
				}`,
				{ input: { pullRequestId: pullRequestNodeId, mergeMethod: 'SQUASH' } },
			);
			return null;
		} catch (error: unknown) {
			console.log('enablePullRequestAutoMerge failed:', error);
			return extractErrorMessage(error);
		}
	}

	async function enqueuePrInMergeQueue(octokit: Context['octokit'], pullRequestNodeId: string): Promise<string | null> {
		try {
			await octokit.graphql(
				`mutation EnqueuePullRequest($input: EnqueuePullRequestInput!) {
					enqueuePullRequest(input: $input) {
						mergeQueueEntry { id }
					}
				}`,
				{ input: { pullRequestId: pullRequestNodeId } },
			);
			return null;
		} catch (error: unknown) {
			console.log('enqueuePullRequest failed:', error);
			return extractErrorMessage(error);
		}
	}

	async function tryMergePr(octokit: Context['octokit'], nodeId: string, owner: string, repo: string, pullNumber: number): Promise<string> {
		const lines: string[] = [];

		const enqueueErr = await enqueuePrInMergeQueue(octokit, nodeId);
		if (enqueueErr === null) {
			return '🚀 Enqueued in merge queue';
		}
		lines.push(`❌ Enqueue: ${enqueueErr}`);

		const autoMergeErr = await enableMergeWhenReady(octokit, nodeId);
		if (autoMergeErr === null) {
			return '🔄 Auto-merge enabled (merge when ready)';
		}
		lines.push(`❌ Auto-merge: ${autoMergeErr}`);

		const squashErr = await mergePrWithSquash(octokit, owner, repo, pullNumber);
		if (squashErr === null) {
			return '✅ Squash-merged directly';
		}
		lines.push(`❌ Squash merge: ${squashErr}`);

		return `⚠️ All merge strategies failed\n${lines.join('\n')}`;
	}

	async function runDionisioQACheckForRef(
		octokit: Context['octokit'],
		owner: string,
		repo: string,
		headSha: string,
		headBranch: string,
	): Promise<void> {
		const startTime = new Date();
		const repoParams = { owner, repo };

		let prNumber: number | null = null;
		let baseOwner = owner;
		let baseRepo = repo;

		const sameRepoPrs = await octokit.pulls.list({
			...repoParams,
			state: 'open',
			head: `${owner}:${headBranch}`,
			sort: 'updated',
			direction: 'desc',
			per_page: 1,
		});
		const sameRepoPr = sameRepoPrs.data[0];
		if (sameRepoPr) {
			prNumber = sameRepoPr.number;
		}

		if (prNumber === null) {
			try {
				const commitPrs = await octokit.repos.listPullRequestsAssociatedWithCommit({
					...repoParams,
					commit_sha: headSha,
				});
				const openPr = commitPrs.data.find((p) => p.state === 'open');
				if (openPr?.number && openPr.base?.repo) {
					prNumber = openPr.number;
					baseOwner = openPr.base.repo.owner?.login ?? owner;
					baseRepo = openPr.base.repo.name ?? repo;
				}
			} catch {
				// commit may be in a fork (not in this repo)
			}
		}

		// Fallback when event is from base repo but PR is from fork (commit not in base repo)
		if (prNumber === null) {
			const openPrs = await octokit.pulls.list({
				...repoParams,
				state: 'open',
				sort: 'updated',
				direction: 'desc',
				per_page: 30,
			});
			const prByHeadSha = openPrs.data.find((p) => p.head.sha === headSha);
			if (prByHeadSha) {
				prNumber = prByHeadSha.number;
				baseOwner = owner;
				baseRepo = repo;
			}
		}

		if (prNumber === null) {
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

		const fullPr = await octokit.pulls.get({
			owner: baseOwner,
			repo: baseRepo,
			pull_number: prNumber,
		});
		const prForQA: PullRequestForQA = {
			mergeable: fullPr.data.mergeable ?? undefined,
			labels: fullPr.data.labels.map((l) => ({ name: (l as { name: string }).name })),
			mergeable_state: fullPr.data.mergeable_state ?? 'unknown',
			milestone: fullPr.data.milestone?.title,
			url: fullPr.data.html_url ?? fullPr.data.url,
			number: fullPr.data.number,
		};

		const result = await runQAChecks(prForQA, baseOwner, baseRepo, fullPr.data.base.ref, octokit);

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
		const conclusion = result.readyToMerge ? 'success' : 'failure';

		const runs = await octokit.checks.listForRef({ ...repoParams, ref: headSha });
		const existing = runs.data.check_runs.find((r) => r.name === CHECK_RUN_NAME);

		const checkRunId = existing
			? (
					await octokit.checks.update({
						...repoParams,
						check_run_id: existing.id,
						conclusion,
						output: { title, summary },
						completed_at: new Date().toISOString(),
					})
				).data.id
			: (
					await octokit.checks.create({
						...repoParams,
						name: CHECK_RUN_NAME,
						head_sha: headSha,
						status: 'completed',
						started_at: startTime.toISOString(),
						completed_at: new Date().toISOString(),
						conclusion,
						output: { title, summary },
					})
				).data.id;

		if (result.readyToMerge && fullPr.data.node_id) {
			try {
				const mergeResult = await tryMergePr(octokit, fullPr.data.node_id, baseOwner, baseRepo, fullPr.data.number);
				await octokit.checks.update({
					...repoParams,
					check_run_id: checkRunId,
					output: { title, summary: `${summary}\n\n### Merge\n${mergeResult}` },
				});
			} catch (error) {
				console.log('tryMergePr unexpected error:', error);
				await octokit.checks.update({
					...repoParams,
					check_run_id: checkRunId,
					output: { title, summary: `${summary}\n\n### Merge\n⚠️ Unexpected error during merge attempt` },
				});
			}
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
		await runDionisioQACheck(context);
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
