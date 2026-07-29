# Persistent CodeBuddy SDK Client Design

## Goal

Move CodeBuddy CLI initialization out of each Chat Completions request. The service will keep one Python SDK client alive and serialize requests through it. The target is to reduce warm-request time to first text from roughly 9.7 seconds toward the upstream API time (roughly 2 seconds in the first Python benchmark).

## Scope

- One persistent `CodeBuddySDKClient` per proxy process.
- One active generation at a time; later requests wait in FIFO lock order.
- Preserve the existing OpenAI-compatible HTTP contract, timing logs, images, reasoning output, and function-call conversion.
- Keep the existing one-shot backend available for tests and as a safe fallback.
- No Docker or deployment changes.

## Architecture

A new `PersistentCodeBuddyBackend` owns the SDK client, an `asyncio.Lock`, and connection health state. FastAPI starts and warms it during application lifespan and disconnects it during shutdown.

The SDK client is initialized with a static proxy guard. Per-request operating instructions, including dynamic function schemas, are placed before the serialized conversation in the user request. This avoids rebuilding the process when the request changes model or functions. The public SDK `set_model()` method changes models between serialized requests.

## Request Flow

1. Validate and translate the OpenAI request exactly as the current service does.
2. Wait for the backend lock.
3. Ensure the persistent client is connected.
4. Send `/clear` and drain its response before the request when the client has already served a request.
5. Select the requested model.
6. Send the request-specific guard plus serialized conversation.
7. Yield SDK messages incrementally to the existing OpenAI stream adapter.
8. On success, retain the process for the next request.
9. On timeout, cancellation, closed stdout, or protocol error, disconnect and mark the client unhealthy. The next request creates a clean process.

The first startup warm-up sends `/clear`, so SDK/CLI initialization happens before the service reports startup complete. The health endpoint reports persistent backend readiness and queue state.

## Isolation and Concurrency

`/clear` is the CLI's built-in new-conversation command and is used between unrelated OpenAI requests. Because only one request can use the process at a time, response streams cannot interleave and model changes cannot race.

Queue waiting is included in proxy total time but excluded from SDK API duration. The implementation logs queue wait and connection generation so congestion can be distinguished from upstream latency.

## Error Handling

- A failed warm-up does not crash the web process; readiness is false and the first request retries connection creation.
- A failed current stream is returned using the existing OpenAI-compatible error path.
- No automatic mid-stream replay occurs because that could duplicate text or repeat side effects.
- Failed cleanup discards the client instead of risking cross-request context contamination.
- The next request reconnects once through the normal ensure-connected path.

## Testing

- Unit-test connection reuse, serial locking, `/clear`, model switching, cleanup, and rebuild after failure with a fake SDK client.
- Retain all current compatibility and HTTP tests.
- Run a real two-request `hy3` benchmark in one server process.
- Compare cold initialization, warm first SDK message, warm first text, upstream API duration, and total time.

## Acceptance Criteria

- All existing and new tests pass.
- Two sequential requests use one CLI process when healthy.
- The second request is preceded by `/clear`.
- A client error causes the following request to create a new client.
- A real warm request has materially lower pre-API overhead than the existing one-shot Python request, or logs provide evidence that the SDK itself cannot remove that overhead.
- No API key is written to the repository.
