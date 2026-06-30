"""vmkit typed errors → HTTP status codes.

``map_vmkit_error`` is the single source of truth for the status/detail a vmkit
exception maps to. It is reused in two places:

* ``register_exception_handlers(app)`` — wires it to FastAPI so HTTP routes that
  let a vmkit error propagate get the right status, as a ``{"detail": ...}`` body
  matching FastAPI/Pydantic's own error format (one error-parsing branch for callers).
* ``app.core.jobs.runner`` — long-running ops run off-request (over WebSocket),
  where there is no HTTP response to attach a handler to, so the runner maps the
  error itself into a terminal progress message.

The table is ordered most-specific first; lookup walks it by ``isinstance`` so the
base-class catch-all (``VmkitError`` → 500) fires only when nothing else matches.
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from vmkit.errors import (
    AuthenticationError,
    ConnectionFailedError,
    InsufficientSpaceError,
    ValidationError,
    VmExistsError,
    VmkitError,
    VmNotFoundError,
)

# Most-specific first; VmkitError (base) is the catch-all and must stay last.
_ERROR_STATUS: tuple[tuple[type[VmkitError], int], ...] = (
    (ValidationError, 422),
    (AuthenticationError, 401),
    (ConnectionFailedError, 502),
    (VmExistsError, 409),
    (VmNotFoundError, 404),
    (InsufficientSpaceError, 409),
    (VmkitError, 500),
)


def map_vmkit_error(exc: VmkitError) -> tuple[int, str]:
    """Return the ``(status_code, detail)`` for a vmkit exception."""
    for exc_type, status in _ERROR_STATUS:
        if isinstance(exc, exc_type):
            return status, str(exc)
    return 500, str(exc)


def register_exception_handlers(app: FastAPI) -> None:
    """Attach a single vmkit-error→HTTP handler to *app*.

    Registered on the ``VmkitError`` base so FastAPI dispatches every subclass to
    it; the concrete status comes from ``map_vmkit_error``.
    """

    @app.exception_handler(VmkitError)
    async def _vmkit_error(request: Request, exc: VmkitError) -> JSONResponse:
        status, detail = map_vmkit_error(exc)
        return JSONResponse(status_code=status, content={"detail": detail})
