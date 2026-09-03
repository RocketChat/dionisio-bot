import type { Context } from 'probot';
import type { Log } from './logger';

const { INTERNAL_ORG = 'RocketChat' } = process.env;

export const isExternalContributor = async (
	octokit: Context['octokit'],
	username: string,
	log: Log,
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
	} catch (error) {
		if ((error as { status?: number }).status === 404) {
			log.debug({ username, org }, 'user is not an org member');
		} else {
			// e.g. 403 when the app lacks members:read; every author would then look external
			log.warn({ err: error, username, org }, 'org membership check failed, treating user as external');
		}
		return true;
	}
};
