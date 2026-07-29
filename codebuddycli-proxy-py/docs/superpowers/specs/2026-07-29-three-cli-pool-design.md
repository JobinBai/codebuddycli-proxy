# Three-CLI Persistent Pool Design

## Goal

Allow three agents to generate concurrently without paying per-request CLI initialization. The proxy will keep three independent CodeBuddy SDK clients alive, while bounding memory and preventing streams or model changes from sharing a client.

## Configuration

- `PERSISTENT_CLIENTS=3` controls pool size and defaults to three.
- `QUEUE_TIMEOUT_MS=600000` limits how long a request may wait for a worker.
- `PERSISTENT_CLIENT=0` remains the compatibility switch for one-shot SDK queries.

## Worker Lifecycle

Each worker owns one `CodeBuddySDKClient`, generation counter, API-duration baseline, readiness state, served-request count, and cleanup state.

All three workers warm concurrently during FastAPI startup. A warm-up failure leaves only that worker unavailable and schedules rebuilding; it does not stop the service or other workers. Shutdown disconnects all workers.

After a successful response, the leased worker runs `/clear` before it becomes available again. The HTTP response can finish before cleanup, but the worker is not returned to the available queue until cleanup succeeds. A cleanup or protocol failure discards and rebuilds only that worker.

## Scheduling

An `asyncio.Queue` contains ready worker IDs. A request waits for the next available worker with `QUEUE_TIMEOUT_MS`; queue order is FIFO. The worker remains exclusively leased for the complete SDK response stream.

At most three SDK generations can run simultaneously. A fourth request waits until one of the three workers completes response cleanup. Cancellation while waiting removes only that request. Cancellation or failure while active invalidates only its leased worker.

## Session Isolation

Workers never handle overlapping requests. `/clear` runs between unrelated requests before a worker is returned to the pool. Request-specific operating rules and tool schemas remain embedded in each prompt. Different agents may select different models because model changes are worker-local.

## Health and Timing

`/health` reports:

- configured pool size;
- ready, busy, cleaning, and rebuilding counts;
- queued request count;
- per-worker generation, readiness, state, served requests, and warm-up time.

Request logs retain `queue_wait_ms`, `backend_generation`, and `backend_reused`, and add `backend_worker`.

## Failure and Capacity Behavior

- Worker failure: current request receives the existing SDK error; that worker rebuilds in the background.
- Pool degradation: remaining healthy workers continue serving requests.
- No available worker before queue timeout: return a 503/stream error describing pool saturation.
- Entire pool unavailable: requests continue waiting up to queue timeout while rebuilds run.
- Memory is expected to be approximately 55 MB plus 436 MB per worker, or about 1.36 GB for three workers on the measured machine.

## Testing

- Three requests enter three different fake clients concurrently.
- A fourth request remains queued until a worker is cleaned and returned.
- A failed worker is replaced without changing healthy workers.
- Queue timeout produces a bounded failure.
- Pool start and stop handle all workers.
- Existing OpenAI compatibility and streaming tests continue to pass.

## Acceptance Criteria

- Default pool size is three.
- Three simultaneous requests can reach SDK generation concurrently.
- A fourth request cannot enter a worker until one is clean.
- Worker failures do not discard healthy clients.
- All tests, compilation, diff checks, and secret scans pass.
- A controlled real startup exposes three ready workers in `/health`.
