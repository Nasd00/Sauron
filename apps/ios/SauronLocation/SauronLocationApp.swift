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
            AppRootView(model: model)
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

private struct AppRootView: View {
    enum Tab: Hashable {
        case iris
        case location
    }

    @ObservedObject var model: SharingModel
    @State private var selection: Tab = .iris
    @State private var showingIntro = true

    var body: some View {
        ZStack {
            TabView(selection: $selection) {
                IrisExperienceView(isActive: selection == .iris)
                    .tabItem { Label("Iris", systemImage: "globe.americas.fill") }
                    .tag(Tab.iris)

                ContentView(model: model)
                    .tabItem { Label("Location", systemImage: "location.fill") }
                    .tag(Tab.location)
            }
            .allowsHitTesting(!showingIntro)
            .accessibilityHidden(showingIntro)

            if showingIntro {
                ZStack {
                    Color.black.ignoresSafeArea()
                    Image("IrisLaunchLogo")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 250, height: 250)
                        .accessibilityLabel("Iris")
                }
                .transition(.opacity)
                .accessibilityIdentifier("iris-intro")
            }
        }
        .tint(.cyan)
        .task {
            guard showingIntro else { return }
            do {
                try await Task.sleep(for: .seconds(1.6))
                withAnimation(.easeOut(duration: 0.25)) { showingIntro = false }
            } catch { /* Cancellation leaves the intro ready for the next appearance. */ }
        }
        .onOpenURL { url in
            if model.handle(url: url) { selection = .location }
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL, model.handle(url: url) { selection = .location }
        }
    }
}
