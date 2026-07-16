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
	// bots are never community contributors
	if (username.endsWith('[bot]')) {
		return false;
	}
	try {
		// checkMembershipForUser sees private memberships too; listForUser only returns public ones
		await octokit.orgs.checkMembershipForUser({ org, username });
		return false;
	} catch {
		return true;
	}
};
