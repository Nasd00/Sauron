import XCTest
@testable import SauronLocation

/// Captures requests and returns canned responses.
final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data))?
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var captured = request
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            captured.httpBody = data
        }
        Self.requests.append(captured)
        let (status, body) = Self.handler?(captured) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class MobileAPIClientTests: XCTestCase {
    private var client: MobileAPIClient!

    override func setUp() {
        StubURLProtocol.requests = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        client = MobileAPIClient(baseURL: URL(string: "https://photon.example")!, session: URLSession(configuration: configuration))
    }

    func testLocationUploadSendsBearerTokenAndJsonBody() async throws {
        StubURLProtocol.handler = { _ in (200, Data(#"{"accepted":true}"#.utf8)) }
        let upload = LocationUpload(latitude: 42.2808, longitude: -83.743, accuracyMeters: 37, capturedAt: 1_791_090_000_000)
        try await client.uploadLocation(upload, deviceToken: "dev.token")
        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://photon.example/api/mobile/location")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer dev.token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(json["latitude"] as? Double, 42.2808)
        XCTAssertEqual(json["accuracyMeters"] as? Double, 37)
        XCTAssertEqual((json["capturedAt"] as? NSNumber)?.int64Value, 1_791_090_000_000)
    }

    func testPairDecodesDeviceToken() async throws {
        StubURLProtocol.handler = { _ in
            (201, Data(#"{"deviceToken":"d.t","deviceId":"d","trackingActive":true,"sharingEnabled":false,"lastLocationAt":null}"#.utf8))
        }
        let response = try await client.pair(token: "tok")
        XCTAssertEqual(response, PairResponse(deviceToken: "d.t", deviceId: "d", trackingActive: true, sharingEnabled: false))
        XCTAssertNil(StubURLProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"))
    }

    func testRegisteredPhonePairingUsesTheDirectEndpoint() async throws {
        StubURLProtocol.handler = { _ in
            (201, Data(#"{"deviceToken":"d.t","deviceId":"d","trackingActive":true,"sharingEnabled":false}"#.utf8))
        }
        _ = try await client.pairRegistered(phone: "+15551234567")
        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://photon.example/api/mobile/pair-registered")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
        XCTAssertEqual(json["phone"], "+15551234567")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func testMapsBackendErrorCodes() async {
        let cases: [(Int, String, MobileAPIError)] = [
            (403, #"{"error":"tracking_stopped"}"#, .trackingStopped),
            (401, #"{"error":"device_unauthorized"}"#, .unauthorized),
            (410, #"{"error":"pairing_used"}"#, .pairingUsed),
            (410, #"{"error":"pairing_expired"}"#, .pairingExpired),
            (403, #"{"error":"registration_required"}"#, .registrationRequired),
            (422, #"{"error":"location_invalid","message":"too coarse"}"#, .locationRejected("too coarse")),
            (502, #"{"error":"unavailable"}"#, .server(status: 502)),
            (401, "", .unauthorized),
        ]
        for (status, body, expected) in cases {
            StubURLProtocol.handler = { _ in (status, Data(body.utf8)) }
            do {
                _ = try await client.status(deviceToken: "x")
                XCTFail("expected \(expected)")
            } catch {
                XCTAssertEqual(error as? MobileAPIError, expected)
            }
        }
    }
}
