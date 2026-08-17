/*
 * Dependency-free tag matching and lightweight metadata suggestions for the save popup.
 * Kept separate from React so ranking can be benchmarked and tested directly.
 */
(function (root, factory) {
	const api = factory();
	root.ZoteroTagMatcher = api;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	}
})(typeof window !== "undefined" ? window : globalThis, function () {
	"use strict";

	const DEFAULT_LIMIT = 8;
	const STOP_WORDS = new Set([
		"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into",
		"is", "it", "of", "on", "or", "our", "that", "the", "their", "this", "to", "using",
		"via", "was", "we", "were", "with"
	]);
	const GENERIC_WORDS = new Set([
		"analysis", "approach", "article", "data", "method", "methods", "paper", "research",
		"result", "results", "study", "system"
	]);

	function normalize(value) {
		return String(value || "")
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLocaleLowerCase()
			.replace(/[’'`]/g, "")
			.replace(/[^a-z0-9]+/g, " ")
			.trim()
			.replace(/\s+/g, " ");
	}

	function prepare(tag, order = 0) {
		const normalized = normalize(tag);
		return {
			tag: String(tag || "").trim(),
			normalized,
			compact: normalized.replace(/\s+/g, ""),
			tokens: normalized ? normalized.split(" ") : [],
			order
		};
	}

	function createIndex(tags) {
		const seen = new Set();
		const index = [];
		for (const tag of tags || []) {
			const entry = prepare(typeof tag === "object" ? tag.tag : tag, index.length);
			if (!entry.tag || !entry.normalized || seen.has(entry.normalized)) {
				continue;
			}
			seen.add(entry.normalized);
			index.push(entry);
		}
		return index;
	}

	function editDistance(left, right, maximum = Infinity) {
		if (left === right) return 0;
		if (!left.length) return right.length;
		if (!right.length) return left.length;
		if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
		if (left.length > right.length) [left, right] = [right, left];
		let previous = Array.from({ length: left.length + 1 }, (_, index) => index);
		for (let row = 1; row <= right.length; row++) {
			const current = [row];
			let rowMinimum = row;
			for (let column = 1; column <= left.length; column++) {
				const value = Math.min(
					current[column - 1] + 1,
					previous[column] + 1,
					previous[column - 1] + (left[column - 1] === right[row - 1] ? 0 : 1)
				);
				current[column] = value;
				rowMinimum = Math.min(rowMinimum, value);
			}
			if (rowMinimum > maximum) return maximum + 1;
			previous = current;
		}
		return previous[left.length];
	}

	function subsequenceScore(query, candidate) {
		if (!query || query.length > candidate.length) return 0;
		let queryIndex = 0;
		let first = -1;
		let last = -1;
		for (let index = 0; index < candidate.length && queryIndex < query.length; index++) {
			if (candidate[index] === query[queryIndex]) {
				if (first < 0) first = index;
				last = index;
				queryIndex++;
			}
		}
		if (queryIndex !== query.length) return 0;
		const span = last - first + 1;
		return 0.46 + (query.length / span) * 0.25 + (query.length / candidate.length) * 0.17;
	}

	function tokenSimilarity(queryToken, candidateToken) {
		if (queryToken === candidateToken) return 1;
		if (candidateToken.startsWith(queryToken)) return 0.97;
		if (queryToken.length < 3 || candidateToken.length < 3) return 0;
		const maximum = queryToken.length < 5 ? 1 : 2;
		const distance = editDistance(queryToken, candidateToken, maximum);
		if (distance > maximum) return 0;
		return 1 - distance / Math.max(queryToken.length, candidateToken.length);
	}

	function scorePrepared(query, candidate) {
		if (!query.normalized || !candidate.normalized) return 0;
		if (query.normalized === candidate.normalized) return 1;
		if (query.compact === candidate.compact) return 0.995;
		if (candidate.normalized.startsWith(query.normalized)) return 0.98;
		if (candidate.tokens.some(token => token.startsWith(query.normalized))) return 0.95;
		if (candidate.normalized.includes(query.normalized)) return 0.92;

		const tokenScores = query.tokens.map(queryToken => {
			return candidate.tokens.reduce((best, candidateToken) => {
				return Math.max(best, tokenSimilarity(queryToken, candidateToken));
			}, 0);
		});
		let tokenScore = 0;
		if (tokenScores.length && tokenScores.every(score => score >= 0.62)) {
			const average = tokenScores.reduce((sum, score) => sum + score, 0) / tokenScores.length;
			const exactCoverage = tokenScores.filter(score => score >= 0.97).length / tokenScores.length;
			tokenScore = average * 0.89 + exactCoverage * 0.07;
		}

		let phraseScore = 0;
		if (query.compact.length <= 48 && candidate.compact.length <= 48) {
			const maximum = query.compact.length < 5 ? 1 : Math.max(2, Math.floor(query.compact.length * 0.28));
			const distance = editDistance(query.compact, candidate.compact, maximum);
			if (distance <= maximum) {
				phraseScore = 1 - distance / Math.max(query.compact.length, candidate.compact.length);
			}
		}

		return Math.max(tokenScore, phraseScore, subsequenceScore(query.compact, candidate.compact));
	}

	function selectedKeys(selectedTags) {
		return new Set(Array.from(selectedTags || []).map(normalize).filter(Boolean));
	}

	function rank(indexOrTags, query, selectedTags, limit = DEFAULT_LIMIT) {
		const index = Array.isArray(indexOrTags) && indexOrTags.every(entry => entry && entry.normalized !== undefined)
			? indexOrTags
			: createIndex(indexOrTags);
		const preparedQuery = prepare(query);
		if (!preparedQuery.normalized) return [];
		const excluded = selectedKeys(selectedTags);
		const threshold = preparedQuery.compact.length < 3 ? 0.82
			: preparedQuery.compact.length < 5 ? 0.58 : 0.48;
		return index
			.filter(entry => !excluded.has(entry.normalized))
			.map(entry => ({
				tag: entry.tag,
				score: scorePrepared(preparedQuery, entry),
				kind: "existing",
				sources: []
			}))
			.filter(result => result.score >= threshold)
			.sort((left, right) => right.score - left.score
				|| left.tag.localeCompare(right.tag, undefined, { sensitivity: "base" }))
			.slice(0, Math.max(0, Number(limit) || 0));
	}

	function metadataTokens(item) {
		const title = normalize(item?.title);
		const abstract = normalize(String(item?.abstract || "").slice(0, 6000));
		return {
			title,
			abstract,
			all: new Set((title + " " + abstract).trim().split(/\s+/).filter(Boolean))
		};
	}

	function suggestion(tag, score, kind, sources) {
		return { tag: String(tag || "").trim(), score, kind, sources };
	}

	function extractPhrases(text, baseScore, maximum) {
		const results = [];
		for (const segment of String(text || "").split(/[.!?;:|\u2013\u2014]+/)) {
			let run = [];
			const flush = () => {
				if (run.length >= 2) {
					const width = Math.min(4, run.length);
					results.push(suggestion(run.slice(0, width).join(" "), baseScore, "new", ["metadata"]));
					if (run.length > width) {
						results.push(suggestion(run.slice(-Math.min(3, run.length)).join(" "), baseScore - 0.04, "new", ["metadata"]));
					}
				}
				run = [];
			};
			for (const token of normalize(segment).split(" ").filter(Boolean)) {
				if (STOP_WORDS.has(token) || GENERIC_WORDS.has(token)) flush();
				else run.push(token);
			}
			flush();
			if (results.length >= maximum) break;
		}
		return results.slice(0, maximum);
	}

	function contextual(item, indexOrTags, selectedTags, limit = DEFAULT_LIMIT) {
		if (!item) return [];
		const index = Array.isArray(indexOrTags) && indexOrTags.every(entry => entry && entry.normalized !== undefined)
			? indexOrTags
			: createIndex(indexOrTags);
		const excluded = selectedKeys(selectedTags);
		const metadata = metadataTokens(item);
		const results = [];

		for (const entry of index) {
			if (excluded.has(entry.normalized)) continue;
			const phraseMatch = (metadata.title && (` ${metadata.title} `).includes(` ${entry.normalized} `))
				|| (metadata.abstract && (` ${metadata.abstract} `).includes(` ${entry.normalized} `));
			const tokenMatch = entry.tokens.length > 0 && entry.tokens.every(token => metadata.all.has(token));
			if (phraseMatch || tokenMatch) {
				results.push(suggestion(entry.tag, phraseMatch ? 0.96 : 0.82, "existing", ["metadata"]));
			}
		}

		for (const imported of item.tags || []) {
			const value = typeof imported === "object" ? imported.tag : imported;
			const key = normalize(value);
			if (!key || excluded.has(key)) continue;
			const existing = index.find(entry => entry.normalized === key);
			results.push(suggestion(existing?.tag || value, 0.9, existing ? "existing" : "new", ["metadata"]));
		}

		results.push(...extractPhrases(item.title, 0.72, 4));
		results.push(...extractPhrases(String(item.abstract || "").slice(0, 1800), 0.54, 3));
		return mergeSuggestions(results, [], "", selectedTags, limit);
	}

	function mergeSuggestions(primary, secondary, query = "", selectedTags, limit = DEFAULT_LIMIT) {
		const excluded = selectedKeys(selectedTags);
		const byKey = new Map();
		for (const candidate of [...(primary || []), ...(secondary || [])]) {
			const key = normalize(candidate?.tag);
			if (!key || excluded.has(key)) continue;
			const sources = [...new Set((candidate.sources || []).map(source => {
				return source === "keyphrase" ? "metadata" : source === "model" ? "ai" : source;
			}).filter(Boolean))];
			const normalizedCandidate = {
				tag: String(candidate.tag).trim(),
				score: Math.max(0, Math.min(1, Number(candidate.score) || 0)),
				kind: candidate.kind === "new" ? "new" : "existing",
				sources
			};
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, normalizedCandidate);
			}
			else {
				existing.score = Math.max(existing.score, normalizedCandidate.score);
				existing.sources = [...new Set([...existing.sources, ...normalizedCandidate.sources])];
				if (existing.kind === "new" && normalizedCandidate.kind === "existing") {
					existing.kind = "existing";
					existing.tag = normalizedCandidate.tag;
				}
			}
		}

		const preparedQuery = prepare(query);
		return [...byKey.values()]
			.map(candidate => {
				if (!preparedQuery.normalized) return candidate;
				const match = scorePrepared(preparedQuery, prepare(candidate.tag));
				return { ...candidate, matchScore: match, rankScore: match * 0.74 + candidate.score * 0.26 };
			})
			.filter(candidate => !preparedQuery.normalized || candidate.matchScore >= (preparedQuery.compact.length < 3 ? 0.82 : 0.48))
			.sort((left, right) => (right.rankScore ?? right.score) - (left.rankScore ?? left.score)
				|| (left.kind === right.kind ? 0 : left.kind === "existing" ? -1 : 1)
				|| left.tag.localeCompare(right.tag, undefined, { sensitivity: "base" }))
			.slice(0, Math.max(0, Number(limit) || 0));
	}

	class RequestTracker {
		constructor() {
			this.identity = "";
			this.sequence = 0;
		}
		reset(identity) {
			this.identity = String(identity || "");
			this.sequence++;
		}
		start(identity) {
			const value = String(identity || "");
			if (value !== this.identity) this.reset(value);
			return { identity: value, sequence: ++this.sequence };
		}
		isCurrent(request, identity) {
			return !!request && request.identity === String(identity || "")
				&& request.identity === this.identity && request.sequence === this.sequence;
		}
	}

	function isSingleItemPayload(payload) {
		return !!payload && payload.itemCount === 1 && !!payload.item;
	}

	return {
		DEFAULT_LIMIT,
		normalize,
		prepare,
		createIndex,
		editDistance,
		scorePrepared,
		rank,
		contextual,
		mergeSuggestions,
		RequestTracker,
		isSingleItemPayload
	};
});
