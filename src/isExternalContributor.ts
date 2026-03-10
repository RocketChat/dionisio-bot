import type { Context } from 'probot';

const { INTERNAL_ORG = 'RocketChat' } = process.env;

export const isExternalContributor = async (
	octokit: Context['octokit'],
	username: string,
	org: string = INTERNAL_ORG,
): Promise<boolean> => {
	if (!username) {
		return false;
	}
	try {
		await octokit.orgs.checkMembershipForUser({ org, username });
		return false;
	} catch {
		return true;
	}
};
