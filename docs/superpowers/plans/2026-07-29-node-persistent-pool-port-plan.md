# Node Persistent Pool Port Implementation Plan

1. Add persistent-pool configuration and static session prompt.
2. Extend timing fields and fix streaming suffix buffering.
3. Implement Session worker lifecycle, FIFO leasing, cleanup, queue timeout, and independent rebuild.
4. Route chat requests through the pool while retaining the one-shot fallback.
5. Make server startup/shutdown manage the pool and extend `/health`.
6. Add fake-session pool tests and preserve existing query tests.
7. Update Node documentation and runtime configuration examples.
8. Run tests, syntax checks, secret scan, and real three-session concurrency verification.
9. Stop the Python service and move its directory to Trash.
