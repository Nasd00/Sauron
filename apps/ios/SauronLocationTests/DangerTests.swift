import XCTest
@testable import SauronLocation

final class RecordingNotifier: IncidentNotifying {
    var authorizationRequests = 0
    var notified: [String] = []
    func requestAuthorization() { authorizationRequests += 1 }
    func notify(_ incident: NearbyIncident) { notified.append(incident.id) }
}

/// Serves dangers from status, uploads, and the help agent.
final class DangerAPI: MobileAPI {
    var incidents: [NearbyIncident] = []
    var assistResult: Result<AssistReply, MobileAPIError> = .success(AssistReply(reply: "Head south now.", incidents: nil))
    var questions: [String] = []

    func pair(token: String) async throws -> PairResponse {
        PairResponse(deviceToken: "dev.token", deviceId: "dev", trackingActive: true, sharingEnabled: false)
    }
    func uploadLocation(_ upload: LocationUpload, deviceToken: String) async throws {}
    func uploadLocationReportingIncidents(_ upload: LocationUpload, deviceToken: String) async throws -> [NearbyIncident] { incidents }
    func setSharing(_ enabled: Bool, deviceToken: String) async throws -> DeviceState {
        DeviceState(deviceId: "dev", trackingActive: true, sharingEnabled: enabled)
    }
    func status(deviceToken: String) async throws -> DeviceState {
        DeviceState(deviceId: "dev", trackingActive: true, sharingEnabled: true, incidents: incidents)
    }
    func assist(_ text: String, deviceToken: String) async throws -> AssistReply {
        questions.append(text)
        return try assistResult.get()
    }
}

@MainActor
final class DangerTests: XCTestCase {
    private let leak = NearbyIncident(
        id: "manual-1", title: "Gas leak", hazard: "gas leak", source: "operator", details: "Leave now",
        latitude: 42.285, longitude: -83.743, distanceKm: 0.4, dangerRadiusKm: 1, insideDangerZone: true,
        headAway: "south", reportedAt: 5
    )

    private func pairedModel(api: DangerAPI, notifier: RecordingNotifier) async -> SharingModel {
        let defaults = UserDefaults(suiteName: "DangerTests.\(UUID().uuidString)")!
        let model = SharingModel(
            location: FakeLocationProvider(), credentials: MemoryCredentialStore(),
            settings: SharingSettings(defaults: defaults), makeAPI: { _ in api }, notifier: notifier
        )
        let token = String(repeating: "b", count: 43)
        model.handle(url: URL(string: "sauron://pair?token=\(token)&api=https%3A%2F%2Fphoton.example")!)
        await model.confirmPairing()
        return model
    }

    func testStatusShowsDangersAndNotifiesOncePerIncident() async {
        let api = DangerAPI()
        let notifier = RecordingNotifier()
        let model = await pairedModel(api: api, notifier: notifier)
        XCTAssertEqual(notifier.authorizationRequests, 1, "asked when sharing starts")
        api.incidents = [leak]
        await model.appDidBecomeActive()
        await model.appDidBecomeActive()
        XCTAssertEqual(model.incidents, [leak])
        XCTAssertEqual(notifier.notified, ["manual-1"])
        api.incidents = []
        await model.appDidBecomeActive()
        XCTAssertEqual(model.incidents, [], "a resolved danger disappears")
    }

    func testAskingTheAssistantShowsItsReplyAndExplainsFailures() async {
        let api = DangerAPI()
        let model = await pairedModel(api: api, notifier: RecordingNotifier())
        await model.ask("  how do I get out?  ")
        XCTAssertEqual(api.questions, ["how do I get out?"])
        XCTAssertEqual(model.assistReply, "Head south now.")
        api.assistResult = .failure(.server(status: 429))
        await model.ask("again")
        XCTAssertEqual(model.assistReply, "Too many messages right now. If you are in danger, call 911.")
        await model.ask("   ")
        XCTAssertEqual(api.questions.count, 2, "blank questions are not sent")
    }

    func testNotificationBodyLeadsWithTheWayOut() {
        XCTAssertEqual(
            LocalIncidentNotifier.body(for: leak),
            "You are inside the danger zone. Head south to get out if it is safe. Leave now. Open Sauron to ask how to get out. Call 911 in an emergency."
        )
    }

    func testDecodesIncidentsAndToleratesOlderServers() throws {
        let json = #"{"deviceId":"dev","trackingActive":true,"sharingEnabled":true,"incidents":[{"id":"manual-1","title":"Gas leak","hazard":"gas leak","source":"operator","details":"Leave now","latitude":42.285,"longitude":-83.743,"distanceKm":0.4,"dangerRadiusKm":1,"insideDangerZone":true,"headAway":"south","reportedAt":5}]}"#
        let state = try JSONDecoder().decode(DeviceState.self, from: Data(json.utf8))
        XCTAssertEqual(state.incidents, [leak])
        let old = try JSONDecoder().decode(DeviceState.self, from: Data(#"{"deviceId":"dev","trackingActive":true,"sharingEnabled":true}"#.utf8))
        XCTAssertNil(old.incidents)
    }
}
