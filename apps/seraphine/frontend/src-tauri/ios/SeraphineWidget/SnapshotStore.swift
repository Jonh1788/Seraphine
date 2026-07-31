// Shared snapshot contract between the Seraphine iOS app and the
// WidgetKit extension.
//
// The app writes `widget-snapshot.json` into the App Group container;
// the extension only ever READS it. There is deliberately no network
// code in this file (or anywhere in the extension) — WidgetKit gives a
// timeline reload a very small execution budget, and the App Group
// exists precisely so the extension never has to fetch.
//
// Contract (produced by `seraphine_widget_write_snapshot` in
// src-tauri/swift/WidgetBridge.swift):
//
//   {
//     "agenda":    [ { "title": "Call com o time", "at": "09:00" } ],
//     "streak":    7,
//     "xp":        1240,
//     "updatedAt": "2026-07-31T08:00:00Z"
//   }
//
// `at` is accepted either as a wall-clock "HH:mm" string or as a full
// ISO-8601 timestamp; `displayTime` normalises both to "HH:mm".

import Foundation

/// App Group shared by the app target and the widget extension.
/// Must stay in sync with:
///   - src-tauri/gen/apple/project.yml (entitlements of both targets)
///   - src-tauri/swift/WidgetBridge.swift (writer side)
public let seraphineAppGroupID = "group.io.jonhdev.seraphine"

/// File name inside the App Group container.
public let seraphineSnapshotFileName = "widget-snapshot.json"

/// Absolute URL of the snapshot inside the shared container, or nil when
/// the App Group entitlement is missing / not yet provisioned.
public func seraphineSnapshotURL() -> URL? {
    FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: seraphineAppGroupID)?
        .appendingPathComponent(seraphineSnapshotFileName)
}

public struct SeraphineAgendaItem: Codable, Hashable, Identifiable {
    public let title: String
    public let at: String

    public var id: String { "\(at)|\(title)" }

    public init(title: String, at: String) {
        self.title = title
        self.at = at
    }

    /// "09:00" for both `"09:00"` and `"2026-07-31T09:00:00-03:00"`.
    /// Anything else is passed through untouched rather than blanked out,
    /// so a contract drift shows up on screen instead of silently
    /// rendering an empty label.
    public var displayTime: String {
        if at.count == 5, at.contains(":") { return at }
        if let date = SeraphineSnapshot.parseISO(at) {
            let f = DateFormatter()
            f.locale = Locale(identifier: "pt_BR")
            f.dateFormat = "HH:mm"
            return f.string(from: date)
        }
        return at
    }
}

public struct SeraphineSnapshot: Codable, Hashable {
    public let agenda: [SeraphineAgendaItem]
    public let streak: Int
    public let xp: Int
    public let updatedAt: String

    public init(agenda: [SeraphineAgendaItem], streak: Int, xp: Int, updatedAt: String) {
        self.agenda = agenda
        self.streak = streak
        self.xp = xp
        self.updatedAt = updatedAt
    }

    /// Shown before the app has ever synced, and in the WidgetKit
    /// gallery preview. Zeroed rather than faked so an empty widget is
    /// visibly "no data yet" and not mistaken for real numbers.
    public static let placeholder = SeraphineSnapshot(
        agenda: [],
        streak: 0,
        xp: 0,
        updatedAt: ""
    )

    /// Sample used only by `TimelineProvider.snapshot(in:)` (the widget
    /// gallery), never persisted.
    public static let gallerySample = SeraphineSnapshot(
        agenda: [
            SeraphineAgendaItem(title: "Call com o time", at: "09:00"),
            SeraphineAgendaItem(title: "Almoço com Ana", at: "12:30"),
            SeraphineAgendaItem(title: "Revisão semanal", at: "17:00"),
        ],
        streak: 7,
        xp: 1240,
        updatedAt: ""
    )

    public static func parseISO(_ s: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }

    public var updatedAtDate: Date? {
        updatedAt.isEmpty ? nil : Self.parseISO(updatedAt)
    }

    /// Reads + decodes the snapshot from the App Group container.
    /// Returns nil (never throws) so the provider can fall back to the
    /// placeholder rather than leaving a blank widget on any failure.
    public static func load() -> SeraphineSnapshot? {
        guard let url = seraphineSnapshotURL() else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SeraphineSnapshot.self, from: data)
    }
}
