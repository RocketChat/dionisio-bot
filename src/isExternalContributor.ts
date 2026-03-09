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
		const { data: orgs } = await octokit.orgs.listForUser({ username });
		return !orgs.some(({ login }) => login === org);
	} catch {
		return true;
	}
};
