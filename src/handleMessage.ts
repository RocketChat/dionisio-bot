export const handleMessage = async ({
  assured,
  hasConflicts,
  mergeable,
  hasMilestone,
}: {
  assured: boolean;
  hasConflicts: boolean;
  mergeable: boolean;
  hasMilestone: boolean;
}) => {
  const messages: string[] = [];

  if (hasConflicts) {
    messages.push("This PR has conflicts, please resolve them before merging");
  }

  if (!assured) {
    messages.push("This PR is missing the 'stat: QA assured' label");
  }

  if (!mergeable) {
    messages.push("This PR is not mergeable");
  }

  if (!hasMilestone) {
    messages.push("This PR is missing the required milestone");
  }

  if (messages.length === 0) {
    return [
      "Looks like this PR is ready to merge! 🎉",
      `If you have any trouble, please check the [PR guidelines](https://handbook.rocket.chat/departments-and-operations/research-and-development/engineering/development/pr-general-instructions-and-handling)`,
    ].join("\n");
  }

  return [
    `Looks like this PR is not ready to merge, because of the following issues:`,
    ...messages.map((message) => `- ${message}`),
    `Please fix the issues and try again`,
    `If you have any trouble, please check the [PR guidelines](https://handbook.rocket.chat/departments-and-operations/research-and-development/engineering/development/pr-general-instructions-and-handling)`,
  ].join("\n");
};
