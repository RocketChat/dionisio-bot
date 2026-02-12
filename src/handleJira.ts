import { Context } from 'probot';

interface HandleJiraArg {
	context: Context;
	boardName: string;
	pr: {
		number: number;
		title: string;
		body: string | null;
		html_url: string;
		labels: string[];
		user?: {
			login?: string;
		} | null;
	};
	requestedBy: string;
	commentId: number;
}

const getEnv = (name: string): string => {
	const value = process.env[name];

	if (!value?.trim()) {
		throw new Error(`Missing required env var: ${name}`);
	}

	return value.trim();
};

export const handleJira = async ({ context, boardName, pr, requestedBy, commentId }: HandleJiraArg): Promise<string> => {
	const jiraBaseUrl = getEnv('JIRA_BASE_URL').replace(/\/$/, '');
	const jiraApiToken = getEnv('JIRA_API_TOKEN');
	const hasCommunityLabel = pr.labels.some((label) => label.toLowerCase() === 'community');

	const payload = {
		fields: {
			project: {
				key: boardName,
			},
			summary: `[PR #${pr.number}] ${pr.title}`,
			issuetype: {
				name: 'Task',
			},
			...(hasCommunityLabel ? { labels: ['community'] } : {}),
			description: {
				type: 'doc',
				version: 1,
				content: [
					{
						type: 'paragraph',
						content: [
							{
								type: 'text',
								text: 'Task automatically created by dionisio-bot.',
							},
						],
					},
					{
						type: 'paragraph',
						content: [
							{
								type: 'text',
								text: `PR: ${pr.html_url}`,
							},
						],
					},
					{
						type: 'paragraph',
						content: [
							{
								type: 'text',
								text: `PR description: ${pr.body?.trim() || 'no description'}`,
							},
						],
					},
					{
						type: 'paragraph',
						content: [
							{
								type: 'text',
								text: `PR author: ${pr.user?.login ?? 'unknown'}`,
							},
						],
					},
					{
						type: 'paragraph',
						content: [
							{
								type: 'text',
								text: `Requested by: ${requestedBy}`,
							},
						],
					},
				],
			},
		},
	};

	const response = await fetch(`${jiraBaseUrl}/rest/api/3/issue`, {
		method: 'POST',
		headers: {
			'Authorization': `Basic ${jiraApiToken}`,
			'Accept': 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Jira request failed (${response.status}): ${body}`);
	}
	const task = (await response.json()) as { key?: string };

	await context.octokit.issues.update({
		...context.issue(),
		body: `${pr.body?.trim() || 'no description'} \n\n Task: [${task.key}]`,
	});

	return task.key ?? '';
};
