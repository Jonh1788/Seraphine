// WidgetKit timeline provider.
//
// Reads the App Group snapshot written by the app. NO NETWORK: a widget
// timeline reload runs on a tight budget and any URLSession work here
// would routinely be killed before completing. The app is responsible
// for keeping widget-snapshot.json fresh and for calling
// `WidgetCenter.shared.reloadAllTimelines()` after each write.

import WidgetKit

struct SeraphineEntry: TimelineEntry {
    let date: Date
    let snapshot: SeraphineSnapshot
    /// False when the App Group container could not be opened or the
    /// file has never been written — the views render a "sem dados"
    /// state instead of pretending streak/XP are genuinely zero.
    let hasData: Bool
}

struct SeraphineProvider: TimelineProvider {
    func placeholder(in context: Context) -> SeraphineEntry {
        SeraphineEntry(date: Date(), snapshot: .gallerySample, hasData: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (SeraphineEntry) -> Void) {
        // The widget gallery (context.isPreview) must show something
        // meaningful even on a device that never synced.
        if context.isPreview, SeraphineSnapshot.load() == nil {
            completion(SeraphineEntry(date: Date(), snapshot: .gallerySample, hasData: true))
            return
        }
        completion(currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SeraphineEntry>) -> Void) {
        let entry = currentEntry()
        // The app pushes reloads on every sync; this cadence is only the
        // safety net for when the app never runs (agenda items scroll
        // past as the day advances).
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: entry.date) ?? entry.date
        completion(Timeline(entries: [entry], policy: .after(next)))
    }

    private func currentEntry() -> SeraphineEntry {
        let now = Date()
        guard let stored = SeraphineSnapshot.load() else {
            return SeraphineEntry(date: now, snapshot: .placeholder, hasData: false)
        }
        // Only future/ongoing items are worth lock-screen real estate.
        // Items whose `at` cannot be resolved to a time today are kept
        // (better a stale row than a silently empty widget).
        let upcoming = stored.agenda.filter { item in
            guard let when = resolveToday(item.at) else { return true }
            return when >= now.addingTimeInterval(-15 * 60)
        }
        let filtered = SeraphineSnapshot(
            agenda: upcoming,
            streak: stored.streak,
            xp: stored.xp,
            updatedAt: stored.updatedAt
        )
        return SeraphineEntry(date: now, snapshot: filtered, hasData: true)
    }

    /// "09:00" → today at 09:00. Full ISO strings are parsed as-is.
    private func resolveToday(_ at: String) -> Date? {
        if let d = SeraphineSnapshot.parseISO(at) { return d }
        let parts = at.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
        return Calendar.current.date(
            bySettingHour: h, minute: m, second: 0, of: Date()
        )
    }
}
