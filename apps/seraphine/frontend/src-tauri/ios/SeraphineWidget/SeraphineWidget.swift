// Seraphine widget — lock screen (accessoryRectangular) + home
// screen / StandBy (systemSmall).
//
// Design source: apps/seraphine/frontend/handoff_mobile 2/
//   "Seraphine Mobile.dc.html", line 676 ("Lock screen · widget +
//   notificação rica").
//
// PLATFORM NOTE (verified against WidgetKit, not the mockup): the
// handoff draws a 170pt coloured glass card sitting under the clock.
// Real iOS lock-screen widgets are `accessoryRectangular`, ~160x72pt,
// and the system renders them in a vibrant monochrome tint — custom
// fills, gradients and border colours are discarded. So the glass card
// from the handoff is implemented faithfully for `systemSmall` (home
// screen and StandBy), and `accessoryRectangular` carries the same
// information in the shape the lock screen actually allows.
//
// Symbols are SF Symbols (flame.fill / bolt.fill) — no emoji in source.

import SwiftUI
import WidgetKit

// MARK: - Handoff tokens

private enum Tokens {
    /// rgba(23,23,30,0.72)
    static let glass = Color(red: 23 / 255, green: 23 / 255, blue: 30 / 255).opacity(0.72)
    /// rgba(255,255,255,0.1)
    static let border = Color.white.opacity(0.10)
    /// --text #ececef
    static let text = Color(red: 0xEC / 255, green: 0xEC / 255, blue: 0xEF / 255)
    /// --dim #9594a0
    static let dim = Color(red: 0x95 / 255, green: 0x94 / 255, blue: 0xA0 / 255)
    /// --faint #5f5e6b
    static let faint = Color(red: 0x5F / 255, green: 0x5E / 255, blue: 0x6B / 255)
    /// agenda rail #42a5f5
    static let rail = Color(red: 0x42 / 255, green: 0xA5 / 255, blue: 0xF5 / 255)
    /// streak #ff8a4c
    static let streak = Color(red: 0xFF / 255, green: 0x8A / 255, blue: 0x4C / 255)
    /// xp #ffd54f
    static let xp = Color(red: 0xFF / 255, green: 0xD5 / 255, blue: 0x4F / 255)
    /// orb radial-gradient(#efedff → --orb2 #9a93ff 60% → #332d85)
    static let orb = RadialGradient(
        colors: [
            Color(red: 0xEF / 255, green: 0xED / 255, blue: 0xFF / 255),
            Color(red: 0x9A / 255, green: 0x93 / 255, blue: 0xFF / 255),
            Color(red: 0x33 / 255, green: 0x2D / 255, blue: 0x85 / 255),
        ],
        center: UnitPoint(x: 0.32, y: 0.26),
        startRadius: 0,
        endRadius: 22
    )
    /// border-radius 20-22 in the handoff.
    static let radius: CGFloat = 20
}

private func formatXP(_ value: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = "."
    f.groupingSize = 3
    return f.string(from: NSNumber(value: value)) ?? String(value)
}

private func agendaHeadline(_ count: Int) -> String {
    switch count {
    case 0: return "Nada na agenda"
    case 1: return "1 compromisso hoje"
    default: return "\(count) compromissos hoje"
    }
}

// MARK: - systemSmall (home screen / StandBy) — the handoff card

private struct GlassCardView: View {
    let entry: SeraphineEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Circle()
                    .fill(Tokens.orb)
                    .frame(width: 20, height: 20)
                Text("SERAPHINE")
                    .font(.system(size: 10, weight: .bold))
                    .kerning(0.3)
                    .foregroundStyle(Tokens.dim)
                Spacer(minLength: 0)
            }

            Text(entry.hasData ? agendaHeadline(entry.snapshot.agenda.count) : "Sem dados ainda")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Tokens.text)
                .padding(.top, 7)
                .lineLimit(1)
                // "3 compromissos hoje" does not fit a systemSmall at 13pt
                // on the narrowest devices; shrink rather than truncate.
                .minimumScaleFactor(0.6)

            ForEach(entry.snapshot.agenda.prefix(2)) { item in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Tokens.rail)
                        .frame(width: 3, height: 24)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(item.title)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Tokens.text)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Text(item.displayTime)
                            .font(.system(size: 9, weight: .medium))
                            // The handoff uses --faint (#5f5e6b) here, but
                            // at 9pt over the translucent fill that is
                            // unreadable on a light wallpaper — --dim is
                            // the smallest step up that stays legible.
                            .foregroundStyle(Tokens.dim)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 5)
            }

            Spacer(minLength: 4)

            HStack(spacing: 8) {
                Label {
                    Text("\(entry.snapshot.streak)")
                } icon: {
                    Image(systemName: "flame.fill")
                }
                .foregroundStyle(Tokens.streak)

                Label {
                    Text("\(formatXP(entry.snapshot.xp)) XP")
                } icon: {
                    Image(systemName: "bolt.fill")
                }
                .foregroundStyle(Tokens.xp)

                Spacer(minLength: 0)
            }
            .labelStyle(.titleAndIcon)
            .font(.system(size: 10, weight: .bold))
            // Five-digit XP would otherwise wrap the "XP" suffix onto a
            // second line and push the row out of the card.
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        // Real backdrop blur is impossible in a widget (there is no live
        // layer behind it to sample). The system already composites the
        // widget over the wallpaper, so the handoff fill at 0.72 alpha
        // IS the glass — layering a material on top only washed it out
        // to grey.
        .containerBackground(Tokens.glass, for: .widget)
        .overlay(
            ContainerRelativeShape()
                .stroke(Tokens.border, lineWidth: 1)
        )
    }
}

// MARK: - accessoryRectangular (actual lock screen)

private struct LockScreenView: View {
    let entry: SeraphineEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(entry.hasData ? agendaHeadline(entry.snapshot.agenda.count) : "Seraphine")
                .font(.headline)
                .widgetAccentable()
                .lineLimit(1)

            if let next = entry.snapshot.agenda.first {
                Text("\(next.displayTime)  \(next.title)")
                    .font(.system(size: 13))
                    .lineLimit(1)
            } else if entry.hasData {
                Text("Dia livre")
                    .font(.system(size: 13))
                    .lineLimit(1)
            } else {
                Text("Abra o app para sincronizar")
                    .font(.system(size: 13))
                    .lineLimit(1)
            }

            HStack(spacing: 8) {
                Label("\(entry.snapshot.streak)", systemImage: "flame.fill")
                Label("\(formatXP(entry.snapshot.xp)) XP", systemImage: "bolt.fill")
            }
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        // The lock screen composites over the wallpaper; anything opaque
        // here reads as a bug.
        .containerBackground(for: .widget) { Color.clear }
    }
}

// MARK: - Entry point

struct SeraphineWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SeraphineEntry

    var body: some View {
        switch family {
        case .accessoryRectangular:
            LockScreenView(entry: entry)
        default:
            GlassCardView(entry: entry)
        }
    }
}

struct SeraphineWidget: Widget {
    let kind = "SeraphineAgendaWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SeraphineProvider()) { entry in
            SeraphineWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Seraphine")
        .description("Agenda de hoje, streak e XP.")
        .supportedFamilies([.systemSmall, .accessoryRectangular])
    }
}

@main
struct SeraphineWidgetBundle: WidgetBundle {
    var body: some Widget {
        SeraphineWidget()
    }
}
