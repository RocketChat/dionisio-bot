import { Context } from 'probot';
import type { Log } from './logger';

export const addPrToProject = (context: Context, pr: string, project: string, log: Log) => {
	log.debug({ project, pr }, 'adding pull request to project');

	return context.octokit.graphql({
		query: `mutation($project:ID!, $pr:ID!) {
    addProjectV2ItemById(input: {projectId: $project, contentId: $pr}) {
      item {
        id
      }
    }
  }`,

		project,
		pr,
	});
};
