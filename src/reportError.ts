import type { Context } from 'probot';
import { ErrorCherryPickConflict } from './errors/ErrorCherryPickConflict';
import type { Log } from './logger';

// The GitHub delivery id is bound to every log line of this webhook, so it doubles as the error id
export const errorIdLine = (context: Pick<Context, 'id'>): string =>
	`Error id: \`${context.id}\` — please share it when reporting this problem.`;

/**
 * Logs a slash-command failure and tells the requester on the issue/PR.
 * The comment carries only the delivery id: error messages may include
 * API responses or internal details, so those stay in the logs.
 */
export const reportError = async (
	context: Context,
	log: Log,
	error: unknown,
	{ action, extra }: { action: string; extra?: Record<string, unknown> },
): Promise<void> => {
	// conflicts already get their own explanatory comment from the handler
	if (error instanceof ErrorCherryPickConflict) {
		log.warn({ err: error, ...extra }, `${action} failed: cherry-pick conflict`);
		return;
	}

	log.error({ err: error, ...extra }, `${action} failed`);

	try {
		await context.octokit.issues.createComment({
			...context.issue(),
			body: [`Sorry, \`${action}\` failed.`, '', errorIdLine(context)].join('\n'),
		});
	} catch (commentError) {
		log.warn({ err: commentError }, 'could not post the error comment');
	}
};
