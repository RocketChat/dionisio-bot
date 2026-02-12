import { Context } from 'probot';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mdToAdf = require('md-to-adf') as (markdown: string) => { toJSON: () => { type: string; version: number; content: unknown[] } };

const JIRA_ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/i;

interface AdfBlock {
	type: string;
	content?: unknown[];
	attrs?: unknown;
}

function prBodyToAdfContent(body: string | null): AdfBlock[] {
	const raw = body?.trim() || 'no description';
	try {
		const adf = mdToAdf(raw);
		const json = adf?.toJSON?.();
		const content = json?.content;
		if (Array.isArray(content) && content.length > 0) {
			return content as AdfBlock[];
		}
	} catch {
		// fallback to plain text
	}
	return [
		{
			type: 'paragraph',
			content: [{ type: 'text', text: `PR description: ${raw}` }],
		},
	];
}

export const isJiraTaskKey = (arg: string): boolean => JIRA_ISSUE_KEY_REGEX.test(arg.trim());

interface HandleJiraArg {
	context: Context;
	boardName: string;
	parentTaskKey?: string;
	pr: {
		number: number;
		title: string;
		body: string | null;
		html_url: string;
		labels: string[];
		milestone?: string | null;
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

export const handleJira = async ({ context, boardName, parentTaskKey, pr, requestedBy }: HandleJiraArg): Promise<string> => {
	const jiraBaseUrl = getEnv('JIRA_BASE_URL').replace(/\/$/, '');
	const jiraApiToken = getEnv('JIRA_API_TOKEN');
	const hasCommunityLabel = pr.labels.some((label) => label.toLowerCase() === 'community');
	const isSubtask = Boolean(parentTaskKey);
	const projectKey = parentTaskKey ? parentTaskKey.replace(/-\d+$/, '') : boardName;

	const payload = {
		fields: {
			project: {
				key: projectKey,
			},
			...(isSubtask ? { parent: { key: parentTaskKey } } : {}),
			summary: `[PR #${pr.number}] ${pr.title}`,
			issuetype: {
				name: isSubtask ? 'Sub-task' : 'Task',
			},
			...(hasCommunityLabel ? { labels: ['community'] } : {}),
			...(pr.milestone?.trim() ? { fixVersions: [{ name: pr.milestone.trim() }] } : {}),
			description: {
				type: 'doc',
				version: 1,
				content: [
					{
						type: 'paragraph',
						content: [{ type: 'text', text: 'Task automatically created by dionisio-bot.' }],
					},
					{
						type: 'paragraph',
						content: [{ type: 'text', text: `PR: ${pr.html_url}` }],
					},
					{
						type: 'paragraph',
						content: [{ type: 'text', text: 'PR description:' }],
					},
					...prBodyToAdfContent(pr.body),
					{
						type: 'paragraph',
						content: [{ type: 'text', text: `PR author: ${pr.user?.login ?? 'unknown'}` }],
					},
					{
						type: 'paragraph',
						content: [{ type: 'text', text: `Requested by: ${requestedBy}` }],
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
