// SDD task 27 — notificação rica com ações ("Marcar pago" / "Adiar 1h").
//
// Compilado por build.rs dentro de libseraphine_healthkit.a, ao lado de
// HealthKitBridge.swift e WidgetBridge.swift, e linkado no binário Tauri
// (lado Rust em src-tauri/src/notifications.rs).
//
// Quem trata o toque no botão
// ---------------------------
// O handler NÃO roda no React. Ele roda no processo do app, em
// `UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:)`.
// As duas ações são registradas com `options: []` (ação de *background*),
// então tocar num botão da tela de bloqueio:
//
//   * app em primeiro plano  -> delegate chamado direto;
//   * app suspenso           -> app é retomado em background e o delegate
//                               é chamado;
//   * app encerrado / cold   -> o iOS *relança o processo em background*
//                               só para entregar a resposta.
//
// No caso cold o delegate precisa já estar instalado quando o iOS entrega
// a resposta. Por isso `seraphine_notifications_install()` é chamado do
// hook `setup` do Tauri, que roda em `tauri::Builder::build()` — ou seja,
// ANTES de `UIApplicationMain` (tao chama `UIApplicationMain` só dentro de
// `EventLoop::run`). O delegate está de pé antes do
// `application:didFinishLaunchingWithOptions:`, que é mais cedo do que a
// Apple exige.
//
// Como o handler faz rede, `completionHandler()` só é chamado quando a
// requisição termina — é o que segura o tempo de execução em background.
//
// Nada falha em silêncio: todo toque grava um registro em
// `notification-actions.json` no App Group da task 26
// (`group.io.jonhdev.seraphine`), legível pelo comando Tauri
// `notifications_action_log`.

import Foundation
#if os(iOS)
import UIKit
import UserNotifications
#endif

// ---------------------------------------------------------------------------
// Plumbing de C string — deliberadamente separado dos helpers de mesma
// forma em HealthKitBridge/WidgetBridge para nenhum arquivo depender dos
// internos do outro.
// ---------------------------------------------------------------------------

private func notifCString(_ s: String) -> UnsafeMutablePointer<CChar> {
    return strdup(s) ?? strdup("{\"ok\":false,\"message\":\"alloc-failed\"}")!
}

private func notifJsonEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
}

private func notifFailure(_ message: String) -> UnsafeMutablePointer<CChar> {
    notifCString("{\"ok\":false,\"message\":\"\(notifJsonEscape(message))\"}")
}

private func notifOk(_ extra: String = "") -> UnsafeMutablePointer<CChar> {
    notifCString("{\"ok\":true\(extra.isEmpty ? "" : ",\(extra)")}")
}

@_cdecl("seraphine_notifications_free_string")
public func seraphine_notifications_free_string(_ ptr: UnsafeMutablePointer<CChar>?) {
    if let p = ptr { free(p) }
}

#if os(iOS)

// ---------------------------------------------------------------------------
// Identificadores. Mudar qualquer um destes invalida notificações já
// agendadas no sistema (o iOS guarda a categoria pelo identificador).
// ---------------------------------------------------------------------------

/// Conta a pagar: as duas ações do handoff.
private let notifCategoryBill = "SERAPHINE_BILL"

/// "Streak em risco". **Categoria própria, não a mesma da conta** — ver o
/// comentário em `notifBuildCategories()`.
private let notifCategoryStreak = "SERAPHINE_STREAK"

private let notifActionMarkPaid = "SERAPHINE_MARK_PAID"
private let notifActionSnooze1h = "SERAPHINE_SNOOZE_1H"

private let notifBillIdentifierPrefix = "seraphine.bill."
private let notifStreakIdentifier = "seraphine.streak"
private let notifThreadIdentifier = "seraphine"

/// Chaves do `userInfo`. O `taskId` é o que dá alvo ao botão "Marcar pago";
/// sem ele a notificação não chega a ser agendada (ver `scheduleBill`).
private let notifKeyKind = "kind"
private let notifKeyTaskId = "taskId"
private let notifKeySnoozes = "snoozes"

private let notifKindBill = "bill"
private let notifKindStreak = "streak"

private let notifSnoozeSeconds: TimeInterval = 3600

private let notifBackendBase = "https://sera.jonhdev.io"
private let notifAppGroupID = "group.io.jonhdev.seraphine"
private let notifActionLogFileName = "notification-actions.json"
private let notifActionLogLimit = 20

private let notifISOFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

/// Observer de `didBecomeActive` — reavalia o streak a cada foreground.
private var notifStreakObserver: NSObjectProtocol?

// ---------------------------------------------------------------------------
// Log de ações no App Group (consome a task 26).
//
// Existe porque um botão de notificação não tem para onde reportar erro:
// a UI já sumiu quando o handler roda. Sem isto, uma falha do PATCH seria
// exatamente o "botão que não faz nada" que a task proíbe.
// ---------------------------------------------------------------------------

private struct NotifActionRecord: Codable {
    let at: String
    let action: String
    let kind: String
    let notificationId: String
    let taskId: Int?
    let ok: Bool
    let detail: String
}

private struct NotifActionLog: Codable {
    var actions: [NotifActionRecord]
}

/// Serializa leitura+escrita do log: dois toques quase simultâneos em
/// notificações diferentes rodam no mesmo processo.
private let notifLogQueue = DispatchQueue(label: "io.jonhdev.seraphine.notiflog")

private func notifActionLogURL() -> URL? {
    FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: notifAppGroupID)?
        .appendingPathComponent(notifActionLogFileName)
}

private func notifRecordAction(
    action: String,
    kind: String,
    notificationId: String,
    taskId: Int?,
    ok: Bool,
    detail: String
) {
    let record = NotifActionRecord(
        at: notifISOFormatter.string(from: Date()),
        action: action,
        kind: kind,
        notificationId: notificationId,
        taskId: taskId,
        ok: ok,
        detail: detail
    )
    NSLog("[SeraphineNotif] \(action) kind=\(kind) id=\(notificationId) ok=\(ok) — \(detail)")
    notifLogQueue.sync {
        guard let url = notifActionLogURL() else {
            NSLog("[SeraphineNotif] App Group indisponível: ação não registrada em disco")
            return
        }
        var log = NotifActionLog(actions: [])
        if let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode(NotifActionLog.self, from: data) {
            log = decoded
        }
        log.actions.append(record)
        if log.actions.count > notifActionLogLimit {
            log.actions.removeFirst(log.actions.count - notifActionLogLimit)
        }
        if let data = try? JSONEncoder().encode(log) {
            try? data.write(to: url, options: .atomic)
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP — mesmas rotas que o app já usa, nenhum contrato novo.
//
//   PATCH /tasks/{id}  {"status":"completed"}          -> "Marcar pago"
//   PATCH /tasks/{id}  {"due_date":..,"due_time":..}   -> "Adiar 1h"
//   GET   /courses/stats                               -> streak em risco
// ---------------------------------------------------------------------------

private func notifRequest(
    method: String,
    path: String,
    body: [String: Any]?,
    completion: @escaping (Bool, String) -> Void
) {
    guard let url = URL(string: notifBackendBase + path) else {
        completion(false, "URL inválida: \(path)")
        return
    }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.timeoutInterval = 20
    if let body {
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    URLSession.shared.dataTask(with: req) { data, response, error in
        if let error {
            completion(false, "rede: \(error.localizedDescription)")
            return
        }
        guard let http = response as? HTTPURLResponse else {
            completion(false, "resposta sem status HTTP")
            return
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            completion(false, "HTTP \(http.statusCode) \(payload.prefix(160))")
            return
        }
        completion(true, "HTTP \(http.statusCode)")
    }.resume()
}

/// GET + decode síncrono. Só é chamado de filas de background.
private func notifFetch<T: Decodable>(_ path: String, as type: T.Type) -> T? {
    guard let url = URL(string: notifBackendBase + path) else { return nil }
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

// ---------------------------------------------------------------------------
// Categorias e ações.
// ---------------------------------------------------------------------------

private func notifBuildCategories() -> Set<UNNotificationCategory> {
    // `options: []` = ação de background. O app é acordado (ou relançado)
    // sem trazer a UI para frente — que é o ponto de um botão de tela de
    // bloqueio. `.foreground` abriria o app; `.authenticationRequired`
    // obrigaria a desbloquear antes de rodar.
    let markPaid = UNNotificationAction(
        identifier: notifActionMarkPaid,
        title: "Marcar pago",
        options: []
    )
    let snooze = UNNotificationAction(
        identifier: notifActionSnooze1h,
        title: "Adiar 1h",
        options: []
    )

    let bill = UNNotificationCategory(
        identifier: notifCategoryBill,
        actions: [markPaid, snooze],
        intentIdentifiers: [],
        options: []
    )

    // O alerta "Streak em risco" do handoff (linha 676) NÃO tem botões —
    // é um card de leitura. Reaproveitar a categoria da conta colocaria
    // "Marcar pago" nele, e esse botão não teria alvo nenhum (um streak
    // não é uma conta): o toque cairia no ramo "sem taskId" e não mudaria
    // estado algum. Categoria própria, sem ações, mesmo delegate e mesma
    // thread visual. Registrada mesmo vazia para o tipo continuar
    // identificável no handler.
    let streak = UNNotificationCategory(
        identifier: notifCategoryStreak,
        actions: [],
        intentIdentifiers: [],
        options: []
    )

    return [bill, streak]
}

// ---------------------------------------------------------------------------
// Delegate.
// ---------------------------------------------------------------------------

private func notifTaskId(_ userInfo: [AnyHashable: Any]) -> Int? {
    if let n = userInfo[notifKeyTaskId] as? Int { return n }
    if let n = userInfo[notifKeyTaskId] as? NSNumber { return n.intValue }
    if let s = userInfo[notifKeyTaskId] as? String { return Int(s) }
    return nil
}

private func notifKind(_ userInfo: [AnyHashable: Any]) -> String {
    (userInfo[notifKeyKind] as? String) ?? notifKindBill
}

/// "seraphine.bill.7#snooze2" -> "seraphine.bill.7". Mantém o adiamento
/// idempotente por conta em vez de acumular ids.
private func notifBaseIdentifier(_ identifier: String) -> String {
    guard let hash = identifier.firstIndex(of: "#") else { return identifier }
    return String(identifier[identifier.startIndex..<hash])
}

private let notifDueDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .iso8601)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

private let notifDueTimeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .iso8601)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "HH:mm"
    return f
}()

/// Executa "Marcar pago". Chamado tanto pelo delegate quanto pelo comando
/// de teste `notifications_run_action`, para os dois exercitarem
/// exatamente o mesmo caminho.
private func notifPerformMarkPaid(
    notificationId: String,
    userInfo: [AnyHashable: Any],
    completion: @escaping () -> Void
) {
    let kind = notifKind(userInfo)
    guard let taskId = notifTaskId(userInfo) else {
        // Só acontece se algo agendar a categoria por fora do bridge:
        // `scheduleBill` recusa payload sem taskId exatamente para o
        // botão nunca existir sem alvo.
        notifRecordAction(
            action: "mark_paid", kind: kind, notificationId: notificationId,
            taskId: nil, ok: false,
            detail: "notificação sem taskId — não há tarefa para concluir"
        )
        completion()
        return
    }
    notifRequest(
        method: "PATCH", path: "/tasks/\(taskId)", body: ["status": "completed"]
    ) { ok, detail in
        notifRecordAction(
            action: "mark_paid", kind: kind, notificationId: notificationId,
            taskId: taskId, ok: ok,
            detail: ok ? "PATCH /tasks/\(taskId) status=completed (\(detail))"
                       : "PATCH /tasks/\(taskId) falhou: \(detail)"
        )
        completion()
    }
}

/// Executa "Adiar 1h": reagenda a notificação local **e** empurra o
/// due_date/due_time da tarefa, para o resto do app (Hoje, Tarefas,
/// agenda) não continuar mostrando o horário antigo.
private func notifPerformSnooze(
    notificationId: String,
    content: UNNotificationContent,
    userInfo: [AnyHashable: Any],
    completion: @escaping () -> Void
) {
    let kind = notifKind(userInfo)
    let taskId = notifTaskId(userInfo)
    let snoozes = ((userInfo[notifKeySnoozes] as? Int)
        ?? (userInfo[notifKeySnoozes] as? NSNumber)?.intValue ?? 0) + 1
    let fireDate = Date().addingTimeInterval(notifSnoozeSeconds)

    let copy = (content.mutableCopy() as? UNMutableNotificationContent)
        ?? UNMutableNotificationContent()
    var newInfo = userInfo
    newInfo[notifKeySnoozes] = snoozes
    copy.userInfo = newInfo

    let baseId = notifBaseIdentifier(notificationId)
    let request = UNNotificationRequest(
        identifier: "\(baseId)#snooze\(snoozes)",
        content: copy,
        trigger: UNTimeIntervalNotificationTrigger(
            timeInterval: notifSnoozeSeconds, repeats: false
        )
    )

    UNUserNotificationCenter.current().add(request) { error in
        let localDetail = error == nil
            ? "reagendada para \(notifISOFormatter.string(from: fireDate))"
            : "reagendamento local falhou: \(error!.localizedDescription)"
        guard kind == notifKindBill, let taskId else {
            // Streak não tem objeto no backend para mover: o adiamento é
            // só local, e o registro diz isso em vez de fingir sucesso
            // remoto.
            notifRecordAction(
                action: "snooze_1h", kind: kind, notificationId: notificationId,
                taskId: taskId, ok: error == nil,
                detail: localDetail + " (sem tarefa no backend para reagendar)"
            )
            completion()
            return
        }
        notifRequest(
            method: "PATCH",
            path: "/tasks/\(taskId)",
            body: [
                "due_date": notifDueDateFormatter.string(from: fireDate),
                "due_time": notifDueTimeFormatter.string(from: fireDate),
            ]
        ) { ok, detail in
            notifRecordAction(
                action: "snooze_1h", kind: kind, notificationId: notificationId,
                taskId: taskId, ok: (error == nil) && ok,
                detail: ok
                    ? "\(localDetail); PATCH /tasks/\(taskId) due movido (\(detail))"
                    : "\(localDetail); PATCH /tasks/\(taskId) falhou: \(detail)"
            )
            completion()
        }
    }
}

private final class SeraphineNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = SeraphineNotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Sem isto o iOS engole a notificação quando o app está aberto, e
        // os botões nunca aparecem em teste.
        if #available(iOS 14.0, *) {
            completionHandler([.banner, .list, .sound])
        } else {
            completionHandler([.alert, .sound])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let request = response.notification.request
        let userInfo = request.content.userInfo
        switch response.actionIdentifier {
        case notifActionMarkPaid:
            notifPerformMarkPaid(
                notificationId: request.identifier, userInfo: userInfo,
                completion: completionHandler
            )
        case notifActionSnooze1h:
            notifPerformSnooze(
                notificationId: request.identifier, content: request.content,
                userInfo: userInfo, completion: completionHandler
            )
        case UNNotificationDefaultActionIdentifier:
            // Toque no corpo: o iOS já traz o app para frente. Registrado
            // só para o log contar a história inteira.
            notifRecordAction(
                action: "open", kind: notifKind(userInfo),
                notificationId: request.identifier, taskId: notifTaskId(userInfo),
                ok: true, detail: "app aberto pela notificação"
            )
            completionHandler()
        default:
            notifRecordAction(
                action: response.actionIdentifier, kind: notifKind(userInfo),
                notificationId: request.identifier, taskId: notifTaskId(userInfo),
                ok: true, detail: "ação sem tratamento"
            )
            completionHandler()
        }
    }
}

// ---------------------------------------------------------------------------
// Autorização.
// ---------------------------------------------------------------------------

private func notifAuthorizationStatus() -> UNAuthorizationStatus {
    let sem = DispatchSemaphore(value: 0)
    var status: UNAuthorizationStatus = .notDetermined
    UNUserNotificationCenter.current().getNotificationSettings { settings in
        status = settings.authorizationStatus
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 5)
    return status
}

private func notifStatusName(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown"
    }
}

// ---------------------------------------------------------------------------
// Agendamento.
// ---------------------------------------------------------------------------

private enum NotifScheduleError: Error {
    case notAuthorized(String)
    case invalidPayload(String)
    case pastFireDate(String)
    case system(String)
}

/// `switch` sobre um `Error` existencial não casa com padrões de `case`
/// de enum; o cast condicional é o caminho que o compilador aceita.
private func notifErrorMessage(_ error: Error) -> String {
    guard let scheduleError = error as? NotifScheduleError else { return "\(error)" }
    switch scheduleError {
    case .notAuthorized(let m): return m
    case .invalidPayload(let m): return m
    case .pastFireDate(let m): return "janela fechada: \(m)"
    case .system(let m): return m
    }
}

private func notifAdd(_ request: UNNotificationRequest) -> String? {
    let sem = DispatchSemaphore(value: 0)
    var failure: String?
    UNUserNotificationCenter.current().add(request) { error in
        if let error { failure = error.localizedDescription }
        sem.signal()
    }
    if sem.wait(timeout: .now() + 10) == .timedOut {
        return "timeout ao registrar a notificação"
    }
    return failure
}

/// `inSeconds` vence `at`. `at` é ISO-8601 com offset.
private func notifFireDate(from payload: [String: Any]) -> Date? {
    if let secs = payload["inSeconds"] as? Double, secs >= 1 {
        return Date().addingTimeInterval(secs)
    }
    if let secs = payload["inSeconds"] as? Int, secs >= 1 {
        return Date().addingTimeInterval(Double(secs))
    }
    guard let raw = payload["at"] as? String, !raw.isEmpty else { return nil }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return notifISOFormatter.date(from: raw) ?? withFraction.date(from: raw)
}

private func notifScheduleBill(_ payload: [String: Any]) throws -> (String, Date) {
    let status = notifAuthorizationStatus()
    guard status == .authorized || status == .provisional || status == .ephemeral else {
        throw NotifScheduleError.notAuthorized(
            "notificações não autorizadas (\(notifStatusName(status)))"
        )
    }
    // Sem taskId não há o que concluir: melhor não agendar do que
    // entregar um "Marcar pago" que não muda estado nenhum.
    let taskId = notifTaskId(payload as [AnyHashable: Any])
    guard let taskId, taskId > 0 else {
        throw NotifScheduleError.invalidPayload(
            "taskId obrigatório: 'Marcar pago' precisa de uma tarefa para concluir"
        )
    }
    let title = (payload["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !title.isEmpty else {
        throw NotifScheduleError.invalidPayload("title obrigatório")
    }
    let body = (payload["body"] as? String) ?? ""
    guard let fireDate = notifFireDate(from: payload) else {
        throw NotifScheduleError.invalidPayload("informe 'at' (ISO-8601) ou 'inSeconds'")
    }
    let delay = fireDate.timeIntervalSinceNow
    guard delay >= 1 else {
        throw NotifScheduleError.pastFireDate("horário já passou (\(Int(delay))s)")
    }

    let content = UNMutableNotificationContent()
    // O iOS já mostra "Seraphine" no cabeçalho da notificação (nome do
    // app), então o título carrega o que o handoff põe na segunda linha.
    content.title = "Lembrete · \(title)"
    content.body = body
    content.sound = .default
    content.categoryIdentifier = notifCategoryBill
    content.threadIdentifier = notifThreadIdentifier
    content.userInfo = [
        notifKeyKind: notifKindBill,
        notifKeyTaskId: taskId,
        notifKeySnoozes: 0,
    ]

    let identifier = "\(notifBillIdentifierPrefix)\(taskId)"
    let request = UNNotificationRequest(
        identifier: identifier,
        content: content,
        trigger: UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false)
    )
    if let failure = notifAdd(request) {
        throw NotifScheduleError.system(failure)
    }
    return (identifier, fireDate)
}

private func notifScheduleStreak(streak: Int, fireDate: Date) throws -> String {
    let status = notifAuthorizationStatus()
    guard status == .authorized || status == .provisional || status == .ephemeral else {
        throw NotifScheduleError.notAuthorized(
            "notificações não autorizadas (\(notifStatusName(status)))"
        )
    }
    let delay = fireDate.timeIntervalSinceNow
    guard delay >= 1 else {
        throw NotifScheduleError.pastFireDate("horário já passou (\(Int(delay))s)")
    }
    let content = UNMutableNotificationContent()
    content.title = "Streak em risco"
    // O handoff escreve "5 min de Rust mantêm seus 7 dias". O número de
    // dias é dado real (`/courses/stats.streak_count`); o nome do curso
    // NÃO é — o backend não expõe "curso atual" (`GET /courses` ordena por
    // created_ts, não por atividade). Então o corpo fica sem curso em vez
    // de inventar um.
    content.body = streak == 1
        ? "Uma lição hoje mantém seu 1 dia de streak."
        : "Uma lição hoje mantém seus \(streak) dias de streak."
    content.sound = .default
    content.categoryIdentifier = notifCategoryStreak
    content.threadIdentifier = notifThreadIdentifier
    content.userInfo = [notifKeyKind: notifKindStreak, notifKeySnoozes: 0]

    let request = UNNotificationRequest(
        identifier: notifStreakIdentifier,
        content: content,
        trigger: UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false)
    )
    if let failure = notifAdd(request) {
        throw NotifScheduleError.system(failure)
    }
    return notifStreakIdentifier
}

// ---------------------------------------------------------------------------
// "Streak em risco" — decidido a partir de dado real, não de palpite.
//
// `courses/service.py:complete_lesson` compara `streak_last_day` com o dia
// **UTC** de hoje/ontem. Logo o streak vira quando o dia UTC vira, não à
// meia-noite local: em São Paulo (UTC-3) o prazo real é 21:00 local.
//
// Está em risco quando: streak_count > 0 e streak_last_day == ontem (UTC).
//   * == hoje (UTC)  -> já estudou, nada em risco;
//   * < ontem (UTC)  -> streak já quebrado, a próxima lição reinicia em 1.
//
// O alerta dispara 1h antes da virada do dia UTC — o handoff desenha 21:00,
// que em BRT é exatamente o instante da virada, ou seja tarde demais para
// "uma lição ainda salva". Ver o relatório da task.
// ---------------------------------------------------------------------------

private struct NotifCoursesStats: Decodable {
    let streak_count: Int?
    let streak_last_day: String?
}

private let notifUTCDayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .iso8601)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

/// Instante da próxima virada de dia UTC menos uma hora.
private func notifStreakDeadline(from now: Date = Date()) -> Date? {
    var cal = Calendar(identifier: .gregorian)
    guard let utc = TimeZone(identifier: "UTC") else { return nil }
    cal.timeZone = utc
    guard let nextMidnight = cal.nextDate(
        after: now,
        matching: DateComponents(hour: 0, minute: 0, second: 0),
        matchingPolicy: .nextTime
    ) else { return nil }
    return nextMidnight.addingTimeInterval(-3600)
}

/// Retorna JSON descrevendo o que foi decidido — nunca silêncio.
private func notifSyncStreakAlert() -> String {
    guard let stats = notifFetch("/courses/stats", as: NotifCoursesStats.self) else {
        return "{\"ok\":false,\"message\":\"/courses/stats inacessível\"}"
    }
    let streak = stats.streak_count ?? 0
    let lastDay = stats.streak_last_day ?? ""
    let now = Date()
    let todayUTC = notifUTCDayFormatter.string(from: now)
    let yesterdayUTC = notifUTCDayFormatter.string(from: now.addingTimeInterval(-86400))

    let center = UNUserNotificationCenter.current()
    let atRisk = streak > 0 && lastDay == yesterdayUTC
    guard atRisk else {
        center.removePendingNotificationRequests(withIdentifiers: [notifStreakIdentifier])
        let why: String
        if streak <= 0 {
            why = "sem streak para perder"
        } else if lastDay == todayUTC {
            why = "já estudou hoje (UTC \(todayUTC))"
        } else {
            why = "streak já quebrado (último dia \(lastDay), ontem UTC \(yesterdayUTC))"
        }
        return "{\"ok\":true,\"scheduled\":false,\"streak\":\(streak)," +
            "\"lastDay\":\"\(notifJsonEscape(lastDay))\"," +
            "\"reason\":\"\(notifJsonEscape(why))\"}"
    }
    guard let deadline = notifStreakDeadline(from: now) else {
        return "{\"ok\":false,\"message\":\"não foi possível calcular a virada do dia UTC\"}"
    }
    do {
        let id = try notifScheduleStreak(streak: streak, fireDate: deadline)
        return "{\"ok\":true,\"scheduled\":true,\"streak\":\(streak)," +
            "\"id\":\"\(notifJsonEscape(id))\"," +
            "\"fireAt\":\"\(notifJsonEscape(notifISOFormatter.string(from: deadline)))\"}"
    } catch {
        let message = notifErrorMessage(error)
        return "{\"ok\":false,\"scheduled\":false,\"streak\":\(streak)," +
            "\"message\":\"\(notifJsonEscape(message))\"}"
    }
}

#endif // os(iOS)

// ===========================================================================
// ABI C — tudo abaixo é o que Rust enxerga.
// ===========================================================================

private let notifNotIOS = "notificações ricas só existem no build iOS"

/// Instala delegate + categorias e liga o watcher do streak. Chamado do
/// hook `setup` do Tauri, antes de `UIApplicationMain`.
@_cdecl("seraphine_notifications_install")
public func seraphine_notifications_install() -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    let center = UNUserNotificationCenter.current()
    center.delegate = SeraphineNotificationDelegate.shared
    center.setNotificationCategories(notifBuildCategories())

    if notifStreakObserver == nil {
        notifStreakObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            DispatchQueue.global(qos: .utility).async {
                NSLog("[SeraphineNotif] streak sync (foreground): \(notifSyncStreakAlert())")
            }
        }
    }
    DispatchQueue.global(qos: .utility).async {
        NSLog("[SeraphineNotif] streak sync (launch): \(notifSyncStreakAlert())")
    }

    let status = notifStatusName(notifAuthorizationStatus())
    return notifOk("\"categories\":[\"\(notifCategoryBill)\",\"\(notifCategoryStreak)\"]," +
        "\"authorization\":\"\(status)\"")
    #else
    return notifFailure(notifNotIOS)
    #endif
}

/// Pede autorização. O onboarding (task 24) é quem chama isto em contexto;
/// `install()` deliberadamente NÃO pergunta nada no launch.
@_cdecl("seraphine_notifications_request_authorization")
public func seraphine_notifications_request_authorization() -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    var failure: String?
    UNUserNotificationCenter.current().requestAuthorization(
        options: [.alert, .sound, .badge]
    ) { ok, error in
        granted = ok
        if let error { failure = error.localizedDescription }
        sem.signal()
    }
    if sem.wait(timeout: .now() + 60) == .timedOut {
        return notifFailure("timeout esperando a resposta do usuário")
    }
    if let failure { return notifFailure(failure) }
    return notifOk("\"granted\":\(granted)," +
        "\"authorization\":\"\(notifStatusName(notifAuthorizationStatus()))\"")
    #else
    return notifFailure(notifNotIOS)
    #endif
}

/// Autorização + categorias registradas + notificações pendentes.
@_cdecl("seraphine_notifications_status")
public func seraphine_notifications_status() -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    let center = UNUserNotificationCenter.current()

    var categories: [String] = []
    let catSem = DispatchSemaphore(value: 0)
    center.getNotificationCategories { set in
        categories = set.map { $0.identifier }.sorted()
        catSem.signal()
    }
    _ = catSem.wait(timeout: .now() + 5)

    var pending: [String] = []
    let pendSem = DispatchSemaphore(value: 0)
    center.getPendingNotificationRequests { requests in
        pending = requests.map { req -> String in
            let trigger = req.trigger as? UNTimeIntervalNotificationTrigger
            let fire = trigger?.nextTriggerDate().map { notifISOFormatter.string(from: $0) } ?? ""
            return "{\"id\":\"\(notifJsonEscape(req.identifier))\"," +
                "\"category\":\"\(notifJsonEscape(req.content.categoryIdentifier))\"," +
                "\"title\":\"\(notifJsonEscape(req.content.title))\"," +
                "\"fireAt\":\"\(notifJsonEscape(fire))\"}"
        }.sorted()
        pendSem.signal()
    }
    _ = pendSem.wait(timeout: .now() + 5)

    let cats = categories.map { "\"\(notifJsonEscape($0))\"" }.joined(separator: ",")
    return notifOk(
        "\"authorization\":\"\(notifStatusName(notifAuthorizationStatus()))\"," +
        "\"categories\":[\(cats)],\"pending\":[\(pending.joined(separator: ","))]"
    )
    #else
    return notifFailure(notifNotIOS)
    #endif
}

/// Agenda o lembrete de conta. Payload:
/// `{"taskId":7,"title":"Pagar aluguel","body":"…","at":"ISO-8601"}`
/// ou `"inSeconds":30` no lugar de `at`.
@_cdecl("seraphine_notifications_schedule_bill")
public func seraphine_notifications_schedule_bill(
    _ jsonPtr: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    guard let jsonPtr else { return notifFailure("payload nulo") }
    guard
        let data = String(cString: jsonPtr).data(using: .utf8),
        let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return notifFailure("payload não é um objeto JSON") }
    do {
        let (id, fireDate) = try notifScheduleBill(payload)
        return notifOk("\"id\":\"\(notifJsonEscape(id))\"," +
            "\"fireAt\":\"\(notifJsonEscape(notifISOFormatter.string(from: fireDate)))\"," +
            "\"category\":\"\(notifCategoryBill)\"")
    } catch {
        return notifFailure(notifErrorMessage(error))
    }
    #else
    _ = jsonPtr
    return notifFailure(notifNotIOS)
    #endif
}

/// Reavalia o streak contra `/courses/stats` e agenda/cancela o alerta.
@_cdecl("seraphine_notifications_sync_streak")
public func seraphine_notifications_sync_streak() -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    return notifCString(notifSyncStreakAlert())
    #else
    return notifFailure(notifNotIOS)
    #endif
}

/// Cancela uma notificação pendente (e as cópias adiadas dela).
@_cdecl("seraphine_notifications_cancel")
public func seraphine_notifications_cancel(
    _ idPtr: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    guard let idPtr else { return notifFailure("id nulo") }
    let id = String(cString: idPtr)
    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var removed: [String] = []
    center.getPendingNotificationRequests { requests in
        removed = requests
            .map { $0.identifier }
            .filter { $0 == id || notifBaseIdentifier($0) == id }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 5)
    center.removePendingNotificationRequests(withIdentifiers: removed)
    let list = removed.map { "\"\(notifJsonEscape($0))\"" }.joined(separator: ",")
    return notifOk("\"removed\":[\(list)]")
    #else
    _ = idPtr
    return notifFailure(notifNotIOS)
    #endif
}

/// Últimas ações tratadas, lidas do App Group. É por aqui que a UI
/// descobre que um "Marcar pago" falhou depois do fato.
@_cdecl("seraphine_notifications_action_log")
public func seraphine_notifications_action_log() -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    guard let url = notifActionLogURL() else {
        return notifFailure("App Group \(notifAppGroupID) indisponível")
    }
    guard
        let data = try? Data(contentsOf: url),
        let raw = String(data: data, encoding: .utf8)
    else {
        return notifOk("\"actions\":[]")
    }
    return notifCString("{\"ok\":true,\"log\":\(raw)}")
    #else
    return notifFailure(notifNotIOS)
    #endif
}

/// Roda o **mesmo** handler que o delegate roda, sem depender de um toque
/// real. Existe para teste/diagnóstico: prova o caminho até o backend, não
/// a entrega da resposta pelo iOS.
@_cdecl("seraphine_notifications_run_action")
public func seraphine_notifications_run_action(
    _ jsonPtr: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar> {
    #if os(iOS)
    guard let jsonPtr else { return notifFailure("payload nulo") }
    guard
        let data = String(cString: jsonPtr).data(using: .utf8),
        let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let action = payload["action"] as? String
    else { return notifFailure("payload precisa de {\"action\":…}") }

    let notificationId = (payload["notificationId"] as? String) ?? "manual"
    var userInfo: [AnyHashable: Any] = [
        notifKeyKind: (payload[notifKeyKind] as? String) ?? notifKindBill,
        notifKeySnoozes: (payload[notifKeySnoozes] as? Int) ?? 0,
    ]
    if let taskId = notifTaskId(payload as [AnyHashable: Any]) {
        userInfo[notifKeyTaskId] = taskId
    }

    let sem = DispatchSemaphore(value: 0)
    switch action {
    case notifActionMarkPaid, "mark_paid":
        notifPerformMarkPaid(notificationId: notificationId, userInfo: userInfo) {
            sem.signal()
        }
    case notifActionSnooze1h, "snooze_1h":
        let content = UNMutableNotificationContent()
        content.title = (payload["title"] as? String) ?? "Lembrete"
        content.body = (payload["body"] as? String) ?? ""
        content.categoryIdentifier = notifCategoryBill
        content.threadIdentifier = notifThreadIdentifier
        content.userInfo = userInfo
        notifPerformSnooze(
            notificationId: notificationId, content: content, userInfo: userInfo
        ) { sem.signal() }
    default:
        return notifFailure("ação desconhecida: \(action)")
    }
    if sem.wait(timeout: .now() + 40) == .timedOut {
        return notifFailure("timeout executando \(action)")
    }
    return notifOk("\"action\":\"\(notifJsonEscape(action))\"")
    #else
    _ = jsonPtr
    return notifFailure(notifNotIOS)
    #endif
}
