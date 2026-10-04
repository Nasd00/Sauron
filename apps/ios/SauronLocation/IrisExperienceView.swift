import SwiftUI
import UIKit
import WebKit

/// Hosts the existing Iris operator client so Street View, realtime voice, and
/// their shared map actions stay identical on web and iOS.
struct IrisExperienceView: View {
    private let appURL: URL?
    private let isActive: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var loadState: IrisWebView.LoadState = .loading
    @State private var reloadID = UUID()

    init(appURL: URL? = IrisAppConfiguration.webAppURL, isActive: Bool = true) {
        self.appURL = appURL
        self.isActive = isActive
    }

    var body: some View {
        ZStack {
            Color(red: 0.025, green: 0.055, blue: 0.07).ignoresSafeArea()

            if let appURL {
                IrisWebView(
                    url: appURL,
                    reloadID: reloadID,
                    isActive: isActive && scenePhase == .active,
                    loadState: $loadState
                )

                if case let .failed(message) = loadState {
                    failureCard(message: message)
                } else if loadState == .loading {
                    ProgressView("CONNECTING TO IRIS")
                        .font(.caption.monospaced().weight(.semibold))
                        .tint(.cyan)
                        .foregroundStyle(.white.opacity(0.82))
                        .padding(16)
                        .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityIdentifier("iris-loading")
                }
            } else {
                configurationCard
            }
        }
        .preferredColorScheme(.dark)
    }

    private func failureCard(message: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("IRIS OFFLINE", systemImage: "antenna.radiowaves.left.and.right.slash")
                .font(.headline.monospaced())
                .foregroundStyle(.cyan)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.78))
            Button("Retry") { reloadID = UUID() }
                .buttonStyle(.borderedProminent)
                .tint(.cyan.opacity(0.8))
        }
        .padding(20)
        .frame(maxWidth: 340, alignment: .leading)
        .background(.black.opacity(0.88), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.cyan.opacity(0.35)))
        .padding(24)
        .accessibilityIdentifier("iris-load-error")
    }

    private var configurationCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("IRIS URL REQUIRED", systemImage: "globe.americas.fill")
                .font(.headline.monospaced())
                .foregroundStyle(.cyan)
            Text("Set the IRIS_WEB_APP_URL build setting to the Iris HTTPS site. Debug builds use the shared development tunnel.")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.78))
        }
        .padding(20)
        .frame(maxWidth: 340, alignment: .leading)
        .background(.black.opacity(0.88), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.cyan.opacity(0.35)))
        .padding(24)
        .accessibilityIdentifier("iris-configuration-error")
    }
}

struct IrisWebView: UIViewRepresentable {
    enum LoadState: Equatable {
        case loading
        case ready
        case failed(String)
    }

    let url: URL
    let reloadID: UUID
    let isActive: Bool
    @Binding var loadState: LoadState

    func makeCoordinator() -> Coordinator {
        Coordinator(allowedOrigin: Self.origin(of: url), loadState: $loadState)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        if url.host?.hasSuffix(".ngrok-free.dev") == true {
            // URLRequest headers apply only to the first document. A native
            // user agent also bypasses ngrok's interstitial for ES modules,
            // stylesheets, workers, and fetch requests made by the page.
            webView.customUserAgent = "IrisNative/0.1 (iOS; AppleWebKit/605.1.15)"
        }
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.025, green: 0.055, blue: 0.07, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.accessibilityIdentifier = "iris-web-view"

        context.coordinator.lastReloadID = reloadID
        context.coordinator.lastIsActive = isActive
        webView.load(Self.request(for: url, cachePolicy: .useProtocolCachePolicy))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.loadState = $loadState
        if context.coordinator.lastIsActive, !isActive {
            // A live realtime session should not keep recording after the user
            // leaves Iris or backgrounds the app.
            webView.evaluateJavaScript("window.__irisVoiceCommands?.stop?.()")
        }
        context.coordinator.lastIsActive = isActive
        guard context.coordinator.lastReloadID != reloadID else { return }
        context.coordinator.lastReloadID = reloadID
        loadState = .loading
        webView.load(Self.request(for: url, cachePolicy: .reloadRevalidatingCacheData))
    }

    static func request(for url: URL, cachePolicy: URLRequest.CachePolicy) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: cachePolicy)
        // The native app should open Iris directly rather than ngrok's browser
        // confirmation page during development.
        if url.host?.hasSuffix(".ngrok-free.dev") == true {
            request.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
        }
        return request
    }

    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let port = normalizedPort(url.port, scheme: scheme).map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    private static func normalizedPort(_ port: Int?, scheme: String) -> Int? {
        guard let port, port != 0 else { return nil }
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) { return nil }
        return port
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let allowedOrigin: String?
        var loadState: Binding<LoadState>
        var lastReloadID: UUID?
        var lastIsActive = false

        init(allowedOrigin: String?, loadState: Binding<LoadState>) {
            self.allowedOrigin = allowedOrigin
            self.loadState = loadState
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            loadState.wrappedValue = .loading
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loadState.wrappedValue = .ready
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            guard !Self.isCancellation(error) else { return }
            loadState.wrappedValue = .failed(failureMessage(for: error))
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard !Self.isCancellation(error) else { return }
            loadState.wrappedValue = .failed(failureMessage(for: error))
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            if navigationResponse.isForMainFrame,
               let response = navigationResponse.response as? HTTPURLResponse,
               response.statusCode >= 400 {
                loadState.wrappedValue = .failed(
                    "Iris at \(allowedOrigin ?? "the configured server") returned HTTP \(response.statusCode). Make sure the Iris development stack is running, then retry."
                )
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        /// Voice capture is granted only to the configured Iris origin. iOS still
        /// presents the app-level microphone consent prompt on first use.
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            let scheme = origin.protocol.lowercased()
            let normalizedPort: String
            if origin.port == 0 || (scheme == "https" && origin.port == 443) || (scheme == "http" && origin.port == 80) {
                normalizedPort = ""
            } else {
                normalizedPort = ":\(origin.port)"
            }
            let requestingOrigin = "\(scheme)://\(origin.host.lowercased())\(normalizedPort)"
            decisionHandler(type == .microphone && requestingOrigin == allowedOrigin ? .grant : .deny)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.targetFrame?.isMainFrame != false,
                  let destination = navigationAction.request.url,
                  let destinationOrigin = IrisWebView.origin(of: destination),
                  destinationOrigin != allowedOrigin else {
                decisionHandler(.allow)
                return
            }
            UIApplication.shared.open(destination)
            decisionHandler(.cancel)
        }

        /// Links that intentionally open a new window stay usable inside the app.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                webView.load(IrisWebView.request(for: url, cachePolicy: .useProtocolCachePolicy))
            }
            return nil
        }

        private static func isCancellation(_ error: Error) -> Bool {
            let nsError = error as NSError
            return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
        }

        private func failureMessage(for error: Error) -> String {
            "Couldn’t reach Iris at \(allowedOrigin ?? "the configured server"). \(error.localizedDescription) Make sure the Iris development stack is running, then retry."
        }
    }
}
