import { maxBumpForMilestone, parseChangesetBumps, findInvalidBumps } from '../src/checkChangesets';

describe('maxBumpForMilestone', () => {
	test('patch milestone only allows patch', () => {
		expect(maxBumpForMilestone('7.10.1')).toBe('patch');
		expect(maxBumpForMilestone('6.5.11')).toBe('patch');
	});

	test('minor milestone allows up to minor', () => {
		expect(maxBumpForMilestone('7.10.0')).toBe('minor');
		expect(maxBumpForMilestone('7.10')).toBe('minor');
	});

	test('major milestone allows up to major', () => {
		expect(maxBumpForMilestone('8.0.0')).toBe('major');
		expect(maxBumpForMilestone('8.0')).toBe('major');
	});

	test('non-version milestones impose no restriction', () => {
		expect(maxBumpForMilestone('Backlog')).toBeNull();
		expect(maxBumpForMilestone(undefined)).toBeNull();
		expect(maxBumpForMilestone('')).toBeNull();
	});
});

describe('parseChangesetBumps', () => {
	test('parses single package', () => {
		expect(parseChangesetBumps("---\n'@rocket.chat/meteor': patch\n---\n\nFix something\n")).toEqual(['patch']);
	});

	test('parses multiple packages and quote styles', () => {
		const content = ['---', "'@rocket.chat/meteor': minor", '"@rocket.chat/ui-client": patch', '@rocket.chat/core: major', '---', '', 'desc'].join(
			'\n',
		);
		expect(parseChangesetBumps(content)).toEqual(['minor', 'patch', 'major']);
	});

	test('handles CRLF', () => {
		expect(parseChangesetBumps("---\r\n'@rocket.chat/meteor': minor\r\n---\r\ndesc")).toEqual(['minor']);
	});

	test('no frontmatter means no bumps', () => {
		expect(parseChangesetBumps('just a description')).toEqual([]);
		expect(parseChangesetBumps('')).toEqual([]);
	});

	test('ignores bump-like words outside frontmatter', () => {
		expect(parseChangesetBumps("---\n'@rocket.chat/meteor': patch\n---\n\nthis is a major: change")).toEqual(['patch']);
	});
});

describe('findInvalidBumps', () => {
	const files = [
		{ filename: '.changeset/one.md', bumps: ['patch'] as const },
		{ filename: '.changeset/two.md', bumps: ['minor', 'patch'] as const },
		{ filename: '.changeset/three.md', bumps: ['major'] as const },
	].map((f) => ({ ...f, bumps: [...f.bumps] }));

	test('patch milestone flags minor and major changesets', () => {
		expect(findInvalidBumps(files, 'patch')).toEqual([
			{ filename: '.changeset/two.md', invalid: ['minor'] },
			{ filename: '.changeset/three.md', invalid: ['major'] },
		]);
	});

	test('minor milestone flags only major changesets', () => {
		expect(findInvalidBumps(files, 'minor')).toEqual([{ filename: '.changeset/three.md', invalid: ['major'] }]);
	});

	test('major milestone flags nothing', () => {
		expect(findInvalidBumps(files, 'major')).toEqual([]);
	});
});
