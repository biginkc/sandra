"""America/Chicago schedule with UTC slot identity and once-only claims."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


CHICAGO = ZoneInfo("America/Chicago")


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return value.astimezone(timezone.utc)


def slot_identity(value: datetime) -> str:
    """Use UTC so repeated DST-fallback wall times remain distinct."""

    return as_utc(value).replace(second=0, microsecond=0).isoformat().replace("+00:00", "Z")


def cadence_minutes(value: datetime) -> int:
    local = as_utc(value).astimezone(CHICAGO)
    return 15 if 6 <= local.hour < 21 else 30


def current_slot(value: datetime) -> datetime:
    """Return the local wall-clock slot containing value, retaining DST fold."""

    local = as_utc(value).astimezone(CHICAGO)
    cadence = cadence_minutes(local)
    local = local.replace(minute=(local.minute // cadence) * cadence, second=0, microsecond=0)
    return local.astimezone(timezone.utc)


def iter_slots(start: datetime, end: datetime) -> list[datetime]:
    """Enumerate slots in [start, end), evaluating day/night in local time."""

    start_utc, end_utc = as_utc(start), as_utc(end)
    cursor = start_utc.replace(second=0, microsecond=0)
    if cursor < start_utc:
        cursor += timedelta(minutes=1)
    result: list[datetime] = []
    while cursor < end_utc:
        local = cursor.astimezone(CHICAGO)
        cadence = 15 if 6 <= local.hour < 21 else 30
        if local.minute % cadence == 0:
            result.append(cursor)
        cursor += timedelta(minutes=1)
    return result


def due_slot(value: datetime, store) -> tuple[str, datetime] | None:
    """Claim the current slot once; callers can then run bounded intake.

    A caller that resumes after downtime intentionally claims only the current
    slot. Missed historical slots are not replayed.
    """

    slot = current_slot(value)
    identity = slot_identity(slot)
    if store.claim_scheduler_slot(identity, slot.timestamp(), now=as_utc(value).timestamp()):
        return identity, slot
    return None
