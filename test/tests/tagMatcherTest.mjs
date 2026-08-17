import { assert } from 'chai';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const matcher = require('../../src/common/ui/tagMatcher.js');

describe('TagMatcher', function () {
	it('normalizes punctuation and diacritics and deduplicates visible variants', function () {
		const index = matcher.createIndex(['Café-au-lait', 'cafe au lait', 'naïve Bayes']);
		assert.equal(index.length, 2);
		assert.equal(index[0].normalized, 'cafe au lait');
		assert.equal(index[1].normalized, 'naive bayes');
	});

	it('ranks misspellings, prefixes, token order, and subsequences deterministically', function () {
		const index = matcher.createIndex([
			'machine learning',
			'learning machine systems',
			'machining',
			'climate change'
		]);
		assert.equal(matcher.rank(index, 'machne lerning', new Set(), 8)[0].tag, 'machine learning');
		assert.include(
			matcher.rank(index, 'learning mach', new Set(), 8).slice(0, 2).map(result => result.tag),
			'machine learning'
		);
		assert.equal(matcher.rank(index, 'mlearn', new Set(), 8)[0].tag, 'machine learning');
	});

	it('excludes selected tags, caps results at eight, and uses a stable tie break', function () {
		const tags = Array.from({ length: 20 }, (_, index) => `topic ${String(index).padStart(2, '0')}`);
		const first = matcher.rank(tags, 'topic', new Set(['topic 00']), 8).map(result => result.tag);
		const second = matcher.rank(tags.slice().reverse(), 'topic', new Set(['topic 00']), 8).map(result => result.tag);
		assert.lengthOf(first, 8);
		assert.deepEqual(first, second);
		assert.notInclude(first, 'topic 00');
	});

	it('creates metadata suggestions without an optional bridge', function () {
		const suggestions = matcher.contextual({
			title: 'Ultrafast cavity ringdown spectroscopy',
			abstract: 'A laser pulse measures molecular absorption.',
			tags: ['Spectroscopy']
		}, ['spectroscopy', 'molecular absorption', 'unrelated'], new Set(), 8);
		assert.isAtMost(suggestions.length, 8);
		assert.equal(suggestions[0].kind, 'existing');
		assert.include(suggestions[0].sources, 'metadata');
	});

	it('merges contextual and AI suggestions and filters them with typed input', function () {
		const merged = matcher.mergeSuggestions([
			{ tag: 'Machine Learning', score: 0.8, kind: 'existing', sources: ['metadata'] }
		], [
			{ tag: 'machine learning', score: 0.9, kind: 'new', sources: ['ai'] },
			{ tag: 'causal inference', score: 0.82, kind: 'new', sources: ['ai'] }
		], 'machne', new Set(), 8);
		assert.lengthOf(merged, 1);
		assert.equal(merged[0].tag, 'Machine Learning');
		assert.equal(merged[0].kind, 'existing');
		assert.deepEqual(new Set(merged[0].sources), new Set(['metadata', 'ai']));
	});

	it('invalidates stale requests after a session or library change', function () {
		const tracker = new matcher.RequestTracker();
		const first = tracker.start('session-a|1');
		assert.isTrue(tracker.isCurrent(first, 'session-a|1'));
		tracker.reset('session-a|2');
		assert.isFalse(tracker.isCurrent(first, 'session-a|2'));
		const second = tracker.start('session-b|2');
		assert.isTrue(tracker.isCurrent(second, 'session-b|2'));
		assert.isFalse(tracker.isCurrent(first, 'session-b|2'));
	});

	it('enables smart suggestions for single-item payloads only', function () {
		assert.isTrue(matcher.isSingleItemPayload({ itemCount: 1, item: { title: 'One' } }));
		assert.isFalse(matcher.isSingleItemPayload({ itemCount: 2, item: null }));
		assert.isFalse(matcher.isSingleItemPayload(null));
	});

	it('keeps 10,000-tag fuzzy ranking below the p95 target', function () {
		this.timeout(5000);
		const tags = Array.from({ length: 10000 }, (_, index) => `synthetic topic ${index}`);
		tags[4321] = 'frequency comb spectroscopy';
		const index = matcher.createIndex(tags);
		const durations = [];
		for (let run = 0; run < 25; run++) {
			const started = performance.now();
			const results = matcher.rank(index, 'frequncy comb', new Set(), 8);
			durations.push(performance.now() - started);
			assert.equal(results[0].tag, 'frequency comb spectroscopy');
		}
		durations.sort((left, right) => left - right);
		const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
		assert.isBelow(p95, 50, `expected p95 < 50 ms, got ${p95.toFixed(1)} ms`);
	});
});

describe('Smart tag save-popup structure', function () {
	const progressWindow = fs.readFileSync(new URL('../../src/common/ui/ProgressWindow.jsx', import.meta.url), 'utf8');
	const pageSaving = fs.readFileSync(new URL('../../src/common/inject/pageSaving.js', import.meta.url), 'utf8');

	it('keeps AI manual, non-blocking, and keyboard/mouse accessible', function () {
		assert.match(progressWindow, /onClick=\{this\.requestAITags\}/);
		assert.match(progressWindow, /role="combobox"/);
		assert.match(progressWindow, /role="listbox"/);
		assert.match(progressWindow, /role="option"/);
		assert.match(progressWindow, /onKeyDown=\{this\.onTagsInputKeyDown\}/);
		assert.match(progressWindow, /onMouseDown=\{event => this\.onTagAutocompleteMouseDown/);
	});

	it('handles missing bridges, timeouts, and stale AI responses without changing save behavior', function () {
		assert.match(progressWindow, /mode === "fast" \? 800 : 60000/);
		assert.match(progressWindow, /The bridge is optional/);
		assert.match(progressWindow, /aiRequestTracker\.isCurrent/);
		assert.notMatch(progressWindow, /await this\.requestAITags\(\)/);
	});

	it('sends only sanitized single-item metadata and imported tags', function () {
		assert.match(pageSaving, /smartTagMetadataPayload/);
		assert.match(pageSaving, /items\.length !== 1/);
		assert.match(pageSaving, /replace\(\/\[\\u0000-\\u001F\\u007F\]\+\/g/);
		assert.match(pageSaving, /abstract: sanitizeSmartTagText/);
		assert.match(pageSaving, /authors:/);
		assert.match(pageSaving, /tags:/);
	});
});
