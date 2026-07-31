// SDD task 26 — writes the widget snapshot into the App Group container.
//
// Compiled by build.rs into libseraphine_healthkit.a alongside
// HealthKitBridge.swift and linked into the Tauri binary (see
// src-tauri/src/widget.rs for the Rust side).
//
// Direction of data:
//
//   backend (sera.jonhdev.io)  ->  THIS FILE  ->  App Group container
//                                                        |
//                                              SeraphineWidget.appex
//                                              (read-only, no network)
//
// The extension never fetches: a WidgetKit timeline reload has a tight
// execution budget, and the App Group exists exactly so the extension
// can read an already-materialised snapshot.
//
// JSON contract — MUST stay in sync with
// src-tauri/ios/SeraphineWidget/SnapshotStore.swift (different target,
// so the types cannot literally be shared without a framework):
//
//   { "agenda": [ {"title": "...", "at": "09:00"} ],
//     "streak": 7, "xp": 1240, "updatedAt": "<ISO-8601>" }
//
// Return convention matches HealthKitBridge: always a non-NULL C string
// holding JSON; the caller frees it with `seraphine_widget_free_string`.

import Foundation
#if os(iOS)
import UIKit
import WidgetKit
#endif

// ---------------------------------------------------------------------------
// C-string plumbing (file-scope, deliberately separate from the
// identically-shaped helpers in HealthKitBridge.swift so neither file
// depends on the other's internals).
// ---------------------------------------------------------------------------

private func widgetCString(_ s: String) -> UnsafeMutablePointer<CChar> {
    return strdup(s) ?? strdup("{\"ok\":false,\"message\":\"alloc-failed\"}")!
}

private func widgetJsonEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
}

private func widgetFailure(_ message: String) -> UnsafeMutablePointer<CChar> {
    widgetCString("{\"ok\":false,\"message\":\"\(widgetJsonEscape(message))\"}")
}

@_cdecl("seraphine_widget_free_string")
public func seraphine_widget_free_string(_ ptr: UnsafeMutablePointer<CChar>?) {
    if let p = ptr { free(p) }
}

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

/// Keep in sync with `seraphineAppGroupID` in SnapshotStore.swift and
/// with the `com.apple.security.application-groups` entitlement of BOTH
/// targets in gen/apple/project.yml.
private let widgetAppGroupID = "group.io.jonhdev.seraphine"
private let widgetSnapshotFileName = "widget-snapshot.json"

private struct WidgetAgendaItem: Codable {
    let title: String
    let at: String
}

private struct WidgetSnapshotDTO: Codable {
    let agenda: [WidgetAgendaItem]
    let streak: Int
    let xp: Int
    let updatedAt: String
}

private let widgetISOFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

private func widgetContainerURL() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: widgetAppGroupID)
}

private func widgetSnapshotURL() -> URL? {
    widgetContainerURL()?.appendingPathComponent(widgetSnapshotFileName)
}

private enum WidgetWriteError: Error, LocalizedError {
    case noContainer

    var errorDescription: String? {
        switch self {
        case .noContainer:
            // Almost always a provisioning problem: the App Group is not
            // in the entitlements actually baked into the running binary.
            return "App Group \(widgetAppGroupID) indisponivel (entitlement ausente no build)."
        }
    }
}

/// Writes atomically and asks WidgetKit to reload. Returns the path.
@discardableResult
private func persistSnapshot(_ dto: WidgetSnapshotDTO) throws -> String {
    guard let url = widgetSnapshotURL() else { throw WidgetWriteError.noContainer }
    let encoder = JSONEncoder()
    encoder.outputFormatting = []
    let data = try encoder.encode(dto)
    try data.write(to: url, options: .atomic)
    #if os(iOS)
    if #available(iOS 14.0, *) {
        WidgetCenter.shared.reloadAllTimelines()
    }
    #endif
    return url.path
}

// ---------------------------------------------------------------------------
// Explicit write — the hook for anything that already holds the numbers
// (Rust command `widget_write_snapshot`, callable from the React shell).
// ---------------------------------------------------------------------------

@_cdecl("seraphine_widget_write_snapshot")
public func seraphine_widget_write_snapshot(
    _ jsonPtr: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar> {
    guard let jsonPtr else { return widgetFailure("payload nulo") }
    let raw = String(cString: jsonPtr)
    guard let data = raw.data(using: .utf8) else {
        return widgetFailure("payload nao e UTF-8")
    }
    do {
        // Decode before writing so malformed input fails here rather than
        // in the extension, where the only symptom would be a blank widget.
        var dto = try JSONDecoder().decode(WidgetSnapshotDTO.self, from: data)
        if dto.updatedAt.isEmpty {
            dto = WidgetSnapshotDTO(
                agenda: dto.agenda, streak: dto.streak, xp: dto.xp,
                updatedAt: widgetISOFormatter.string(from: Date())
            )
        }
        let path = try persistSnapshot(dto)
        return widgetCString(
            "{\"ok\":true,\"path\":\"\(widgetJsonEscape(path))\"," +
            "\"items\":\(dto.agenda.count)}"
        )
    } catch {
        return widgetFailure("\(error.localizedDescription)")
    }
}

// ---------------------------------------------------------------------------
// Status — used to verify the App Group wiring from the app side.
// ---------------------------------------------------------------------------

@_cdecl("seraphine_widget_snapshot_status")
public func seraphine_widget_snapshot_status() -> UnsafeMutablePointer<CChar> {
    guard let url = widgetSnapshotURL() else {
        return widgetCString(
            "{\"ok\":false,\"available\":false," +
            "\"message\":\"App Group \(widgetAppGroupID) indisponivel.\"}"
        )
    }
    let exists = FileManager.default.fileExists(atPath: url.path)
    var bytes = 0
    var updatedAt = ""
    if exists, let data = try? Data(contentsOf: url) {
        bytes = data.count
        if let dto = try? JSONDecoder().decode(WidgetSnapshotDTO.self, from: data) {
            updatedAt = dto.updatedAt
        }
    }
    return widgetCString(
        "{\"ok\":true,\"available\":true," +
        "\"path\":\"\(widgetJsonEscape(url.path))\"," +
        "\"exists\":\(exists),\"bytes\":\(bytes)," +
        "\"updatedAt\":\"\(widgetJsonEscape(updatedAt))\"}"
    )
}

// ---------------------------------------------------------------------------
// Native refresh — fetches the same two endpoints the React "Hoje" screen
// already uses, so no new backend contract is invented here:
//
//   GET /calendar/aggregate?start=<today>&end=<today>
//        -> { "days": [ { "date": "...", "events": [ {title, start} ] } ] }
//   GET /courses/stats
//        -> { "xp_total": Int, "streak_count": Int, ... }
//
// Network lives HERE (in the app), never in the extension.
// ---------------------------------------------------------------------------

private let widgetBackendBase = "https://sera.jonhdev.io"

private struct AggEvent: Decodable {
    let title: String?
    let start: String?
}

private struct AggDay: Decodable {
    let events: [AggEvent]?
}

private struct AggResponse: Decodable {
    let days: [AggDay]?
}

private struct CoursesStats: Decodable {
    let xp_total: Int?
    let streak_count: Int?
}

/// Synchronous GET+decode. Blocking is fine: every caller is already off
/// the main thread (Tauri commands, the BG task queue, or a detached
/// dispatch from the foreground notification).
private func widgetFetch<T: Decodable>(_ path: String, as type: T.Type) -> T? {
    guard let url = URL(string: widgetBackendBase + path) else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = 10
    let sem = DispatchSemaphore(value: 0)
    var decoded: T?
    let task = URLSession.shared.dataTask(with: request) { data, response, _ in
        defer { sem.signal() }
        guard
            let data,
            let http = response as? HTTPURLResponse,
            (200..<300).contains(http.statusCode)
        else { return }
        decoded = try? JSONDecoder().decode(T.self, from: data)
    }
    task.resume()
    if sem.wait(timeout: .now() + 15) == .timedOut {
        task.cancel()
        return nil
    }
    return decoded
}

/// "2026-07-31T09:00:00-03:00" -> "09:00". Mirrors what the React
/// AgendaBlock does (`start.slice(11, 16)`) so app and widget agree.
private func widgetClockTime(_ start: String?) -> String? {
    guard let start, start.count >= 16 else { return nil }
    let idx = start.index(start.startIndex, offsetBy: 11)
    let end = start.index(start.startIndex, offsetBy: 16)
    return String(start[idx..<end])
}

private func widgetTodayString() -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .iso8601)
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: Date())
}

/// Builds and persists a fresh snapshot. Returns nil on success or a
/// human-readable reason on failure.
@discardableResult
private func refreshWidgetSnapshot() -> String? {
    let today = widgetTodayString()
    let agg = widgetFetch("/calendar/aggregate?start=\(today)&end=\(today)", as: AggResponse.self)
    let stats = widgetFetch("/courses/stats", as: CoursesStats.self)

    // A total failure of BOTH calls must not overwrite a good snapshot
    // with zeroes — the widget would silently show "Nada na agenda".
    if agg == nil && stats == nil {
        return "backend inacessivel (calendar + courses falharam)"
    }

    var agenda: [WidgetAgendaItem] = []
    for event in agg?.days?.first?.events ?? [] {
        guard let title = event.title, !title.isEmpty else { continue }
        agenda.append(WidgetAgendaItem(title: title, at: widgetClockTime(event.start) ?? ""))
    }

    let dto = WidgetSnapshotDTO(
        agenda: agenda,
        streak: stats?.streak_count ?? 0,
        xp: stats?.xp_total ?? 0,
        updatedAt: widgetISOFormatter.string(from: Date())
    )
    do {
        try persistSnapshot(dto)
        return nil
    } catch {
        return error.localizedDescription
    }
}

@_cdecl("seraphine_widget_refresh_snapshot")
public func seraphine_widget_refresh_snapshot() -> UnsafeMutablePointer<CChar> {
    if let reason = refreshWidgetSnapshot() {
        return widgetFailure(reason)
    }
    return widgetCString("{\"ok\":true,\"message\":\"snapshot atualizado\"}")
}

// ---------------------------------------------------------------------------
// Auto-refresh — called once from the Tauri `setup` hook on iOS.
// Refreshes now and on every foreground. The background sync path calls
// `seraphineWidgetBackgroundRefresh()` from HealthKitBridge's BGTask
// handler.
// ---------------------------------------------------------------------------

#if os(iOS)
private var widgetForegroundObserver: NSObjectProtocol?
#endif

@_cdecl("seraphine_widget_install_auto_refresh")
public func seraphine_widget_install_auto_refresh() -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    if widgetForegroundObserver == nil {
        widgetForegroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            DispatchQueue.global(qos: .utility).async {
                if let reason = refreshWidgetSnapshot() {
                    NSLog("[SeraphineWidget] foreground refresh falhou: \(reason)")
                }
            }
        }
    }
    DispatchQueue.global(qos: .utility).async {
        if let reason = refreshWidgetSnapshot() {
            NSLog("[SeraphineWidget] refresh inicial falhou: \(reason)")
        }
    }
    return widgetCString("{\"ok\":true,\"message\":\"auto-refresh instalado\"}")
    #else
    return widgetFailure("widget snapshot e iOS-only")
    #endif
}

/// Entry point for the existing BGAppRefreshTask handler in
/// HealthKitBridge.swift — the app's only recurring background sync.
func seraphineWidgetBackgroundRefresh() {
    if let reason = refreshWidgetSnapshot() {
        NSLog("[SeraphineWidget] refresh em background falhou: \(reason)")
    }
}
