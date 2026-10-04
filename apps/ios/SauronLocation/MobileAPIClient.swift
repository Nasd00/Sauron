import Foundation

/// Device state reported by the backend.
struct DeviceState: Decodable, Equatable {
    var deviceId: String
    /// False after STOP over iMessage; uploads are rejected until WATCH ME.
    var trackingActive: Bool
    var sharingEnabled: Bool
    /// Active dangers near the paired user's location; nil from older servers.
    var incidents: [NearbyIncident]? = nil
}

/// An active danger near the user: camera-confirmed, or marked on the map by an operator.
struct NearbyIncident: Decodable, Equatable, Identifiable {
    var id: String
    var title: String
    var hazard: String
    /// "operator" or "camera".
    var source: String
    var details: String?
    var latitude: Double
    var longitude: Double
    var distanceKm: Double
    var dangerRadiusKm: Double
    var insideDangerZone: Bool
    /// Compass direction straight away from the danger, e.g. "south".
    var headAway: String
    /// Unix milliseconds.
    var reportedAt: Double
}

/// Reply from the help agent (`POST /api/mobile/assist`).
struct AssistReply: Decodable, Equatable {
    var reply: String
    var incidents: [NearbyIncident]?
}

private struct LocationAccepted: Decodable { var incidents: [NearbyIncident]? }

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
    func uploadLocation(_ upload: LocationUpload, deviceToken: String) async throws
    /// Uploads and returns the dangers near the uploaded location.
    func uploadLocationReportingIncidents(_ upload: LocationUpload, deviceToken: String) async throws -> [NearbyIncident]
    func setSharing(_ enabled: Bool, deviceToken: String) async throws -> DeviceState
    func status(deviceToken: String) async throws -> DeviceState
    /// Asks the help agent; shares the conversation with the user's iMessage thread.
    func assist(_ text: String, deviceToken: String) async throws -> AssistReply
}

extension MobileAPI {
    func uploadLocationReportingIncidents(_ upload: LocationUpload, deviceToken: String) async throws -> [NearbyIncident] {
        try await uploadLocation(upload, deviceToken: deviceToken)
        return []
    }

    func assist(_ text: String, deviceToken: String) async throws -> AssistReply {
        throw MobileAPIError.server(status: 503)
    }
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

    func uploadLocation(_ upload: LocationUpload, deviceToken: String) async throws {
        _ = try await uploadLocationReportingIncidents(upload, deviceToken: deviceToken)
    }

    func uploadLocationReportingIncidents(_ upload: LocationUpload, deviceToken: String) async throws -> [NearbyIncident] {
        let data = try await send("POST", "/api/mobile/location", body: upload, deviceToken: deviceToken)
        // Older servers answer without incidents; that is not an upload failure.
        return (try? JSONDecoder().decode(LocationAccepted.self, from: data))?.incidents ?? []
    }

    func assist(_ text: String, deviceToken: String) async throws -> AssistReply {
        let data = try await send("POST", "/api/mobile/assist", body: ["text": text], deviceToken: deviceToken)
        return try decode(AssistReply.self, data)
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
        case "device_unauthorized", "token_invalid": return .unauthorized
        case "tracking_stopped": return .trackingStopped
        case "location_invalid": return .locationRejected(body?.message ?? "Location was rejected")
        case "rate_limited", "assistant_unavailable": return .server(status: status)
        default: return status == 401 ? .unauthorized : .server(status: status)
        }
    }
}
