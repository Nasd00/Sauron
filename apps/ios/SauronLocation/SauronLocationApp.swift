import SwiftUI
import UIKit

@main
struct SauronLocationApp: App {
    @StateObject private var model = SharingModel(
        location: CoreLocationProvider(),
        credentials: KeychainCredentialStore(),
        settings: SharingSettings(defaults: .standard),
        backgroundTask: SauronLocationApp.runInBackgroundTask,
        notifier: LocalIncidentNotifier()
    )
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .onOpenURL { model.handle(url: $0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.handle(url: url) }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.appDidBecomeActive() } }
                }
        }
    }

    /// Lets an upload started in the background finish before iOS suspends the app.
    @MainActor
    static func runInBackgroundTask(_ work: @escaping () async -> Void) async {
        var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask(withName: "location-upload") {
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        await work()
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    }
}
