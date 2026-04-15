"""mod-calendar — provider-agnostic calendar contract.

Phase 8 ships only the Protocol + types. Today the only concrete
implementation is ``google_integration.client.GoogleClient`` which
already conforms (its method signatures predate this Protocol).

Future work (deferred to Aura phase or beyond):
- ``mod_calendar.local`` — a core-db backed in-house calendar so apps
  without Google integration still have a usable calendar surface.
- ``mod_calendar.routes`` — generic /calendar/* routes that take a
  CalendarProvider via app state, instead of mounting Google routes
  directly.
"""

from mod_calendar.protocol import CalendarProvider

__all__ = ["CalendarProvider"]
