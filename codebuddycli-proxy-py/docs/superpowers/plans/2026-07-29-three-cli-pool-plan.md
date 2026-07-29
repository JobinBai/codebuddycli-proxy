# Three-CLI Pool Implementation Plan

1. Add pool-size and queue-timeout settings with validation.
2. Split the persistent backend into independent worker state and pool scheduling.
3. Warm workers concurrently, lease them through a FIFO queue, clean before release, and rebuild failures independently.
4. Extend timing logs and `/health` with worker and pool state.
5. Replace single-client tests with pool lifecycle, three-way concurrency, fourth-request queueing, timeout, and recovery tests.
6. Update README configuration, memory expectations, and concurrency semantics.
7. Run all tests, compilation, diff checks, secret scan, and a real three-worker readiness check.
