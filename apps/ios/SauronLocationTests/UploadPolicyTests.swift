import XCTest
@testable import SauronLocation

final class UploadPolicyTests: XCTestCase {
    private let policy = UploadPolicy()
    private let now = Date(timeIntervalSince1970: 1_791_090_000)
    // ~0.009° latitude ≈ 1 km.
    private let origin = UploadedLocation(latitude: 42.2808, longitude: -83.7430, accuracyMeters: 30,
                                          capturedAt: Date(timeIntervalSince1970: 1_791_090_000 - 600))

    private func fix(latitude: Double = 42.2808, accuracy: Double = 37, speed: Double = -1, age: TimeInterval = 0) -> LocationFix {
        LocationFix(latitude: latitude, longitude: -83.7430, horizontalAccuracy: accuracy, speed: speed,
                    timestamp: now.addingTimeInterval(-age))
    }

    func testFirstGoodFixUploads() {
        XCTAssertEqual(policy.evaluate(fix(), lastUploaded: nil, now: now), .upload(.first))
    }

    func testRejectsFixesWorseThan500Meters() {
        XCTAssertEqual(policy.evaluate(fix(accuracy: 501), lastUploaded: nil, now: now), .skip(.lowAccuracy))
        XCTAssertEqual(policy.evaluate(fix(accuracy: -1), lastUploaded: nil, now: now), .skip(.lowAccuracy))
        XCTAssertEqual(policy.evaluate(fix(accuracy: 500), lastUploaded: nil, now: now), .upload(.first))
        XCTAssertEqual(policy.evaluate(fix(accuracy: 900), lastUploaded: nil, now: now, force: true), .skip(.lowAccuracy))
    }

    func testRejectsStaleCachedFixes() {
        XCTAssertEqual(policy.evaluate(fix(age: 6 * 60), lastUploaded: nil, now: now), .skip(.stale))
    }

    func testUploadsAfterMovingAboutOneKilometer() {
        XCTAssertEqual(policy.evaluate(fix(latitude: 42.2808 + 0.0091), lastUploaded: origin, now: now), .upload(.moved))
        XCTAssertEqual(policy.evaluate(fix(latitude: 42.2808 + 0.0085), lastUploaded: origin, now: now), .skip(.notMovedEnough))
    }

    func testHeartbeatAfter15MinutesOnlyWhileMoving() {
        let old = UploadedLocation(latitude: origin.latitude, longitude: origin.longitude, accuracyMeters: 30,
                                   capturedAt: now.addingTimeInterval(-16 * 60))
        XCTAssertEqual(policy.evaluate(fix(speed: 1.5), lastUploaded: old, now: now), .upload(.heartbeat))
        XCTAssertEqual(policy.evaluate(fix(latitude: 42.2808 + 0.003), lastUploaded: old, now: now), .upload(.heartbeat))
        XCTAssertEqual(policy.evaluate(fix(speed: 0), lastUploaded: old, now: now), .skip(.notMovedEnough))
        // Moving, but the last upload was recent.
        XCTAssertEqual(policy.evaluate(fix(speed: 1.5), lastUploaded: origin, now: now), .skip(.notMovedEnough))
    }

    func testForcedUploadSkipsDistanceButNotOrdering() {
        XCTAssertEqual(policy.evaluate(fix(), lastUploaded: origin, now: now, force: true), .upload(.forced))
        let future = UploadedLocation(latitude: 0, longitude: 0, accuracyMeters: 1, capturedAt: now)
        XCTAssertEqual(policy.evaluate(fix(), lastUploaded: future, now: now, force: true), .skip(.outOfOrder))
    }

    func testUploadBodyMatchesTheApiContract() throws {
        let body = LocationUpload(fix(accuracy: 37.04))
        XCTAssertEqual(body.capturedAt, 1_791_090_000_000)
        XCTAssertEqual(body.accuracyMeters, 37.0)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        XCTAssertEqual(Set(json?.keys ?? [:].keys), ["latitude", "longitude", "accuracyMeters", "capturedAt"])
    }
}

final class PairingLinkTests: XCTestCase {
    private let token = String(repeating: "A", count: 42) + "_"

    func testParsesCustomSchemeFromPairingPage() {
        let url = URL(string: "sauron://pair?token=\(token)&api=https%3A%2F%2Fabc.ngrok-free.dev%2F")!
        XCTAssertEqual(PairingLink.parse(url), PairingLink(token: token, apiBaseURL: URL(string: "https://abc.ngrok-free.dev")!))
    }

    func testParsesUniversalLink() {
        let link = PairingLink.parse(URL(string: "https://app.example.com/pair/\(token)")!)
        XCTAssertEqual(link?.token, token)
        XCTAssertEqual(link?.apiBaseURL, URL(string: "https://app.example.com")!)
        XCTAssertEqual(PairingLink.parse(URL(string: "https://app.example.com/base/pair/\(token)")!)?.apiBaseURL,
                       URL(string: "https://app.example.com/base")!)
    }

    func testRejectsInsecureOrMalformedLinks() {
        XCTAssertNil(PairingLink.parse(URL(string: "sauron://pair?token=\(token)&api=http%3A%2F%2Fevil.example")!))
        XCTAssertNil(PairingLink.parse(URL(string: "sauron://pair?token=short&api=https%3A%2F%2Fa.example")!))
        XCTAssertNil(PairingLink.parse(URL(string: "sauron://pair?token=\(token)")!))
        XCTAssertNil(PairingLink.parse(URL(string: "sauron://other?token=\(token)&api=https%3A%2F%2Fa.example")!))
        XCTAssertNil(PairingLink.parse(URL(string: "https://app.example.com/incident/\(token)")!))
        XCTAssertNotNil(PairingLink.parse(URL(string: "sauron://pair?token=\(token)&api=http%3A%2F%2Flocalhost%3A3001")!))
    }
}

final class KeychainCredentialStoreTests: XCTestCase {
    func testRoundTripsAndDeletes() throws {
        let store = KeychainCredentialStore(service: "com.tempmhacks.sauron.tests.\(UUID().uuidString)")
        defer { store.delete() }
        XCTAssertNil(store.load())
        let credential = DeviceCredential(deviceId: "d1", deviceToken: "d1.secret", apiBaseURL: URL(string: "https://a.example")!)
        try store.save(credential)
        XCTAssertEqual(store.load(), credential)
        var updated = credential
        updated.deviceToken = "d1.rotated"
        try store.save(updated)
        XCTAssertEqual(store.load(), updated)
        store.delete()
        XCTAssertNil(store.load())
    }
}
