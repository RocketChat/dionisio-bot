const troubleMessage = `If you have any trouble, please check the [PR guidelines](https://handbook.rocket.chat/departments-and-operations/research-and-development/engineering/development/pr-general-instructions-and-handling)`;

export const handleMessage = async ({
  assured,
  hasConflicts,
  mergeable,
  hasMilestone,
  hasInvalidTitle,
}: {
  assured: boolean;
  hasConflicts: boolean;
  mergeable: boolean;
  hasMilestone: boolean;
  hasInvalidTitle: boolean;
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
    messages.push("This PR is missing the required milestone or project");
  }

  if (hasInvalidTitle) {
    messages.push("This PR has an invalid title");
  }

  if (messages.length === 1) {
    messages.push("Looks like this PR is ready to merge! 🎉");
    return [...messages, troubleMessage].join("\n");
  }

  return [
    `Looks like this PR is not ready to merge, because of the following issues:`,
    ...messages.map((message) => `- ${message}`),
    `Please fix the issues and try again`,
    troubleMessage,
  ].join("\n");
};
