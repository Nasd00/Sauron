import Foundation

/// Device state reported by the backend.
struct DeviceState: Decodable, Equatable {
    var deviceId: String
    /// False after STOP over iMessage; uploads are rejected until WATCH ME.
    var trackingActive: Bool
    var sharingEnabled: Bool
}

struct PairResponse: Decodable, Equatable {
    var deviceToken: String
    var deviceId: String
    var trackingActive: Bool
    var sharingEnabled: Bool
}

/// Body of `POST /api/mobile/location`.
struct LocationUpload: Encodable, Equatable {
    var latitude: Double
    var longitude: Double
    var accuracyMeters: Double
    /// Unix milliseconds.
    var capturedAt: Int64

    init(latitude: Double, longitude: Double, accuracyMeters: Double, capturedAt: Int64) {
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
        self.capturedAt = capturedAt
    }

    init(_ fix: LocationFix) {
        self.init(
            latitude: fix.latitude,
            longitude: fix.longitude,
            accuracyMeters: (fix.horizontalAccuracy * 10).rounded() / 10,
            capturedAt: Int64((fix.timestamp.timeIntervalSince1970 * 1000).rounded())
        )
    }
}

enum MobileAPIError: Error, Equatable {
    case pairingInvalid
    case pairingUsed
    case pairingExpired
    /// The phone has not been enrolled through Sauron yet.
    case registrationRequired
    /// The device token is unknown or was revoked; the app must pair again.
    case unauthorized
    /// STOP was sent over iMessage.
    case trackingStopped
    case locationRejected(String)
    case server(status: Int)
    case network(String)
    case invalidResponse
}

protocol MobileAPI {
    func pair(token: String) async throws -> PairResponse
    func pairRegistered(phone: String) async throws -> PairResponse
    func uploadLocation(_ upload: LocationUpload, deviceToken: String) async throws
    func setSharing(_ enabled: Bool, deviceToken: String) async throws -> DeviceState
    func status(deviceToken: String) async throws -> DeviceState
}

/// JSON client for the Photon mobile endpoints. Holds no secrets of its own: the
/// only credential is the per-device bearer token, passed in by the caller.
struct MobileAPIClient: MobileAPI {
    let baseURL: URL
    var session: URLSession = .shared

    func pair(token: String) async throws -> PairResponse {
        let data = try await send("POST", "/api/mobile/pair", body: ["pairingToken": token], deviceToken: nil)
        return try decode(PairResponse.self, data)
    }

    func pairRegistered(phone: String) async throws -> PairResponse {
        let data = try await send("POST", "/api/mobile/pair-registered", body: ["phone": phone], deviceToken: nil)
        return try decode(PairResponse.self, data)
    }

    func uploadLocation(_ upload: LocationUpload, deviceToken: String) async throws {
        _ = try await send("POST", "/api/mobile/location", body: upload, deviceToken: deviceToken)
    }

    func setSharing(_ enabled: Bool, deviceToken: String) async throws -> DeviceState {
        let data = try await send("POST", "/api/mobile/sharing", body: ["enabled": enabled], deviceToken: deviceToken)
        return try decode(DeviceState.self, data)
    }

    func status(deviceToken: String) async throws -> DeviceState {
        let data = try await send("GET", "/api/mobile/status", body: Optional<[String: String]>.none, deviceToken: deviceToken)
        return try decode(DeviceState.self, data)
    }

    private func send<Body: Encodable>(_ method: String, _ path: String, body: Body?, deviceToken: String?) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let deviceToken { request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw MobileAPIError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw MobileAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw Self.error(status: http.statusCode, data: data) }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw MobileAPIError.invalidResponse }
    }

    private struct ErrorBody: Decodable { var error: String?; var message: String? }

    static func error(status: Int, data: Data) -> MobileAPIError {
        let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
        switch body?.error {
        case "pairing_invalid": return .pairingInvalid
        case "pairing_used": return .pairingUsed
        case "pairing_expired": return .pairingExpired
        case "registration_required": return .registrationRequired
        case "device_unauthorized", "token_invalid": return .unauthorized
        case "tracking_stopped": return .trackingStopped
        case "location_invalid": return .locationRejected(body?.message ?? "Location was rejected")
        default: return status == 401 ? .unauthorized : .server(status: status)
        }
    }
}
