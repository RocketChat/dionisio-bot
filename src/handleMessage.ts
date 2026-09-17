import type { QAChecksResult } from './qaChecks';

const troubleMessage = `If you have any trouble, please check the [PR guidelines](https://handbook.rocket.chat/space/RnD/359891385/%F0%9F%8C%90+PR+General+Instructions+and+Handling)`;

/**
 * Rendered from the same steps as the check run so the comment cannot contradict it.
 * Reviews are deliberately not included — this comment lists what the author has to fix.
 */
export const handleMessage = (result: QAChecksResult) => {
	const failures = result.steps.filter((step) => !step.passed);

	if (failures.length === 0) {
		return ['Looks like this PR is ready to merge! 🎉', troubleMessage].join('\n');
	}

	return [
		`Looks like this PR is not ready to merge, because of the following issues:`,
		...failures.map((step) => `- ${step.message ?? step.name}`),

		'',
		`Please fix the issues and try again`,
		'',
		troubleMessage,
	].join('\n');
};
