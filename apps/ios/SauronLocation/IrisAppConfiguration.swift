import Foundation

/// Resolves the Iris web client used by the native shell.
///
/// Keeping the URL in build configuration lets Debug builds point at Vite while
/// release builds can point at the deployed site without baking API credentials
/// into the application. The web client continues to own Street View and voice.
enum IrisAppConfiguration {
    static let environmentKey = "IRIS_WEB_APP_URL"
    static let infoPlistKey = "IrisWebAppURL"

    static var webAppURL: URL? {
        resolve(
            environmentValue: ProcessInfo.processInfo.environment[environmentKey],
            infoPlistValue: Bundle.main.object(forInfoDictionaryKey: infoPlistKey) as? String
        )
    }

    static func resolve(environmentValue: String?, infoPlistValue: String?) -> URL? {
        [environmentValue, infoPlistValue]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty && !$0.contains("$(") })
            .flatMap(validWebURL)
    }

    private static func validWebURL(_ value: String) -> URL? {
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              url.host != nil else { return nil }
        return url
    }
}

/// Photon endpoint used for direct pairing of an already registered phone.
enum MobileAppConfiguration {
    static let environmentKey = "PHOTON_API_URL"
    static let infoPlistKey = "PhotonAPIBaseURL"

    static var apiBaseURL: URL? {
        resolve(
            environmentValue: ProcessInfo.processInfo.environment[environmentKey],
            infoPlistValue: Bundle.main.object(forInfoDictionaryKey: infoPlistKey) as? String
        )
    }

    static func resolve(environmentValue: String?, infoPlistValue: String?) -> URL? {
        [environmentValue, infoPlistValue]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty && !$0.contains("$(") })
            .flatMap { value in
                guard let url = URL(string: value),
                      let scheme = url.scheme?.lowercased(),
                      let host = url.host,
                      scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else { return nil }
                return url
            }
    }
}
