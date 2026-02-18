# ADR-002: Storage Architecture

## Status

Accepted

## Context

Crush is a Chrome MV3 extension that will run an LLM coding agent inside the side panel. The agent needs three kinds of persistent state:

1. **Workspace files** — source code, notes, and other documents that the agent reads, edits, and creates through tool calls (read_file, edit_file, list_files, write_file).
2. **API keys** — credentials for LLM providers (Anthropic, OpenAI, etc.), entered by the user and needed on every agent turn.
3. **User preferences** — selected provider/model, UI settings, and other configuration that should survive browser restarts.

Chrome MV3 extensions have several storage options, each with different trade-offs:

- **`chrome.storage.local`**: key-value, 10 MB default (unlimited with `unlimitedStorage`), available in all extension contexts (side panel, service worker, content scripts), simple async API, persisted across sessions.
- **OPFS (Origin Private File System)**: hierarchical file system, no size limit, available in extension pages and dedicated workers but *not* in service workers, supports streaming writes and sync access handles in workers.
- **IndexedDB**: structured storage with indexes, available everywhere, good for searchable records like conversation history.
- **File System Access API**: real disk access via user-granted directory handles, requires a user gesture, only available in extension pages with a visible DOM.

The agent loop runs in the side panel (not the service worker) to avoid MV3 service worker suspension after 30 seconds of idle time. This means both OPFS and chrome.storage.local are accessible from the primary runtime context.

## Decision

We adopt a layered storage architecture:

**`chrome.storage.local` for API keys and settings.** These are small, infrequently written key-value pairs. chrome.storage.local is the natural fit: it is available in every extension context (including the service worker for future RPC use), has a simple get/set API, and Chrome manages persistence and sync. API keys are stored under `crush:auth:<provider>` keys. Settings are stored under `crush:settings` as a single JSON object.

**OPFS for workspace files.** Agent file tools operate on a virtual filesystem rooted at `crush/workspaces/<id>/` inside OPFS. OPFS provides a real hierarchical filesystem API without requiring user permission prompts. Files can be arbitrarily large, directories can be listed and traversed, and the API supports streaming writes. The `WorkspaceFS` interface abstracts the filesystem so that alternative backends (in-memory for testing, File System Access API for real disk access) can be swapped in without changing tool implementations.

**Deferred: IndexedDB for conversation history.** Not needed yet. When we add conversation persistence and search, IndexedDB's indexed queries will be the right tool.

**Deferred: File System Access API for real disk access.** A future `FsaWorkspaceFS` implementation can wrap `showDirectoryPicker()` handles, giving the agent read/write access to a user-selected directory on the real filesystem. This requires a user gesture and explicit permission grant.

Both storage layers are accessed from the side panel context. The `StorageBackend` interface (wrapping chrome.storage.local) and `WorkspaceFS` interface (wrapping OPFS) are pluggable — each has an in-memory implementation for testing and for contexts where browser APIs are unavailable.

## Consequences

- Agent file tools (read_file, edit_file, list_files) will call through `WorkspaceFS` rather than directly using OPFS APIs, following the pluggable operations pattern from pi-mono's tool implementations.
- API keys never touch OPFS or IndexedDB — they stay in chrome.storage.local, which Chrome encrypts at rest on most platforms.
- OPFS contents are wiped when the extension is uninstalled. Users who want durable workspace files should use the File System Access API integration (future work).
- The in-memory implementations (`MemoryWorkspaceFS`, `MemoryStorageBackend`) enable unit testing without browser APIs.
- Adding a new storage backend (e.g., WebSocket-backed remote filesystem) requires only implementing the `WorkspaceFS` interface.
