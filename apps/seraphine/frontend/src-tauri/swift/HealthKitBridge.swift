// SDD 018 — HealthKit bridge exposed to Rust via @_cdecl C ABI.
//
// Compiled by build.rs into a static library (libseraphine_healthkit.a)
// and linked into the Tauri binary. Rust calls these functions via
// `extern "C"` and parses the returned JSON strings.
//
// Every command is synchronous at the Rust boundary: Swift internally
// uses DispatchSemaphore to block until the HealthKit async callback
// fires. The Tauri commands already run off the main thread, so
// blocking here is fine.
//
// Return convention:
//   - Success: pointer to a UTF-8 NUL-terminated C string with JSON.
//             Caller MUST free it via `seraphine_health_free_string`.
//   - Failure: pointer to a JSON object with {"error": "..."}.
//             Same free convention.
//   - NULL is never returned.

import Foundation
import HealthKit
#if os(iOS)
import BackgroundTasks
#endif
#if canImport(UIKit)
import UIKit
#endif

// ---------------------------------------------------------------------------
// String bridging helpers
// ---------------------------------------------------------------------------

private func makeCString(_ s: String) -> UnsafeMutablePointer<CChar> {
    // strdup mallocs; Rust frees via free() equivalent (we expose a
    // dedicated free function to keep allocators consistent).
    return strdup(s) ?? strdup("{\"error\":\"alloc-failed\"}")!
}

private func errorJson(_ msg: String) -> UnsafeMutablePointer<CChar> {
    let escaped = msg
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    return makeCString("{\"error\":\"\(escaped)\"}")
}

@_cdecl("seraphine_health_free_string")
public func seraphine_health_free_string(_ ptr: UnsafeMutablePointer<CChar>?) {
    if let p = ptr { free(p) }
}

// ---------------------------------------------------------------------------
// HealthKit types we read. Keep this list in one place so authorize &
// the query functions agree.
// ---------------------------------------------------------------------------

private func readTypes() -> Set<HKObjectType> {
    var types: Set<HKObjectType> = []
    if let t = HKObjectType.quantityType(forIdentifier: .stepCount) { types.insert(t) }
    if let t = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { types.insert(t) }
    if let t = HKObjectType.quantityType(forIdentifier: .restingHeartRate) { types.insert(t) }
    if let t = HKObjectType.quantityType(forIdentifier: .heartRate) { types.insert(t) }
    if let t = HKObjectType.quantityType(forIdentifier: .bodyMass) { types.insert(t) }
    if let t = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { types.insert(t) }
    types.insert(HKObjectType.workoutType())
    return types
}

// Singleton so we don't churn HKHealthStore objects.
private let healthStore = HKHealthStore()

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

@_cdecl("seraphine_health_request_authorization")
public func seraphine_health_request_authorization() -> UnsafeMutablePointer<CChar> {
    guard HKHealthStore.isHealthDataAvailable() else {
        return makeCString(
            "{\"authorized\":false,\"mode\":\"unavailable\"," +
            "\"message\":\"HealthKit nao disponivel neste aparelho.\"}"
        )
    }
    // Dispatch the authorization call on the main queue so HealthKit
    // can present the system permission sheet. Block the caller thread
    // via a semaphore with a generous timeout (90s) so the user has
    // plenty of time to tap through the dialog without HK returning
    // its "Authorization session timed out" error.
    let sem = DispatchSemaphore(value: 0)
    var resultJson = "{\"authorized\":false,\"mode\":\"real\"," +
        "\"message\":\"Timeout esperando resposta do usuario.\"}"

    DispatchQueue.main.async {
        healthStore.requestAuthorization(toShare: nil, read: readTypes()) { success, error in
            if let err = error {
                let escaped = err.localizedDescription
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                resultJson = "{\"authorized\":false,\"mode\":\"real\"," +
                    "\"message\":\"\(escaped)\"}"
            } else if success {
                resultJson = "{\"authorized\":true,\"mode\":\"real\"," +
                    "\"message\":\"Permissoes concedidas.\"}"
            } else {
                resultJson = "{\"authorized\":false,\"mode\":\"real\"," +
                    "\"message\":\"Usuario negou permissao.\"}"
            }
            sem.signal()
        }
    }
    _ = sem.wait(timeout: .now() + 90)
    return makeCString(resultJson)
}

// ---------------------------------------------------------------------------
// Utility: ISO-8601 formatter (thread-safe, reused across calls)
// ---------------------------------------------------------------------------

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

private func isoString(_ d: Date) -> String { isoFormatter.string(from: d) }

private func dayString(_ d: Date) -> String {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .iso8601)
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: d)
}

// ---------------------------------------------------------------------------
// Individual HealthKit queries
// ---------------------------------------------------------------------------

private func querySumQuantity(
    _ identifier: HKQuantityTypeIdentifier,
    unit: HKUnit,
    start: Date,
    end: Date,
) -> Double {
    guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return 0 }
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    let sem = DispatchSemaphore(value: 0)
    var total: Double = 0
    let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, stats, _ in
        if let sum = stats?.sumQuantity() {
            total = sum.doubleValue(for: unit)
        }
        sem.signal()
    }
    healthStore.execute(query)
    sem.wait()
    return total
}

private func queryDiscreteAverage(
    _ identifier: HKQuantityTypeIdentifier,
    unit: HKUnit,
    start: Date,
    end: Date,
) -> Double? {
    guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return nil }
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    let sem = DispatchSemaphore(value: 0)
    var avg: Double? = nil
    let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .discreteAverage) { _, stats, _ in
        if let a = stats?.averageQuantity() {
            avg = a.doubleValue(for: unit)
        }
        sem.signal()
    }
    healthStore.execute(query)
    sem.wait()
    return avg
}

private func queryLatestBodyMass() -> Double? {
    guard let type = HKObjectType.quantityType(forIdentifier: .bodyMass) else { return nil }
    let sem = DispatchSemaphore(value: 0)
    var result: Double? = nil
    let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
    let query = HKSampleQuery(sampleType: type, predicate: nil, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
        if let s = samples?.first as? HKQuantitySample {
            result = s.quantity.doubleValue(for: HKUnit.gramUnit(with: .kilo))
        }
        sem.signal()
    }
    healthStore.execute(query)
    sem.wait()
    return result
}

private func querySleepMinutes(start: Date, end: Date) -> Double? {
    guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    let sem = DispatchSemaphore(value: 0)
    var intervals: [(Date, Date)] = []
    let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
    let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, _ in
        defer { sem.signal() }
        guard let arr = samples as? [HKCategorySample], !arr.isEmpty else { return }
        for s in arr {
            // HKCategoryValueSleepAnalysis raw values (iOS 16+):
            //   0 = .inBed             ← not sleeping, skip
            //   1 = .asleepUnspecified ← legacy / iPhone-only tracking
            //   2 = .awake             ← not sleeping, skip
            //   3 = .asleepCore        ← ~40-60% of a typical night
            //   4 = .asleepDeep
            //   5 = .asleepREM
            //
            // The previous implementation dropped value 3 (core) and
            // counted a nonexistent value 6, so total came out to ~30-40%
            // of the real sleep duration (Apple Health shows 8h → bridge
            // reported 3h).
            let v = s.value
            if v == 1 || v == 3 || v == 4 || v == 5 {
                intervals.append((s.startDate, s.endDate))
            }
        }
    }
    healthStore.execute(query)
    sem.wait()
    if intervals.isEmpty { return nil }

    // Merge overlapping intervals before summing so an older unified
    // `.asleepUnspecified` sample plus the newer `.asleepCore/Deep/REM`
    // stages covering the same night don't double-count.
    intervals.sort { $0.0 < $1.0 }
    var merged: [(Date, Date)] = [intervals[0]]
    for (s, e) in intervals.dropFirst() {
        let (ls, le) = merged[merged.count - 1]
        if s <= le {
            merged[merged.count - 1] = (ls, max(le, e))
        } else {
            merged.append((s, e))
        }
    }
    var total: TimeInterval = 0
    for (s, e) in merged {
        total += e.timeIntervalSince(s)
    }
    return total / 60.0
}

private struct WorkoutDTO: Encodable {
    let type: String
    let start: String
    let end: String
    let duration_min: Double
    let calories: Double?
    let distance_km: Double?
}

private func workoutTypeName(_ activity: HKWorkoutActivityType) -> String {
    switch activity {
    case .running: return "running"
    case .walking: return "walking"
    case .cycling: return "cycling"
    case .traditionalStrengthTraining, .functionalStrengthTraining: return "strength"
    case .yoga: return "yoga"
    case .swimming: return "swimming"
    case .hiking: return "hiking"
    case .rowing: return "rowing"
    case .highIntensityIntervalTraining: return "hiit"
    case .mixedCardio: return "cardio"
    case .elliptical: return "elliptical"
    case .coreTraining: return "core"
    case .pilates: return "pilates"
    case .dance: return "dance"
    case .tennis: return "tennis"
    case .soccer: return "soccer"
    case .basketball: return "basketball"
    default: return "workout"
    }
}

private func queryWorkouts(start: Date, end: Date) -> [WorkoutDTO] {
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
    let sem = DispatchSemaphore(value: 0)
    var out: [WorkoutDTO] = []
    let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
    let query = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, _ in
        defer { sem.signal() }
        guard let arr = samples as? [HKWorkout] else { return }
        for w in arr {
            let duration = w.duration / 60.0
            let cals = w.totalEnergyBurned?.doubleValue(for: HKUnit.kilocalorie())
            let dist = w.totalDistance?.doubleValue(for: HKUnit.meterUnit(with: .kilo))
            out.append(WorkoutDTO(
                type: workoutTypeName(w.workoutActivityType),
                start: isoString(w.startDate),
                end: isoString(w.endDate),
                duration_min: duration,
                calories: cals,
                distance_km: dist
            ))
        }
    }
    healthStore.execute(query)
    sem.wait()
    return out
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

private struct SnapshotDTO: Encodable {
    let date: String
    let steps: Int64
    let active_calories: Double
    let resting_heart_rate: Double?
    let sleep_minutes: Double?
    let sleep_quality: String?
    let weight_kg: Double?
    let workouts: [WorkoutDTO]
}

private func sleepQualityLabel(_ minutes: Double?) -> String? {
    guard let m = minutes, m > 0 else { return nil }
    if m >= 7 * 60 { return "boa" }
    if m >= 5 * 60 { return "regular" }
    return "ruim"
}

private func buildSnapshot(for day: Date) -> SnapshotDTO {
    let cal = Calendar(identifier: .iso8601)
    let start = cal.startOfDay(for: day)
    let end = cal.date(byAdding: .day, value: 1, to: start) ?? day

    let steps = querySumQuantity(.stepCount, unit: HKUnit.count(), start: start, end: end)
    let cals = querySumQuantity(.activeEnergyBurned, unit: HKUnit.kilocalorie(), start: start, end: end)
    let rhr = queryDiscreteAverage(.restingHeartRate, unit: HKUnit.count().unitDivided(by: HKUnit.minute()), start: start, end: end)

    // Sleep window: 8pm previous day → noon today (typical sleep spans midnight).
    let sleepStart = cal.date(byAdding: .hour, value: -4, to: start) ?? start
    let sleepEnd = cal.date(byAdding: .hour, value: 12, to: start) ?? end
    let sleep = querySleepMinutes(start: sleepStart, end: sleepEnd)

    let workouts = queryWorkouts(start: start, end: end)
    let weight = queryLatestBodyMass()

    return SnapshotDTO(
        date: dayString(start),
        steps: Int64(steps.rounded()),
        active_calories: cals,
        resting_heart_rate: rhr,
        sleep_minutes: sleep,
        sleep_quality: sleepQualityLabel(sleep),
        weight_kg: weight,
        workouts: workouts
    )
}

private func encodeJson<T: Encodable>(_ value: T) -> UnsafeMutablePointer<CChar> {
    let enc = JSONEncoder()
    enc.outputFormatting = []
    do {
        let data = try enc.encode(value)
        let s = String(data: data, encoding: .utf8) ?? "{}"
        return makeCString(s)
    } catch {
        return errorJson("json-encode: \(error.localizedDescription)")
    }
}

@_cdecl("seraphine_health_get_today_summary")
public func seraphine_health_get_today_summary() -> UnsafeMutablePointer<CChar> {
    guard HKHealthStore.isHealthDataAvailable() else {
        return errorJson("HealthKit nao disponivel.")
    }
    let snap = buildSnapshot(for: Date())
    return encodeJson(snap)
}

// ---------------------------------------------------------------------------
// Background App Refresh — BGTaskScheduler.
//
// Strategy:
// 1. A `SeraphineBGRegistrar` class registers the task handler via its
//    NSObject `+load` method, which runs during dyld load (before the
//    app delegate's didFinishLaunchingWithOptions). This is the
//    recommended place for BGTaskScheduler.register according to Apple.
// 2. The handler reads today's snapshot + POSTs it to the Seraphine
//    backend on `sera.jonhdev.io`, then schedules the next run.
// 3. `seraphine_health_schedule_background_sync` is the Tauri command
//    the React shell calls on launch to submit the first task request.
// ---------------------------------------------------------------------------

private let BG_TASK_IDENTIFIER = "io.jonhdev.seraphine.healthsync"
private let BACKEND_SNAPSHOT_URL = URL(string: "https://sera.jonhdev.io/health/snapshot")!

#if os(iOS)

@available(iOS 13.0, *)
private func postSnapshotToBackend(_ snapshot: SnapshotDTO) async -> Bool {
    do {
        let data = try JSONEncoder().encode(snapshot)
        var req = URLRequest(url: BACKEND_SNAPSHOT_URL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        let (_, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
            return true
        }
    } catch {
        NSLog("[SeraphineBG] POST failed: \(error.localizedDescription)")
    }
    return false
}

@available(iOS 13.0, *)
private func scheduleNextAppRefresh() {
    let request = BGAppRefreshTaskRequest(identifier: BG_TASK_IDENTIFIER)
    // ~2h from now. iOS decides the actual firing time based on
    // usage patterns and budget; this is just a hint.
    request.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60 * 2)
    do {
        try BGTaskScheduler.shared.submit(request)
        NSLog("[SeraphineBG] next refresh scheduled")
    } catch {
        NSLog("[SeraphineBG] submit failed: \(error.localizedDescription)")
    }
}

@available(iOS 13.0, *)
private func handleAppRefresh(task: BGAppRefreshTask) {
    // Always queue the next run first so a crash here doesn't stop the
    // chain of background wakes.
    scheduleNextAppRefresh()

    let queue = DispatchQueue.global(qos: .utility)
    queue.async {
        guard HKHealthStore.isHealthDataAvailable() else {
            task.setTaskCompleted(success: false)
            return
        }
        let snapshot = buildSnapshot(for: Date())
        Task {
            let ok = await postSnapshotToBackend(snapshot)
            task.setTaskCompleted(success: ok)
        }
    }

    task.expirationHandler = {
        // iOS is taking the task back — nothing to clean up since our
        // URLSession is shared and the upload will finish on its own.
        NSLog("[SeraphineBG] task expired")
    }
}

// Swift forbids overriding NSObject's +load. We register the handler
// lazily through this file-scope lazy var; the Rust shell calls
// `seraphine_health_schedule_background_sync` very early in the app's
// lifecycle (during MobileShell mount), at which point iOS is still
// willing to accept handler registration for this identifier.
@available(iOS 13.0, *)
private let _bgRegistered: Bool = {
    BGTaskScheduler.shared.register(
        forTaskWithIdentifier: BG_TASK_IDENTIFIER,
        using: nil,
    ) { task in
        guard let refresh = task as? BGAppRefreshTask else {
            task.setTaskCompleted(success: false)
            return
        }
        handleAppRefresh(task: refresh)
    }
    NSLog("[SeraphineBG] task handler registered")
    return true
}()

#endif // os(iOS)

@_cdecl("seraphine_health_schedule_background_sync")
public func seraphine_health_schedule_background_sync() -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    if #available(iOS 13.0, *) {
        // Touching _bgRegistered forces the handler registration to
        // happen exactly once, lazily.
        _ = _bgRegistered
        scheduleNextAppRefresh()
        return makeCString(
            "{\"scheduled\":true,\"message\":\"Background refresh agendado.\"}"
        )
    }
    #endif
    return makeCString(
        "{\"scheduled\":false,\"message\":\"BackgroundTasks indisponivel (iOS < 13).\"}"
    )
}

@_cdecl("seraphine_health_get_recent")
public func seraphine_health_get_recent(_ days: Int32) -> UnsafeMutablePointer<CChar> {
    guard HKHealthStore.isHealthDataAvailable() else {
        return errorJson("HealthKit nao disponivel.")
    }
    let n = max(1, min(Int(days), 365))
    let cal = Calendar(identifier: .iso8601)
    let today = cal.startOfDay(for: Date())
    var snapshots: [SnapshotDTO] = []
    for offset in (0..<n).reversed() {
        guard let day = cal.date(byAdding: .day, value: -offset, to: today) else { continue }
        snapshots.append(buildSnapshot(for: day))
    }
    return encodeJson(snapshots)
}
