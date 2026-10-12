import AppIntents
import Capacitor
import UIKit

// App Shortcuts, so "New Session" also shows up in the Shortcuts app and Siri can run it.
//
// The Control Center control's OpenNewSessionIntent (OpenChamberControl.swift) answers with an
// OpenURLIntent for `openchamber://new`. The system honours that from a control, but Shortcuts
// and Siri refuse to open a custom URL scheme ("launch is prohibited"), so the app would open
// without the new session draft. This intent lives only in the app target: it runs inside the
// launched app and hands the same deep link to Capacitor, which delivers it to the web layer as
// `appUrlOpen` (kept until a listener consumes it, so a cold launch does not lose it).
// Gated to iOS 18.0 to match the control, so the app's 15.5 deployment target stays clean.
@available(iOS 18.0, *)
struct NewSessionShortcutIntent: AppIntent {
    static let title: LocalizedStringResource = "New OpenChamber Session"
    static let description = IntentDescription("Opens OpenChamber on a new session.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let url = URL(string: "openchamber://new") else { return .result() }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        return .result()
    }
}

@available(iOS 18.0, *)
struct OpenChamberAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NewSessionShortcutIntent(),
            phrases: [
                "Start a new session in \(.applicationName)",
                "Start a new \(.applicationName) session",
                "New session in \(.applicationName)",
            ],
            shortTitle: "New Session",
            systemImageName: "plus.bubble"
        )
    }
}
