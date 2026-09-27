from concurrent.futures import ThreadPoolExecutor

from backend.app.modules.data_twin.store import DigitalTwinStore


def test_store_thread_safe_read_replace_smoke(twin_state):
    store = DigitalTwinStore(twin_state)
    def operation(i):
        return store.get() if i % 2 else store.replace(store.get())
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(operation, range(100)))
    assert len(results) == 100
    assert all(result is not None for result in results)


def test_orchestrator_serializes_concurrent_cycles(twin_state, test_settings):
    from concurrent.futures import ThreadPoolExecutor
    from backend.app.orchestrator import SolarNavOrchestrator

    store = DigitalTwinStore(twin_state)
    orchestrator = SolarNavOrchestrator(store=store, settings=test_settings)
    initial_time = store.get().timestamp

    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(lambda _: orchestrator.run_cycle(step_minutes=1), range(10)))

    final_time = store.get().timestamp
    assert (final_time - initial_time).total_seconds() == 10 * 60
