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

const jiraFetch = async (jiraBaseUrl: string, jiraApiToken: string, path: string, options?: { method?: string; body?: string }) => {
	const res = await fetch(`${jiraBaseUrl}${path}`, {
		method: options?.method ?? 'GET',
		headers: {
			'Authorization': `Basic ${jiraApiToken}`,
			'Accept': 'application/json',
			'Content-Type': 'application/json',
		},
		body: options?.body,
	});
	return { ok: res.ok, status: res.status, text: () => res.text(), json: () => res.json() as Promise<unknown> };
};

async function projectHasVersion(jiraBaseUrl: string, jiraApiToken: string, projectKey: string, versionName: string): Promise<boolean> {
	const res = await jiraFetch(jiraBaseUrl, jiraApiToken, `/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`);
	if (!res.ok) return false;
	const versions = (await res.json()) as { name?: string }[];
	return Array.isArray(versions) && versions.some((v) => v.name === versionName);
}

function buildDescriptionContent(usePlainText: boolean, pr: HandleJiraArg['pr'], requestedBy: string): AdfBlock[] {
	const rawBody = pr.body?.trim() || 'no description';
	const descriptionBlock = usePlainText
		? [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: `PR description: ${rawBody}` }] }]
		: prBodyToAdfContent(pr.body);

	return [
		{ type: 'paragraph', content: [{ type: 'text', text: 'Task automatically created by dionisio-bot.' }] },
		{ type: 'paragraph', content: [{ type: 'text', text: `PR: ${pr.html_url}` }] },
		{ type: 'paragraph', content: [{ type: 'text', text: 'PR description:' }] },
		...descriptionBlock,
		{ type: 'paragraph', content: [{ type: 'text', text: `PR author: ${pr.user?.login ?? 'unknown'}` }] },
		{ type: 'paragraph', content: [{ type: 'text', text: `Requested by: ${requestedBy}` }] },
	];
}

export const handleJira = async ({ context, boardName, parentTaskKey, pr, requestedBy }: HandleJiraArg): Promise<string> => {
	const jiraBaseUrl = getEnv('JIRA_BASE_URL').replace(/\/$/, '');
	const jiraApiToken = getEnv('JIRA_API_TOKEN');
	const hasCommunityLabel = pr.labels.some((label) => label.toLowerCase() === 'community');
	const isSubtask = Boolean(parentTaskKey);
	const projectKey = parentTaskKey ? parentTaskKey.replace(/-\d+$/, '') : boardName;

	const milestoneName = pr.milestone?.trim();
	let useFixVersions = Boolean(milestoneName);
	let milestoneNotOnBoard = false;

	if (useFixVersions && milestoneName) {
		const exists = await projectHasVersion(jiraBaseUrl, jiraApiToken, projectKey, milestoneName);
		if (!exists) {
			useFixVersions = false;
			milestoneNotOnBoard = true;
		}
	}

	const buildPayload = (usePlainTextDescription: boolean) => ({
		fields: {
			project: { key: projectKey },
			...(isSubtask ? { parent: { key: parentTaskKey } } : {}),
			summary: `[PR #${pr.number}] ${pr.title}`,
			issuetype: { name: isSubtask ? 'Sub-task' : 'Task' },
			...(hasCommunityLabel ? { labels: ['community'] } : {}),
			...(useFixVersions && milestoneName ? { fixVersions: [{ name: milestoneName }] } : {}),
			description: {
				type: 'doc',
				version: 1,
				content: buildDescriptionContent(usePlainTextDescription, pr, requestedBy),
			},
		},
	});

	const headers = {
		'Authorization': `Basic ${jiraApiToken}`,
		'Accept': 'application/json',
		'Content-Type': 'application/json',
	};

	let response = await fetch(`${jiraBaseUrl}/rest/api/3/issue`, {
		method: 'POST',
		headers,
		body: JSON.stringify(buildPayload(false)),
	});

	let usedPlainTextDescription = false;

	if (!response.ok && response.status === 400) {
		const errorBody = await response.text();
		const errLower = errorBody.toLowerCase();

		const isFixVersionsError = /fixversions|fix version|version/i.test(errorBody);
		const isDescriptionError = /description|body|content|invalid.*document|adf/i.test(errLower) || /content.*invalid/i.test(errLower);

		if (isFixVersionsError && useFixVersions) {
			useFixVersions = false;
			milestoneNotOnBoard = true;
			response = await fetch(`${jiraBaseUrl}/rest/api/3/issue`, {
				method: 'POST',
				headers,
				body: JSON.stringify(buildPayload(false)),
			});
		} else if (isDescriptionError) {
			usedPlainTextDescription = true;
			response = await fetch(`${jiraBaseUrl}/rest/api/3/issue`, {
				method: 'POST',
				headers,
				body: JSON.stringify(buildPayload(true)),
			});
		}
	}

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Jira request failed (${response.status}): ${body}`);
	}

	const task = (await response.json()) as { key?: string };

	await context.octokit.issues.update({
		...context.issue(),
		body: `${pr.body?.trim() || 'no description'} \n\n Task: [${task.key}]`,
	});

	const warnings: string[] = [];
	if (milestoneNotOnBoard && milestoneName) {
		warnings.push(`The milestone **"${milestoneName}"** does not exist on the Jira board; the task was created without Fix version.`);
	}
	if (usedPlainTextDescription) {
		warnings.push('The PR description was sent as plain text because Jira rejected the formatted body.');
	}
	if (warnings.length > 0) {
		await context.octokit.issues.createComment({
			...context.issue(),
			body: `⚠️ **Dionisio (Jira)**\n\n${warnings.join('\n\n')}`,
		});
	}

	return task.key ?? '';
};
