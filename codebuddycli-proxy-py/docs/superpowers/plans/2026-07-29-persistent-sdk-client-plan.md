# Persistent SDK Client Implementation Plan

1. Extend settings with a persistent-client switch enabled by default and expose backend readiness in health output.
2. Add a backend abstraction and `PersistentCodeBuddyBackend` with lifecycle, serialization, model switching, `/clear`, message observation, and unhealthy-client rebuilding.
3. Wire FastAPI lifespan and request streaming to the persistent backend while retaining injectable one-shot query factories.
4. Add timing fields for queue wait, connection generation, and persistent reuse.
5. Add fake-client unit tests for reuse, reset, serialization, and recovery; update API tests for lifespan behavior.
6. Update README configuration and explain cold versus warm timing.
7. Run compilation, all tests, package command/health validation, secret scan, and a two-request real `hy3` benchmark.
