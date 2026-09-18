import { nextLabels } from '../src/handleQALabels';

describe('nextLabels', () => {
	test('applies the additions and removals this run decided on', () => {
		expect(nextLabels(['stat: conflict'], ['stat: ready to merge'], ['stat: conflict'])).toEqual(['stat: ready to merge']);
	});

	// setLabels replaces the whole set, so anything added between the event and the write
	// used to be silently dropped.
	test('keeps labels the bot has no opinion about', () => {
		const result = nextLabels(['needs design', 'stat: conflict'], ['stat: ready to merge'], ['stat: conflict']);

		expect(result).toContain('needs design');
	});

	test('keeps a label a human added after the event was received', () => {
		expect(nextLabels(['priority: high'], [], [])).toEqual(['priority: high']);
	});

	test('does not duplicate a label that is already present', () => {
		expect(nextLabels(['community'], ['community'], [])).toEqual(['community']);
	});

	test('restores a managed label that was removed by hand', () => {
		expect(nextLabels([], ['stat: ready to merge'], [])).toEqual(['stat: ready to merge']);
	});

	test('removal wins when a label is both added and removed', () => {
		expect(nextLabels(['stat: QA tested'], ['stat: QA assured'], ['stat: QA tested'])).toEqual(['stat: QA assured']);
	});
});
