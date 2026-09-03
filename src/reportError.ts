import type { Context } from 'probot';
import { ErrorCherryPickConflict } from './errors/ErrorCherryPickConflict';
import type { Log } from './logger';

export const extractErrorMessage = (error: unknown): string => {
	const e = error as { status?: number; message?: string; errors?: { message?: string }[] };
	const parts: string[] = [];
	if (e.status) parts.push(`status=${e.status}`);
	if (e.message) parts.push(e.message);
	if (e.errors?.length) parts.push(e.errors.map((x) => x.message ?? JSON.stringify(x)).join('; '));
	return parts.join(' — ') || 'Unknown error';
};

// The GitHub delivery id is bound to every log line of this webhook, so it doubles as the error id
export const errorIdLine = (context: Pick<Context, 'id'>): string =>
	`Error id: \`${context.id}\` — please share it when reporting this problem.`;

/**
 * Logs a slash-command failure and tells the requester on the issue/PR,
 * quoting the delivery id so the comment can be matched to the logs.
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
			body: [`Sorry, \`${action}\` failed: ${extractErrorMessage(error)}`, '', errorIdLine(context)].join('\n'),
		});
	} catch (commentError) {
		log.warn({ err: commentError }, 'could not post the error comment');
	}
};
