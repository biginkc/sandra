"""Deterministic, bounded controller for Sandra Sentry repair intake.

The package is deliberately stdlib-only. It records work and evidence but does
not install a scheduler, send notifications, merge code, or deploy anything.
"""

__all__ = ["store", "schedule", "sentry", "dispatch", "prompts", "validation"]

