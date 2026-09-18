import { Probot, Context } from 'probot';
import { applyLabels } from './handleQALabels';
import { handlePatch } from './handlePatch';
import { handleBackport } from './handleBackport';
import { run } from './Queue';
import { handleRebase } from './handleRebase';
import { handleJira, isJiraTaskKey } from './handleJira';
import {
	runQAChecks,
	formatCheckRunOutput,
	buildCheckVerdict,
	blockedOnlyByMergeability,
	CHECK_RUN_NAME,
	type PullRequestForQA,
	type QAChecksResult,
} from './qaChecks';
import { getPullRequestWithMergeability, type PullRequestData } from './pullRequest';
import { evaluateMergeDecision } from './mergeDecision';
import { chooseMergeStrategy, getMergeCapabilities } from './mergeStrategy';
import { enforceChangesetMilestone } from './checkChangesets';
import { isExternalContributor } from './isExternalContributor';
import { eventLogger, type Log } from './logger';
import { errorIdLine, reportError } from './reportError';
import { resolvePullRequestForHead } from './resolvePullRequest';

/** A pull request the caller already fetched, reused when it is the one we resolved to. */
interface PrefetchedPullRequest {
	owner: string;
	repo: string;
	data: PullRequestData;
}

interface QAOutcome {
	prNumber: number;
	baseOwner: string;
	baseRepo: string;
	pr: {
		nodeId: string;
		state: string;
		draft: boolean;
		merged: boolean;
		mergeable: boolean | null;
		mergeableState: string;
		headSha: string;
		baseRef: string;
	};
	result: QAChecksResult;
	hasReviews: boolean;
	conclusion: 'success' | 'failure' | 'neutral';
	output: { title: string; summary: string };
}

type QAComputation = { kind: 'no-pr' } | { kind: 'not-runnable' } | { kind: 'ok'; outcome: QAOutcome };

const MERGE_NOTE_SEPARATOR = '\n\n### Merge\n';

// Off by default: a direct squash is the only strategy that does not wait for anything.
const ALLOW_DIRECT_SQUASH_MERGE = process.env.ALLOW_DIRECT_SQUASH_MERGE === 'true';

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

		await run(`${pr.data.base.repo.owner.login}/${pr.data.base.repo.name}#${pr.data.number}`, () =>
			applyLabels(
				{
					...pr.data,
					url: pr.data.html_url,
					milestone: pr.data.milestone?.title,
				},
				pr.data.base.repo.owner.login,
				pr.data.base.repo.name,
				pr.data.base.ref,
				context,
				log,
			),
		);

		const { owner, repo } = context.repo();
		await runDionisioQACheckForRef(
			context.octokit,
			owner,
			repo,
			pr.data.head.sha,
			pr.data.head.ref,
			context.id,
			log,
			[{ number: pr.data.number }],
			{ owner, repo, data: pr.data },
		);
	});

	app.on(
		['pull_request.opened', 'pull_request.synchronize', 'pull_request.edited', 'pull_request.labeled', 'pull_request.unlabeled'],
		async (context): Promise<void> => {
			const log = eventLogger(context);

			if (context.payload.pull_request.closed_at) {
				return;
			}

			const { owner, repo } = context.repo();
			const { base, head, number } = context.payload.pull_request;

			// Fetched rather than read from the payload: `url` there is the API url, which the
			// projects lookup cannot resolve. Mergeability is not waited on here — the check run
			// path waits only if it turns out to be the one thing left deciding the outcome.
			const { data: pullRequest } = await context.octokit.pulls.get({ owner, repo, pull_number: number });

			await run(`${owner}/${repo}#${number}`, () =>
				applyLabels(
					{
						...pullRequest,
						url: pullRequest.html_url,
						milestone: pullRequest.milestone?.title,
					},
					base.repo.owner.login,
					base.repo.name,
					base.ref,
					context,
					log,
				),
			);

			await runDionisioQACheckForRef(context.octokit, owner, repo, head.sha, head.ref, context.id, log, [{ number }], {
				owner,
				repo,
				data: pullRequest,
			});
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

			const reaction = await context.octokit.reactions.createForIssueComment({
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
					reaction_id: reaction.data.id,
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
			const reaction = await context.octokit.reactions.createForIssueComment({
				...context.issue(),
				comment_id: comment.id,
				content: 'eyes',
			});

			try {
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
					reaction_id: reaction.data.id,
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

	function extractErrorMessage(error: unknown): string {
		const e = error as { status?: number; message?: string; errors?: { message?: string }[] };
		const parts: string[] = [];
		if (e.status) parts.push(`status=${e.status}`);
		if (e.message) parts.push(e.message);
		if (e.errors?.length) parts.push(e.errors.map((x) => x.message ?? JSON.stringify(x)).join('; '));
		return parts.join(' — ') || 'Unknown error';
	}

	async function mergePrWithSquash(
		octokit: Context['octokit'],
		owner: string,
		repo: string,
		pullNumber: number,
		headSha: string,
		log: Log,
	): Promise<string | null> {
		try {
			// Pinning the sha makes GitHub reject the merge with a 409 if the head moved since QA ran,
			// so we can never merge code that was not the code we checked.
			await octokit.pulls.merge({ owner, repo, pull_number: pullNumber, merge_method: 'squash', sha: headSha });
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

	/**
	 * Runs exactly the strategy the branch supports. There is deliberately no fallback: escalating
	 * past a rejected enqueue is how a merge ends up bypassing the queue it was supposed to go
	 * through.
	 */
	async function tryMergePr(
		octokit: Context['octokit'],
		pr: { nodeId: string; owner: string; repo: string; number: number; headSha: string; baseRef: string; mergeableState: string },
		log: Log,
	): Promise<string> {
		const capabilities = await getMergeCapabilities(octokit, pr.owner, pr.repo, pr.baseRef, log);
		const choice = chooseMergeStrategy({
			...capabilities,
			mergeableState: pr.mergeableState,
			allowDirectSquash: ALLOW_DIRECT_SQUASH_MERGE,
		});

		if ('skip' in choice) {
			log.info({ reason: choice.skip, ...capabilities, mergeableState: pr.mergeableState }, 'no merge strategy available');
			return `⚠️ Not merged: ${choice.skip}`;
		}

		const { strategy } = choice;

		if (strategy === 'queue') {
			const error = await enqueuePrInMergeQueue(octokit, pr.nodeId, log);
			if (error === null) {
				log.info({ strategy }, 'pull request merge triggered');
				return '🚀 Enqueued in merge queue';
			}
			// The branch has a queue, so a rejection means this PR is not ready for it yet.
			log.warn({ strategy, error }, 'merge queue refused the pull request');
			return `❌ Merge queue refused this PR: ${error}`;
		}

		if (strategy === 'auto-merge') {
			const error = await enableMergeWhenReady(octokit, pr.nodeId, log);
			if (error === null) {
				log.info({ strategy }, 'pull request merge triggered');
				return '🔄 Auto-merge enabled (merge when ready)';
			}
			log.warn({ strategy, error }, 'enabling auto-merge failed');
			return `❌ Auto-merge failed: ${error}`;
		}

		const error = await mergePrWithSquash(octokit, pr.owner, pr.repo, pr.number, pr.headSha, log);
		if (error === null) {
			log.info({ strategy }, 'pull request merge triggered');
			return '✅ Squash-merged directly';
		}
		log.warn({ strategy, error }, 'squash merge failed');
		return `❌ Squash merge failed: ${error}`;
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
		// Filtered by name server side. Listing every run and searching locally missed ours once a
		// SHA carried more than a page of check runs, and we would then create a duplicate.
		const runs = await octokit.checks.listForRef({ ...repoParams, ref: headSha, check_name: CHECK_RUN_NAME });
		const [existing] = runs.data.check_runs;

		if (existing) {
			// Rewriting an unchanged check run re-emits check_run.completed and re-delivers the
			// suite events back to us, so only write when something actually changed.
			if (existing.conclusion === conclusion && existing.output?.title === output.title && existing.output?.summary === output.summary) {
				log.debug({ checkRunId: existing.id, headSha }, 'check run unchanged');
				return existing.id;
			}

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
		headBranch: string | null,
		delivery: string,
		log: Log,
		hints: { number: number }[] = [],
		prefetched?: PrefetchedPullRequest,
	): Promise<void> {
		const startTime = new Date();
		try {
			// Serialised per commit: the check run is keyed by head sha, and two deliveries racing
			// here would both see no existing run and each create one.
			await run(`check:${owner}/${repo}@${headSha}`, () =>
				runQACheckRun(octokit, owner, repo, headSha, headBranch, startTime, log, hints, prefetched),
			);
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
						summary: `Dionisio QA could not run because of an unexpected error.\n\n${errorIdLine({ id: delivery })}`,
					},
					log,
				);
			} catch (checkRunError) {
				log.warn({ err: checkRunError, headSha }, 'could not report the failure on the check run');
			}
		}
	}

	/**
	 * Works out the current QA state of the pull request at `headSha` without writing anything.
	 *
	 * Kept separate from the check run so the merge path can ask "is this still true?" without
	 * updating a completed check run — which re-emits check_run.completed, completes the suite
	 * again and delivers check_suite.completed right back to us.
	 */
	async function computeQAOutcome(
		octokit: Context['octokit'],
		owner: string,
		repo: string,
		headSha: string,
		headBranch: string | null,
		log: Log,
		hints: { number: number }[],
		prefetched?: PrefetchedPullRequest,
	): Promise<QAComputation> {
		const repoParams = { owner, repo };

		const resolvedPr = await resolvePullRequestForHead(octokit, repoParams, headSha, headBranch, hints, log);

		if (!resolvedPr) {
			return { kind: 'no-pr' };
		}

		const { number: prNumber, baseOwner, baseRepo } = resolvedPr;

		const prParams = { owner: baseOwner, repo: baseRepo, pull_number: prNumber };
		const alreadyFetched =
			prefetched && prefetched.owner === baseOwner && prefetched.repo === baseRepo && prefetched.data.number === prNumber
				? prefetched.data
				: undefined;

		const [fetched, reviews] = await Promise.all([
			alreadyFetched ?? octokit.pulls.get(prParams).then((response) => response.data),
			octokit.paginate(octokit.pulls.listReviews, { owner: baseOwner, repo: baseRepo, pull_number: prNumber, per_page: 100 }),
		]);

		let fullPr = fetched;

		const hasReviews = reviews.some((r) => r.user?.type !== 'Bot');

		try {
			await enforceChangesetMilestone({
				octokit,
				owner: baseOwner,
				repo: baseRepo,
				pr: {
					number: prNumber,
					title: fullPr.title,
					milestone: fullPr.milestone?.title,
					head: {
						owner: fullPr.head.repo?.owner.login ?? baseOwner,
						repo: fullPr.head.repo?.name ?? baseRepo,
						sha: fullPr.head.sha,
					},
				},
				log,
			});
		} catch (error) {
			log.error({ err: error, prNumber }, 'changeset milestone enforcement failed');
		}

		const prForQA: PullRequestForQA = {
			mergeable: fullPr.mergeable,
			draft: fullPr.draft,
			labels: fullPr.labels.map((l) => ({ name: (l as { name: string }).name })),
			mergeable_state: fullPr.mergeable_state ?? 'unknown',
			milestone: fullPr.milestone?.title,
			url: fullPr.html_url ?? fullPr.url,
			number: fullPr.number,
			title: fullPr.title,
		};

		let result = await runQAChecks(prForQA, baseOwner, baseRepo, fullPr.base.ref, octokit, log);

		if (result && blockedOnlyByMergeability(result)) {
			// Everything else passes, so the answer GitHub is still computing decides the conclusion.
			// This is the only case where the wait buys anything.
			fullPr = (await getPullRequestWithMergeability(octokit, prParams, log)).data;
			result = await runQAChecks(
				{ ...prForQA, mergeable: fullPr.mergeable, mergeable_state: fullPr.mergeable_state ?? 'unknown' },
				baseOwner,
				baseRepo,
				fullPr.base.ref,
				octokit,
				log,
			);
		}

		if (!result) {
			return { kind: 'not-runnable' };
		}

		const verdict = buildCheckVerdict(result, { hasReviews });

		return {
			kind: 'ok',
			outcome: {
				prNumber,
				baseOwner,
				baseRepo,
				pr: {
					nodeId: fullPr.node_id,
					state: fullPr.state,
					draft: Boolean(fullPr.draft),
					merged: Boolean(fullPr.merged),
					mergeable: fullPr.mergeable,
					mergeableState: fullPr.mergeable_state ?? 'unknown',
					headSha: fullPr.head.sha,
					baseRef: fullPr.base.ref,
				},
				result,
				hasReviews,
				conclusion: verdict.conclusion,
				output: formatCheckRunOutput(verdict),
			},
		};
	}

	/**
	 * Records the merge outcome on the check run, replacing any previous note rather than
	 * appending to it. Updating a completed check run re-emits check_run.completed, so writing
	 * an ever-growing summary would keep re-delivering check_suite.completed to this app.
	 */
	async function recordMergeNote(
		octokit: Context['octokit'],
		repoParams: { owner: string; repo: string },
		headSha: string,
		mergeResult: string,
		log: Log,
	): Promise<void> {
		const runs = await octokit.checks.listForRef({ ...repoParams, ref: headSha, check_name: CHECK_RUN_NAME });
		const [existing] = runs.data.check_runs;

		if (!existing) {
			return;
		}

		const existingSummary = existing.output?.summary ?? '';
		const summary = `${existingSummary.split(MERGE_NOTE_SEPARATOR)[0]}${MERGE_NOTE_SEPARATOR}${mergeResult}`;

		if (summary === existingSummary) {
			log.debug({ headSha }, 'merge note unchanged');
			return;
		}

		await octokit.checks.update({
			...repoParams,
			check_run_id: existing.id,
			output: { title: existing.output?.title ?? CHECK_RUN_NAME, summary },
		});
	}

	async function runQACheckRun(
		octokit: Context['octokit'],
		owner: string,
		repo: string,
		headSha: string,
		headBranch: string | null,
		startTime: Date,
		log: Log,
		hints: { number: number }[],
		prefetched?: PrefetchedPullRequest,
	): Promise<void> {
		const repoParams = { owner, repo };
		const computation = await computeQAOutcome(octokit, owner, repo, headSha, headBranch, log, hints, prefetched);

		if (computation.kind === 'no-pr') {
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

		if (computation.kind === 'not-runnable') {
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

		await upsertCheckRun(octokit, repoParams, headSha, startTime, computation.outcome.conclusion, computation.outcome.output, log);
	}

	async function runDionisioQACheck(context: Context<'check_suite.requested' | 'check_suite.rerequested'>) {
		const log = eventLogger(context);
		const { head_branch: headBranch, head_sha: headSha, pull_requests: hints } = context.payload.check_suite;
		const { owner, repo } = context.repo();
		await runDionisioQACheckForRef(context.octokit, owner, repo, headSha, headBranch, context.id, log, hints ?? []);
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

		const { head_sha: headSha, head_branch: headBranch, pull_requests: hints, app: suiteApp } = context.payload.check_suite;
		const { owner, repo } = context.repo();

		// Cheap filter before the expensive part. Writing our own check run completes a suite for
		// this app, which lands right back here, so recomputing unconditionally would double the
		// QA work for every event. Reading the stored conclusion is safe as a *negative* filter:
		// a stale value can only stop a merge that a recompute would have allowed, never allow one.
		const runs = await context.octokit.checks.listForRef({ owner, repo, ref: headSha, check_name: CHECK_RUN_NAME });
		const [storedRun] = runs.data.check_runs;

		if (storedRun?.conclusion !== 'success') {
			log.debug({ headSha, stored: storedRun?.conclusion ?? 'none' }, 'no stored QA success to act on');
			return;
		}

		// Recompute rather than trusting that conclusion to merge on: it may have been decided
		// hours ago, under conditions that no longer hold.
		const computation = await computeQAOutcome(context.octokit, owner, repo, headSha, headBranch, log, hints ?? []);

		if (computation.kind !== 'ok') {
			log.debug({ headSha, headBranch, kind: computation.kind }, 'no pull request to merge for this check suite');
			return;
		}

		const { outcome } = computation;
		const decision = evaluateMergeDecision({
			state: outcome.pr.state,
			draft: outcome.pr.draft,
			merged: outcome.pr.merged,
			mergeable: outcome.pr.mergeable,
			mergeableState: outcome.pr.mergeableState,
			readyToMerge: outcome.result.readyToMerge,
			hasReviews: outcome.hasReviews,
		});

		if (!decision.merge) {
			log.info(
				{ prNumber: outcome.prNumber, reason: decision.reason, suiteApp: suiteApp?.slug, mergeableState: outcome.pr.mergeableState },
				'merge skipped',
			);
			return;
		}

		// Concurrent suite completions on the same PR would otherwise race into parallel merges.
		await run(String(outcome.prNumber), async () => {
			try {
				const mergeResult = await tryMergePr(
					context.octokit,
					{
						nodeId: outcome.pr.nodeId,
						owner: outcome.baseOwner,
						repo: outcome.baseRepo,
						number: outcome.prNumber,
						headSha: outcome.pr.headSha,
						baseRef: outcome.pr.baseRef,
						mergeableState: outcome.pr.mergeableState,
					},
					log,
				);
				await recordMergeNote(context.octokit, { owner, repo }, headSha, mergeResult, log);
			} catch (error) {
				log.error({ err: error, prNumber: outcome.prNumber }, 'merge after QA success failed');
			}
		});
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
