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
  const messages: string[] = [
    `If you have any trouble, please check the [PR guidelines](https://handbook.rocket.chat/departments-and-operations/research-and-development/engineering/development/pr-general-instructions-and-handling)`,
  ];

  if (hasConflicts) {
    messages.unshift(
      "This PR has conflicts, please resolve them before merging"
    );
  }

  if (!assured) {
    messages.unshift("This PR is missing the 'stat: QA assured' label");
  }

  if (!mergeable) {
    messages.unshift("This PR is not mergeable");
  }

  if (!hasMilestone) {
    messages.unshift("This PR is missing the required milestone or project");
  }

  if (messages.length === 0) {
    return ["Looks like this PR is ready to merge! 🎉"].join("\n");
  }

  return [
    `Looks like this PR is not ready to merge, because of the following issues:`,
    ...messages.map((message) => `- ${message}`),
    `Please fix the issues and try again`,
  ].join("\n");
};
