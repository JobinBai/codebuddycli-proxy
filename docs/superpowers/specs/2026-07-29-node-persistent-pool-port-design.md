# Node Persistent Pool Port Design

## Goal

Move the verified Python three-CLI persistent pool into the Node proxy, preserve the existing OpenAI-compatible behavior, and remove the Python implementation only after Node passes unit and real concurrency verification.

## SDK Interface

Use the official exported `unstable_v2_createSession` API. Each worker owns one Session and uses:

- `connect()` for CLI prewarm;
- `send()` and `stream()` for each turn;
- `setModel()` for worker-local model selection;
- `interrupt()` for active cancellation;
- `close()` for invalidation and shutdown.

The API is marked unstable by the SDK, but it is the only public Node interface intended for persistent multi-turn CLI use. The existing one-shot `query()` path remains available when `PERSISTENT_CLIENT=0`.

## Pool Behavior

- Default to `PERSISTENT_CLIENTS=3`.
- Warm three sessions concurrently before the HTTP server begins listening.
- Lease ready workers through a FIFO queue.
- Hold a worker exclusively for the full response stream.
- Run `/clear` after a response and return the worker only after cleanup completes.
- Bound queue waiting with `QUEUE_TIMEOUT_MS`.
- Rebuild only the failed worker with bounded retry backoff.

## Request Compatibility

Keep the existing HTTP routes, authentication, model list, images, reasoning output, function-call conversion, usage mapping, and SSE structure.

Persistent sessions use a static system guard. Dynamic per-request operating rules and function schemas are prefixed to the serialized prompt. Built-in CLI tools, MCP, filesystem settings, and session persistence remain disabled.

The stream wrapper forwards SDK partial text immediately. Its tool-tag filter buffers only a suffix that could become `<tool_call`, rather than an unconditional character window.

## Health, Timing, and Errors

`/health` reports pool size, healthy/available/busy/cleaning/rebuilding counts, queue depth, and per-worker state, generation, served requests, and warm-up time.

Timing logs include `queue_wait_ms`, `backend_worker`, `backend_generation`, and `backend_reused`. Persistent cumulative `duration_api_ms` is converted to a per-request value.

Non-streaming queue timeout returns HTTP 503. Streaming requests emit an SSE error because response headers have already been sent.

## Testing

- Preserve existing Node unit tests.
- Inject a fake Session factory for pool tests.
- Verify three simultaneous requests occupy three clients.
- Verify a fourth waits until cleanup returns a worker.
- Verify bounded queue timeout.
- Verify one worker rebuilds without closing healthy workers.
- Verify cumulative API duration adjustment and immediate normal text streaming.
- Run the full Node test suite and syntax checks.
- Start three real Node sessions and send three concurrent `hy3` requests.

## Python Removal

After Node verification:

1. Stop the currently running Python pool.
2. Confirm no Python proxy or Python-owned `codebuddy-headless` processes remain.
3. Move `codebuddycli-proxy-py` out of the workspace into the macOS Trash with a timestamped name.
4. Report the Trash location and recovery option.

## Acceptance Criteria

- Node exposes three healthy persistent workers.
- Three real requests run on distinct workers concurrently.
- Existing OpenAI behavior and all tests pass.
- No secret is written to the repository.
- Python proxy is absent from the workspace and recoverable from Trash.
