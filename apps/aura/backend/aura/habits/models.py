"""Habit + HabitLog dataclasses returned by service methods."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Habit:
    id: str
    user_id: str
    name: str
    color: str
    target_per_week: int
    archived: bool
    created_at: str
    done_today: bool = False
    streak: int = 0
    week_done_count: int = 0


@dataclass
class HabitLogEntry:
    habit_id: str
    date: str
    done: bool
