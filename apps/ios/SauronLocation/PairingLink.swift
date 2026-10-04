import Foundation

/// A pairing request opened from the iMessage bot's link, either through the
/// `sauron://pair?token=…&api=…` scheme (from the pairing web page) or a universal
/// link `https://<host>/pair/<token>`. The token is single-use and resolved
/// server-side to the user's Spectrum identity; the app never asks for one.
struct PairingLink: Equatable {
    let token: String
    /// The server that issued the link; the app pairs with and uploads to it.
    let apiBaseURL: URL

    var host: String { apiBaseURL.host ?? apiBaseURL.absoluteString }

    static func parse(_ url: URL) -> PairingLink? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased() else { return nil }

        let token: String?
        let base: URL?
        switch scheme {
        case "sauron":
            guard components.host == "pair" else { return nil }
            token = components.queryItems?.first { $0.name == "token" }?.value
            base = components.queryItems?.first { $0.name == "api" }?.value.flatMap(URL.init(string:))
        case "https":
            let parts = url.pathComponents.filter { $0 != "/" }
            guard parts.count >= 2, parts[parts.count - 2] == "pair" else { return nil }
            token = parts.last
            var baseComponents = URLComponents()
            baseComponents.scheme = "https"
            baseComponents.host = components.host
            baseComponents.port = components.port
            let prefix = parts.dropLast(2)
            baseComponents.path = prefix.isEmpty ? "" : "/" + prefix.joined(separator: "/")
            base = baseComponents.url
        default:
            return nil
        }

        guard let token, isValidToken(token), let base, let apiBaseURL = normalizedBaseURL(base) else { return nil }
        return PairingLink(token: token, apiBaseURL: apiBaseURL)
    }

    /// Pairing tokens are 256-bit base64url strings.
    static func isValidToken(_ token: String) -> Bool {
        token.count == 43 && token.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Requires HTTPS, except plain HTTP to localhost for simulator testing.
    static func normalizedBaseURL(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), let host = components.host, !host.isEmpty else { return nil }
        let isLocal = ["localhost", "127.0.0.1"].contains(host.lowercased())
        guard scheme == "https" || (scheme == "http" && isLocal) else { return nil }
        guard components.user == nil, components.password == nil else { return nil }
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") { components.path.removeLast() }
        return components.url
    }
}
