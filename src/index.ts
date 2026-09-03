import { Probot, Context } from 'probot';
import { applyLabels } from './handleQALabels';
import { handlePatch } from './handlePatch';
import { handleBackport } from './handleBackport';
import { run } from './Queue';
import { handleRebase } from './handleRebase';
import { handleJira, isJiraTaskKey } from './handleJira';
import { runQAChecks, formatCheckRunOutput, CHECK_RUN_NAME, type PullRequestForQA } from './qaChecks';
import { enforceChangesetMilestone } from './checkChangesets';
import { isExternalContributor } from './isExternalContributor';
import { eventLogger, type Log } from './logger';
import { errorIdLine, extractErrorMessage, reportError } from './reportError';

export = (app: Probot) => {
	app.on(['issues.milestoned', 'issues.demilestoned'], async (context): Promise<void> => {
		const log = eventLogger(context);
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
				log,
			),
		);

		const { owner, repo } = context.repo();
		await runDionisioQACheckForRef(context.octokit, owner, repo, pr.data.head.sha, pr.data.head.ref, context.id, log);
	});

	app.on(
		['pull_request.opened', 'pull_request.synchronize', 'pull_request.edited', 'pull_request.labeled', 'pull_request.unlabeled'],
		async (context): Promise<void> => {
			const log = eventLogger(context);

			if (context.payload.pull_request.closed_at) {
				return;
			}

			const { repo: ctxRepo } = context.payload.pull_request.head;

			if (!ctxRepo || !ctxRepo.owner || !ctxRepo.name) {
				return;
			}

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
					log,
				),
			);

			const { owner, repo } = context.repo();
			const { head } = context.payload.pull_request;
			await runDionisioQACheckForRef(context.octokit, owner, repo, head.sha, head.ref, context.id, log);
		},
	);

	app.on(['issue_comment.created'], async (context): Promise<void> => {
		const log = eventLogger(context);
		const { comment, issue } = context.payload;
		const matcher = /^\/([\w]+)\b *(.*)?$/m;

		const [, command, args] = comment.body.match(matcher) || [];

		if (await isExternalContributor(context.octokit, comment.user.login, log)) {
			return;
		}

		if (command) {
			log.info({ command, args }, 'slash command received');
		}

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
				await reportError(context, log, e, { action: '/jira', extra: { boardName: rawArg } });
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

		/**
		 * Gets the latest release of the repository
		 * check if exists a branch with the latest version
		 * triggers a workflow_dispatch event to create a new patch release
		 * creates a project with the latest version
		 */

		if (command === 'patch' && !args?.trim()) {
			try {
				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: 'eyes',
				});

				const result = await handlePatch({
					context,
					pr: {
						...pr.data,
						author: pr.data.user?.login,
					},
					assignee: comment.user.login,
					log,
				});

				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: '+1',
				});

				return result;
			} catch (e) {
				await reportError(context, log, e, { action: '/patch' });
				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: '-1',
				});
			} finally {
				await context.octokit.reactions.deleteForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: 'eyes',
				});
			}
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

				log.debug({ tags }, 'backport requested');
				await handleBackport({
					context,
					pr: { ...pr.data, author: pr.data.user?.login },
					tags,
					assignee: comment.user.login,
					log,
				});
			} catch (e) {
				// add a reaction to the comment
				await context.octokit.reactions.createForIssueComment({
					...context.issue(),
					comment_id: comment.id,
					content: '-1',
				});
				await reportError(context, log, e, { action: '/backport', extra: { tags } });
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

				log.debug({ backportNumber, release }, 'rebase requested');
				try {
					await handleRebase({
						context,
						backportNumber: parseInt(backportNumber),
						release,
						log,
					});
				} catch (e) {
					// handleRebase already commented with the conflict details and the error id
					await context.octokit.reactions.createForIssueComment({
						...context.issue(),
						comment_id: comment.id,
						content: '-1',
					});
					log.error({ err: e, backportNumber, release }, '/rebase failed');
				}
			}
		}
	});

	async function mergePrWithSquash(
		octokit: Context['octokit'],
		owner: string,
		repo: string,
		pullNumber: number,
		log: Log,
	): Promise<string | null> {
		try {
			await octokit.pulls.merge({ owner, repo, pull_number: pullNumber, merge_method: 'squash' });
			return null;
		} catch (error: unknown) {
			log.warn({ err: error }, 'squash merge failed');
			return extractErrorMessage(error);
		}
	}

	async function enableMergeWhenReady(octokit: Context['octokit'], pullRequestNodeId: string, log: Log): Promise<string | null> {
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
			log.warn({ err: error }, 'enabling auto-merge failed');
			return extractErrorMessage(error);
		}
	}

	async function enqueuePrInMergeQueue(octokit: Context['octokit'], pullRequestNodeId: string, log: Log): Promise<string | null> {
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
			log.warn({ err: error }, 'enqueueing in merge queue failed');
			return extractErrorMessage(error);
		}
	}

	async function tryMergePr(
		octokit: Context['octokit'],
		nodeId: string,
		owner: string,
		repo: string,
		pullNumber: number,
		log: Log,
	): Promise<string> {
		const lines: string[] = [];

		const enqueueErr = await enqueuePrInMergeQueue(octokit, nodeId, log);
		if (enqueueErr === null) {
			log.info({ strategy: 'merge-queue' }, 'pull request merge triggered');
			return '🚀 Enqueued in merge queue';
		}
		lines.push(`❌ Enqueue: ${enqueueErr}`);

		const autoMergeErr = await enableMergeWhenReady(octokit, nodeId, log);
		if (autoMergeErr === null) {
			log.info({ strategy: 'auto-merge' }, 'pull request merge triggered');
			return '🔄 Auto-merge enabled (merge when ready)';
		}
		lines.push(`❌ Auto-merge: ${autoMergeErr}`);

		const squashErr = await mergePrWithSquash(octokit, owner, repo, pullNumber, log);
		if (squashErr === null) {
			log.info({ strategy: 'squash' }, 'pull request merge triggered');
			return '✅ Squash-merged directly';
		}
		lines.push(`❌ Squash merge: ${squashErr}`);

		log.error('all merge strategies failed');
		return `⚠️ All merge strategies failed\n${lines.join('\n')}`;
	}

	async function upsertCheckRun(
		octokit: Context['octokit'],
		repoParams: { owner: string; repo: string },
		headSha: string,
		startTime: Date,
		conclusion: 'success' | 'failure' | 'neutral',
		output: { title: string; summary: string },
		log: Log,
	): Promise<number> {
		const runs = await octokit.checks.listForRef({ ...repoParams, ref: headSha });
		const existing = runs.data.check_runs.find((r) => r.name === CHECK_RUN_NAME);

		if (existing) {
			const updated = await octokit.checks.update({
				...repoParams,
				check_run_id: existing.id,
				conclusion,
				output,
				completed_at: new Date().toISOString(),
			});
			log.info({ checkRunId: updated.data.id, headSha, conclusion, title: output.title }, 'check run updated');
			return updated.data.id;
		}

		const created = await octokit.checks.create({
			...repoParams,
			name: CHECK_RUN_NAME,
			head_sha: headSha,
			status: 'completed',
			started_at: startTime.toISOString(),
			completed_at: new Date().toISOString(),
			conclusion,
			output,
		});
		log.info({ checkRunId: created.data.id, headSha, conclusion, title: output.title }, 'check run created');
		return created.data.id;
	}

	async function runDionisioQACheckForRef(
		octokit: Context['octokit'],
		owner: string,
		repo: string,
		headSha: string,
		headBranch: string,
		delivery: string,
		log: Log,
	): Promise<void> {
		const startTime = new Date();
		try {
			await runQACheckRun(octokit, owner, repo, headSha, headBranch, startTime, log);
		} catch (error) {
			log.error({ err: error, headSha }, 'QA check run failed');
			// the check run is the user-facing surface here; quote the delivery id so the failure can be traced
			try {
				await upsertCheckRun(
					octokit,
					{ owner, repo },
					headSha,
					startTime,
					'neutral',
					{
						title: 'Dionisio QA failed to run',
						summary: `Dionisio QA hit an unexpected error: ${extractErrorMessage(error)}\n\n${errorIdLine({ id: delivery })}`,
					},
					log,
				);
			} catch (checkRunError) {
				log.warn({ err: checkRunError, headSha }, 'could not report the failure on the check run');
			}
		}
	}

	async function runQACheckRun(
		octokit: Context['octokit'],
		owner: string,
		repo: string,
		headSha: string,
		headBranch: string,
		startTime: Date,
		log: Log,
	): Promise<void> {
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
			} catch (error) {
				log.debug({ err: error, headSha }, 'commit not found in base repo, probably from a fork');
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
			await upsertCheckRun(
				octokit,
				repoParams,
				headSha,
				startTime,
				'neutral',
				{
					title: 'No open PR',
					summary: 'There is no open pull request for this branch. Open a PR to run Dionisio QA checks.',
				},
				log,
			);
			return;
		}

		const [fullPr, reviews] = await Promise.all([
			octokit.pulls.get({ owner: baseOwner, repo: baseRepo, pull_number: prNumber }),
			octokit.pulls.listReviews({ owner: baseOwner, repo: baseRepo, pull_number: prNumber }),
		]);

		const hasReviews = reviews.data.some((r) => r.user?.type !== 'Bot');

		try {
			await enforceChangesetMilestone({
				octokit,
				owner: baseOwner,
				repo: baseRepo,
				pr: {
					number: prNumber,
					title: fullPr.data.title,
					milestone: fullPr.data.milestone?.title,
					head: {
						owner: fullPr.data.head.repo?.owner.login ?? baseOwner,
						repo: fullPr.data.head.repo?.name ?? baseRepo,
						sha: fullPr.data.head.sha,
					},
				},
				log,
			});
		} catch (error) {
			log.error({ err: error, prNumber }, 'changeset milestone enforcement failed');
		}

		const prForQA: PullRequestForQA = {
			mergeable: fullPr.data.mergeable ?? undefined,
			labels: fullPr.data.labels.map((l) => ({ name: (l as { name: string }).name })),
			mergeable_state: fullPr.data.mergeable_state ?? 'unknown',
			milestone: fullPr.data.milestone?.title,
			url: fullPr.data.html_url ?? fullPr.data.url,
			number: fullPr.data.number,
			title: fullPr.data.title,
		};

		const result = await runQAChecks(prForQA, baseOwner, baseRepo, fullPr.data.base.ref, octokit, log);

		if (!result) {
			await upsertCheckRun(
				octokit,
				repoParams,
				headSha,
				startTime,
				'neutral',
				{
					title: 'Could not run checks',
					summary: 'Dionisio QA could not run (e.g. missing package.json on base ref).',
				},
				log,
			);
			return;
		}

		const { title, summary } = formatCheckRunOutput(result);
		let conclusion: 'success' | 'failure' | 'neutral';
		let finalTitle = title;

		if (!hasReviews) {
			conclusion = 'neutral';
			finalTitle = 'Waiting for reviews';
		} else {
			conclusion = result.readyToMerge ? 'success' : 'failure';
		}

		await upsertCheckRun(
			octokit,
			repoParams,
			headSha,
			startTime,
			conclusion,
			{
				title: finalTitle,
				summary,
			},
			log,
		);
	}

	async function runDionisioQACheck(context: Context<'check_suite.requested' | 'check_suite.rerequested'>) {
		const log = eventLogger(context);
		const { head_branch: headBranch, head_sha: headSha } = context.payload.check_suite;
		const { owner, repo } = context.repo();
		await runDionisioQACheckForRef(context.octokit, owner, repo, headSha, headBranch ?? headSha, context.id, log);
	}

	app.on(['check_suite.requested'], async function check(context) {
		await runDionisioQACheck(context);
	});

	app.on(['check_suite.rerequested'], async function check(context) {
		await runDionisioQACheck(context);
	});

	app.on(['check_suite.completed'], async (context) => {
		if (context.payload.check_suite.conclusion !== 'success') {
			return;
		}

		const log = eventLogger(context);

		const { head_sha: headSha, head_branch: headBranch } = context.payload.check_suite;
		const { owner, repo } = context.repo();

		const runs = await context.octokit.checks.listForRef({ owner, repo, ref: headSha });
		const dionisioRun = runs.data.check_runs.find((r) => r.name === CHECK_RUN_NAME);

		if (!dionisioRun || dionisioRun.conclusion !== 'success') {
			return;
		}

		let prNumber: number | null = null;
		let baseOwner = owner;
		let baseRepo = repo;

		if (headBranch) {
			const prs = await context.octokit.pulls.list({
				owner,
				repo,
				state: 'open',
				head: `${owner}:${headBranch}`,
				per_page: 1,
			});
			if (prs.data[0]) {
				prNumber = prs.data[0].number;
			}
		}

		if (prNumber === null) {
			const openPrs = await context.octokit.pulls.list({
				owner,
				repo,
				state: 'open',
				sort: 'updated',
				direction: 'desc',
				per_page: 30,
			});
			const match = openPrs.data.find((p) => p.head.sha === headSha);
			if (match) {
				prNumber = match.number;
				baseOwner = owner;
				baseRepo = repo;
			}
		}

		if (prNumber === null) {
			log.warn({ headSha, headBranch }, 'QA check succeeded but no open pull request was found to merge');
			return;
		}

		const fullPr = await context.octokit.pulls.get({
			owner: baseOwner,
			repo: baseRepo,
			pull_number: prNumber,
		});

		if (!fullPr.data.node_id) {
			return;
		}

		try {
			const mergeResult = await tryMergePr(context.octokit, fullPr.data.node_id, baseOwner, baseRepo, fullPr.data.number, log);
			const existingTitle = dionisioRun.output?.title ?? 'Dionisio QA';
			const existingSummary = dionisioRun.output?.summary ?? '';
			await context.octokit.checks.update({
				owner,
				repo,
				check_run_id: dionisioRun.id,
				output: { title: existingTitle, summary: `${existingSummary}\n\n### Merge\n${mergeResult}` },
			});
		} catch (error) {
			log.error({ err: error, prNumber }, 'merge after QA success failed');
		}
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
