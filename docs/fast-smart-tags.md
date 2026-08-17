# Fast fuzzy and optional smart tag suggestions

The save popup has two independent suggestion paths:

- Fuzzy matching and lightweight title/abstract suggestions run in the connector and remain
  available when Keyword Manager, ZotSeek, or Ollama is not running.
- Author, ZotSeek, and local-model enrichment use Keyword Manager 1.1.0 through a read-only local
  endpoint. The model is called only after **AI tags** is clicked.

Smart enrichment is enabled only for a single translated item. Multi-item saves keep the same fuzzy
autocomplete, with no contextual or AI request. Suggestions are always optional: selecting one uses
Zotero's existing save-session update, and no suggestion is assigned automatically.

## Local bridge

Keyword Manager registers `POST /connector/keywordManagerSuggestions` while the plugin is running.
The connector sends sanitized bibliographic metadata:

```json
{
  "schemaVersion": 1,
  "mode": "fast",
  "libraryID": 1,
  "sessionID": "optional-completed-save-session",
  "limit": 5,
  "item": {
    "title": "...",
    "abstract": "...",
    "authors": ["..."],
    "tags": ["..."]
  }
}
```

`mode` is `fast` or `llm`. The connector cannot choose an arbitrary model; Keyword Manager uses its
stored model preference. Responses contain normalized scores, `existing`/`new` kinds, source labels,
and Ollama/ZotSeek capabilities. Optional failures return partial results.

ZotSeek is queried only when a completed save session identifies an already-saved item. The bridge
uses `findSimilar()` with a short budget and never requests indexing. The endpoint does not write to
the Zotero database.

## Development build

```sh
git submodule update --init
npm install
./build.sh -d
```

The shared build outputs are:

- `build/manifestv3` for Chrome and Edge
- `build/firefox` for Firefox
- `build/safari` for the Safari WebExtension project

Disable the official Zotero Connector while testing an unpacked custom build so only one connector
handles save actions.

## Updating from Zotero

Keep the custom work on `fuzzy-tag-search`, then replay it over the latest official connector:

```sh
git fetch upstream
git rebase upstream/master
git submodule update --init
npm install
./build.sh -d
git push --force-with-lease origin fuzzy-tag-search
```

If upstream changes unrelated code, Git normally reapplies this branch automatically. Resolve a
conflict only when upstream changes overlap the same save-popup code.

## Verification

The pure matcher test covers normalization, diacritics, punctuation, misspellings, token order,
subsequences, deterministic deduplication, selected-tag exclusion, stale request invalidation, and
single-item gating. It also measures 25 ranking runs over 10,000 synthetic tags and requires p95 to
remain below 50 ms.

Safari App Store signing and public browser-store publication are intentionally outside this branch.
