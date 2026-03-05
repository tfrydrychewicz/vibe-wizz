# Current Time Indicator — Calendar "Now" Line

## Overview

Add a horizontal line with a dot indicating the current time in the calendar time-grid views (Day, Work Week, Week). Matches the Google Calendar / Apple Calendar convention: a small filled circle on the left edge of today's column(s) with a horizontal line extending across the column width. Not shown in Month view (no time grid).

## Design Principles Applied

- **Consistency**: uses the same position formula (`((minutes - HOUR_START * 60) / 60) * hourHeight`) already used for event blocks — no new math, no new constants.
- **Reusability**: lives entirely inside `CalendarView.vue` (self-contained); no new component needed for something this small.
- **Local-first / reactive**: a `ref<Date>` updated every 60s via `setInterval`; cleaned up with `onUnmounted`.

## Visual Design

```
 07:00 │                    │
       │                    │
 08:00 │                    │
       │                    │
 09:00 │                    │
       │                    │
 10:00 ●────────────────────│   ← today's column only
       │  Interview…        │
 11:00 │                    │
```

- **Dot**: 8×8px filled circle, colour `--color-danger` (matches app's red; same variable used for destructive actions elsewhere)
- **Line**: 1px solid `--color-danger`, full column width, z-index above hour-slot grid lines but below event blocks (`z-index: 2`; events are `z-index: 1` when not dragging — bump events to `z-index: 3` to maintain layering clarity)
- **Position**: absolutely placed inside `.day-col` using `top = ((now_minutes - HOUR_START * 60) / 60) * hourHeight`
- **Visibility**: only when today's date is one of the visible columns AND current time is within `HOUR_START`–`HOUR_END` range (7am–9pm); hidden in Month view (no columns exist there anyway)

## Data Flow

```
onMounted → setInterval(60s) → nowDate ref updates
                                     │
                              nowMinutes computed
                                     │
                              nowTopPx computed (same formula as eventTopPx)
                                     │
                    v-if="isToday(col) && nowVisible" in day-col template
                              absolute div at :style="{ top: nowTopPx }"
```

## Implementation Plan

- [x] **Add `nowDate` ref** — `const nowDate = ref(new Date())` (module-level reactive, updated every minute)
- [x] **Add `nowMinutes` computed** — `nowDate.value.getHours() * 60 + nowDate.value.getMinutes()`
- [x] **Add `nowTopPx` computed** — `((nowMinutes.value - HOUR_START * 60) / 60) * hourHeight.value`
- [x] **Add `nowVisible` computed** — `true` when `nowMinutes >= HOUR_START * 60 && nowMinutes <= HOUR_END * 60` AND view mode is not `'month'`
- [x] **Start interval on mount** — `setInterval(() => { nowDate.value = new Date() }, 60_000)`; store handle; clear in `onUnmounted`
- [x] **Scroll to current time on mount** — after `nextTick`, scroll `.time-grid-scroll` so the now-line is roughly centered in the viewport (only when today is in view; skip if outside HOUR_START–HOUR_END)
- [x] **Inject now-line element** into each `.day-col` in the template — `v-if="isToday(col) && nowVisible"`:
  ```html
  <div class="now-indicator" :style="{ top: `${nowTopPx}px` }">
    <div class="now-dot" />
    <div class="now-line" />
  </div>
  ```
- [x] **Add CSS** for `.now-indicator`, `.now-dot`, `.now-line` — red colour, z-index above grid lines, pointer-events none

## Files to Modify

| File | Change |
|------|--------|
| `src/renderer/components/CalendarView.vue` | Add `nowDate` ref, `nowMinutes`/`nowTopPx`/`nowVisible` computeds, interval lifecycle, template injection, CSS |

No new files, no new IPC channels, no new components.

## CSS Variables Used

| Variable | Existing use | Here |
|----------|-------------|------|
| `--color-danger` | Destructive buttons, error states | Now-line and dot colour |

## Verification

1. `npm run dev` — open Calendar, switch to Day / Work Week / Week views
2. Confirm red dot+line appears at correct time in today's column only
3. Switch to Month view — line must not appear
4. Switch to a week that does NOT include today — line must not appear
5. Navigate back to current week — line reappears in correct column
6. Check that event blocks render above the now-line (not obscured)
7. Confirm on mount the grid scrolls so the now-line is visible (not at 7am top)
8. Run `npm run typecheck` — no errors
