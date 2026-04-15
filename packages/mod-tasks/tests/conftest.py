import pytest


@pytest.fixture(autouse=True)
def _set_anyio_backend():
    pass
