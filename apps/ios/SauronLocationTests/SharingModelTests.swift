import XCTest
@testable import SauronLocation

@MainActor
final class FakeLocationProvider: LocationProviding {
    weak var delegate: LocationProviderDelegate?
    var authorization: LocationAuthorization = .notDetermined
    var preciseAllowed = true
    var calls: [String] = []

    func requestWhenInUse() { calls.append("whenInUse") }
    func requestAlways() { calls.append("always") }
    func startUpdates() { calls.append("start") }
    func reduceToSignificantChanges() { calls.append("significant") }
    func stopUpdates() { calls.append("stop") }

    func grant(_ value: LocationAuthorization) {
        authorization = value
        delegate?.locationProvider(didChangeAuthorization: value, preciseAllowed: preciseAllowed)
    }
}

final class FakeAPI: MobileAPI {
    var pairResult: Result<PairResponse, MobileAPIError> = .success(
        PairResponse(deviceToken: "dev.token", deviceId: "dev", trackingActive: true, sharingEnabled: false)
    )
    var uploadError: MobileAPIError?
    var trackingActive = true
    var uploads: [LocationUpload] = []
    var sharing: [Bool] = []
    var registeredPhones: [String] = []

    func pair(token: String) async throws -> PairResponse { try pairResult.get() }
    func pairRegistered(phone: String) async throws -> PairResponse {
        registeredPhones.append(phone)
        return try pairResult.get()
    }

    func uploadLocation(_ upload: LocationUpload, deviceToken: String) async throws {
        if let uploadError { throw uploadError }
        uploads.append(upload)
    }

    func setSharing(_ enabled: Bool, deviceToken: String) async throws -> DeviceState {
        sharing.append(enabled)
        if enabled, !trackingActive { throw MobileAPIError.trackingStopped }
        return DeviceState(deviceId: "dev", trackingActive: trackingActive, sharingEnabled: enabled)
    }

    func status(deviceToken: String) async throws -> DeviceState {
        DeviceState(deviceId: "dev", trackingActive: trackingActive, sharingEnabled: true)
    }
}

final class MemoryCredentialStore: CredentialStoring {
    var credential: DeviceCredential?
    func load() -> DeviceCredential? { credential }
    func save(_ credential: DeviceCredential) throws { self.credential = credential }
    func delete() { credential = nil }
}

@MainActor
final class SharingModelTests: XCTestCase {
    private let token = String(repeating: "b", count: 43)
    private let now = Date(timeIntervalSince1970: 1_791_090_000)
    private var provider: FakeLocationProvider!
    private var api: FakeAPI!
    private var credentials: MemoryCredentialStore!
    private var defaults: UserDefaults!
    private var baseURLs: [URL] = []

    override func setUp() async throws {
        provider = FakeLocationProvider()
        api = FakeAPI()
        credentials = MemoryCredentialStore()
        defaults = UserDefaults(suiteName: "SharingModelTests.\(UUID().uuidString)")!
        baseURLs = []
    }

    private func makeModel() -> SharingModel {
        SharingModel(
            location: provider, credentials: credentials, settings: SharingSettings(defaults: defaults),
            defaultAPIBaseURL: URL(string: "https://photon.example")!,
            makeAPI: { [unowned self] url in baseURLs.append(url); return api! }, now: { [now] in now }
        )
    }

    private func fix(latitude: Double = 42.2808, accuracy: Double = 37, secondsAgo: TimeInterval = 1) -> LocationFix {
        LocationFix(latitude: latitude, longitude: -83.743, horizontalAccuracy: accuracy, speed: -1,
                    timestamp: now.addingTimeInterval(-secondsAgo))
    }

    private func pairedModel() async -> SharingModel {
        let model = makeModel()
        model.handle(url: URL(string: "sauron://pair?token=\(token)&api=https%3A%2F%2Fphoton.example")!)
        await model.confirmPairing()
        return model
    }

    func testPairingLinkRequiresConfirmationThenStoresCredentialAndAsksWhenInUseFirst() async {
        let model = makeModel()
        XCTAssertEqual(model.displayState, .notPaired)
        model.handle(url: URL(string: "sauron://pair?token=\(token)&api=https%3A%2F%2Fphoton.example")!)
        XCTAssertEqual(model.displayState, .confirmPairing(host: "photon.example"))
        XCTAssertNil(credentials.credential, "the token is not redeemed until confirmed")

        await model.confirmPairing()
        XCTAssertEqual(credentials.credential?.deviceToken, "dev.token")
        XCTAssertEqual(credentials.credential?.apiBaseURL, URL(string: "https://photon.example")!)
        XCTAssertEqual(baseURLs.first, URL(string: "https://photon.example")!)
        XCTAssertEqual(provider.calls.filter { $0 != "stop" }, ["whenInUse", "start"])
        XCTAssertEqual(api.sharing, [true])

        // When In Use granted → Always is requested next.
        provider.grant(.whenInUse)
        XCTAssertEqual(provider.calls.filter { $0 == "always" }.count, 1)
        provider.grant(.always)
        XCTAssertEqual(model.displayState, .active)
    }

    func testRegisteredUserPairsAndStartsLocationWithoutAMessageLink() async {
        let model = makeModel()
        await model.pairRegistered(phone: "(555) 123-4567")

        XCTAssertEqual(api.registeredPhones, ["+15551234567"])
        XCTAssertEqual(credentials.credential?.deviceToken, "dev.token")
        XCTAssertEqual(credentials.credential?.apiBaseURL, URL(string: "https://photon.example"))
        XCTAssertTrue(model.wantsSharing)
        XCTAssertEqual(api.sharing, [true])
        XCTAssertEqual(provider.calls.filter { $0 != "stop" }, ["whenInUse", "start"])

        provider.grant(.always)
        await model.process(fix())
        XCTAssertEqual(api.uploads.count, 1, "direct pairing must enable the normal location upload path")
    }

    func testUnregisteredUserMustRegisterBeforeDirectPairing() async {
        api.pairResult = .failure(.registrationRequired)
        let model = makeModel()
        await model.pairRegistered(phone: "+15551234567")

        XCTAssertEqual(model.displayState, .notPaired)
        XCTAssertNil(credentials.credential)
        XCTAssertEqual(model.message, "This phone isn’t registered with Sauron yet. Register it first, then try again.")
    }

    func testDirectPairingValidatesAndNormalizesPhoneNumbers() async {
        XCTAssertEqual(SharingModel.normalizedPhone("+44 7700 900123"), "+447700900123")
        XCTAssertEqual(SharingModel.normalizedPhone("1-555-123-4567"), "+15551234567")
        let model = makeModel()
        await model.pairRegistered(phone: "not a phone")
        XCTAssertTrue(api.registeredPhones.isEmpty)
        XCTAssertEqual(model.message, "Enter a valid phone number, including the country code.")
    }

    func testDecliningAlwaysShowsTheBackgroundAccessState() async {
        let model = await pairedModel()
        provider.grant(.whenInUse)
        await model.appDidBecomeActive() // Always prompt dismissed with "Keep Only While Using".
        XCTAssertEqual(model.displayState, .needsPermission(.backgroundRequired))
        provider.authorization = .denied
        await model.appDidBecomeActive()
        XCTAssertEqual(model.displayState, .needsPermission(.denied))
        provider.authorization = .always
        provider.preciseAllowed = false
        await model.appDidBecomeActive()
        XCTAssertEqual(model.displayState, .needsPermission(.preciseRequired))
    }

    func testUploadsOnlyAfterMovingAboutOneKilometer() async {
        let model = await pairedModel()
        provider.grant(.always)
        await model.process(fix())
        XCTAssertEqual(api.uploads.count, 1, "first fix after sharing starts is uploaded")
        // Returning to the foreground right after an upload must not force another one.
        await model.appDidBecomeActive()
        await model.process(fix(latitude: 42.2808 + 0.004, secondsAgo: 0.5))
        XCTAssertEqual(api.uploads.count, 1, "~450 m is not enough")
        await model.process(fix(latitude: 42.2808 + 0.0095, secondsAgo: 0.2))
        XCTAssertEqual(api.uploads.count, 2)
        XCTAssertEqual(api.uploads.last?.latitude, 42.2808 + 0.0095)
        XCTAssertEqual(model.lastUpload?.accuracyMeters, 37)
        await model.process(fix(latitude: 43, accuracy: 800, secondsAgo: 0.1))
        XCTAssertEqual(api.uploads.count, 2, "coarse fixes are ignored")
    }

    func testStopFromMessagesStopsUploadsUntilWatchMe() async {
        let model = await pairedModel()
        provider.grant(.always)
        await model.process(fix())
        api.uploadError = .trackingStopped
        await model.process(fix(latitude: 42.30, secondsAgo: 0.5))
        XCTAssertEqual(model.displayState, .stoppedFromMessages)
        XCTAssertEqual(provider.calls.last, "significant")

        // WATCH ME re-enables tracking server-side; the next accepted move resumes full updates.
        api.uploadError = nil
        await model.process(fix(latitude: 42.31, secondsAgo: 0.2))
        XCTAssertEqual(model.displayState, .active)
        XCTAssertEqual(provider.calls.last, "start")
    }

    func testStopSharingInAppStopsLocationAndTellsBackend() async {
        let model = await pairedModel()
        provider.grant(.always)
        await model.stopSharing()
        XCTAssertEqual(model.displayState, .off)
        XCTAssertEqual(provider.calls.last, "stop")
        XCTAssertEqual(api.sharing, [true, false])
        await model.process(fix(latitude: 45))
        XCTAssertTrue(api.uploads.isEmpty)
    }

    func testRestartPreservesTheDeviceAssociation() async {
        let model = await pairedModel()
        provider.grant(.always)
        await model.process(fix())
        provider.calls = []
        let relaunched = makeModel()
        XCTAssertEqual(relaunched.displayState, .active)
        XCTAssertEqual(relaunched.lastUpload, model.lastUpload)
        XCTAssertEqual(provider.calls, ["start"], "a relaunch resumes updates without pairing again")
    }

    func testReinstallDiscardsAKeychainCredentialLeftFromAPreviousInstall() {
        credentials.credential = DeviceCredential(deviceId: "old", deviceToken: "old.token", apiBaseURL: URL(string: "https://a.example")!)
        let model = makeModel()
        XCTAssertEqual(model.displayState, .notPaired)
        XCTAssertNil(credentials.credential)
    }

    func testRevokedDeviceReturnsToUnpaired() async {
        let model = await pairedModel()
        provider.grant(.always)
        api.uploadError = .unauthorized
        await model.process(fix())
        XCTAssertEqual(model.displayState, .notPaired)
        XCTAssertNil(credentials.credential)
    }

    func testUsedPairingLinkExplainsHowToGetANewOne() async {
        api.pairResult = .failure(.pairingUsed)
        let model = await pairedModel()
        XCTAssertEqual(model.displayState, .notPaired)
        XCTAssertEqual(model.message, SharingModel.pairingMessage(.pairingUsed))
    }
}
