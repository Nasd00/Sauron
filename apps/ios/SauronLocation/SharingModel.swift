import Foundation

/// What the single screen shows.
enum DisplayState: Equatable {
    case notPaired
    case confirmPairing(host: String)
    case pairing
    /// STOP was sent over iMessage; uploads are rejected until WATCH ME.
    case stoppedFromMessages
    case needsPermission(PermissionProblem)
    case active
    case off
}

enum PermissionProblem: Equatable {
    /// Location access is off for the app.
    case denied
    /// Only While Using was granted.
    case backgroundRequired
    /// Precise Location is off, so fixes are too coarse (>500 m) to upload.
    case preciseRequired
}

/// Owns pairing, permission, Core Location, and upload decisions. The app's only
/// job is keeping the paired user's location current on the backend.
@MainActor
final class SharingModel: ObservableObject, LocationProviderDelegate {
    @Published private(set) var credential: DeviceCredential?
    @Published private(set) var pendingLink: PairingLink?
    @Published private(set) var isPairing = false
    @Published private(set) var wantsSharing: Bool
    @Published private(set) var trackingActive: Bool
    @Published private(set) var authorization: LocationAuthorization
    @Published private(set) var preciseAllowed: Bool
    @Published private(set) var lastUpload: UploadedLocation?
    @Published private(set) var message: String?

    private let location: LocationProviding
    private let credentials: CredentialStoring
    private let settings: SharingSettings
    private let makeAPI: (URL) -> MobileAPI
    private let defaultAPIBaseURL: URL?
    private let policy: UploadPolicy
    private let now: () -> Date
    private let backgroundTask: (@escaping () async -> Void) async -> Void

    /// Waiting for the user to answer a system permission prompt.
    private var awaitingPrompt = false
    private var forceNextUpload = false
    private var isUploading = false

    init(
        location: LocationProviding,
        credentials: CredentialStoring,
        settings: SharingSettings,
        defaultAPIBaseURL: URL? = MobileAppConfiguration.apiBaseURL,
        makeAPI: @escaping (URL) -> MobileAPI = { MobileAPIClient(baseURL: $0) },
        policy: UploadPolicy = UploadPolicy(),
        now: @escaping () -> Date = Date.init,
        backgroundTask: @escaping (@escaping () async -> Void) async -> Void = { await $0() }
    ) {
        self.location = location
        self.credentials = credentials
        self.settings = settings
        self.defaultAPIBaseURL = defaultAPIBaseURL
        self.makeAPI = makeAPI
        self.policy = policy
        self.now = now
        self.backgroundTask = backgroundTask
        if !settings.installed {
            credentials.delete()
            settings.installed = true
        }
        credential = credentials.load()
        wantsSharing = settings.wantsSharing
        trackingActive = settings.trackingActive
        lastUpload = settings.lastUpload
        authorization = location.authorization
        preciseAllowed = location.preciseAllowed
        location.delegate = self
        // Relaunches (including background relaunch by Core Location) resume sharing.
        if credential != nil, wantsSharing { resumeUpdates() }
    }

    var displayState: DisplayState {
        if isPairing { return .pairing }
        if let pendingLink { return .confirmPairing(host: pendingLink.host) }
        guard credential != nil else { return .notPaired }
        guard trackingActive else { return .stoppedFromMessages }
        guard wantsSharing else { return .off }
        if let problem = permissionProblem { return .needsPermission(problem) }
        return .active
    }

    private var permissionProblem: PermissionProblem? {
        switch authorization {
        case .denied: return .denied
        case .notDetermined: return awaitingPrompt ? nil : .backgroundRequired
        case .whenInUse: return awaitingPrompt || !settings.alwaysRequested ? nil : .backgroundRequired
        case .always: return preciseAllowed ? nil : .preciseRequired
        }
    }

    // MARK: Pairing

    /// Handles a pairing link; the user confirms before the token is redeemed.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let link = PairingLink.parse(url) else {
            message = "That link isn’t a Sauron pairing link."
            return false
        }
        pendingLink = link
        message = nil
        return true
    }

    func cancelPairing() {
        pendingLink = nil
    }

    func confirmPairing() async {
        guard let link = pendingLink, !isPairing else { return }
        isPairing = true
        defer { isPairing = false }
        do {
            let response = try await makeAPI(link.apiBaseURL).pair(token: link.token)
            try await acceptPairing(response, apiBaseURL: link.apiBaseURL)
        } catch let error as MobileAPIError {
            pendingLink = nil
            message = Self.pairingMessage(error)
        } catch {
            pendingLink = nil
            message = "Couldn’t save the pairing on this iPhone. Text WATCH ME for a new link."
        }
    }

    /// Pairs an already enrolled phone directly from the app. The server refuses
    /// unknown or unsubscribed numbers, so registration still happens first.
    func pairRegistered(phone: String) async {
        guard !isPairing else { return }
        guard let apiBaseURL = defaultAPIBaseURL else {
            message = "Sauron’s location service isn’t configured in this build."
            return
        }
        let phone = Self.normalizedPhone(phone)
        guard Self.isE164(phone) else {
            message = "Enter a valid phone number, including the country code."
            return
        }
        isPairing = true
        message = nil
        defer { isPairing = false }
        do {
            let response = try await makeAPI(apiBaseURL).pairRegistered(phone: phone)
            try await acceptPairing(response, apiBaseURL: apiBaseURL)
        } catch MobileAPIError.registrationRequired {
            message = "This phone isn’t registered with Sauron yet. Register it first, then try again."
        } catch let error as MobileAPIError {
            message = Self.pairingMessage(error)
        } catch {
            message = "Couldn’t pair this iPhone. Check your connection and try again."
        }
    }

    static func normalizedPhone(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = trimmed.filter(\.isNumber)
        if trimmed.hasPrefix("+") { return "+\(digits)" }
        if digits.count == 10 { return "+1\(digits)" }
        if digits.count == 11, digits.hasPrefix("1") { return "+\(digits)" }
        return trimmed
    }

    private static func isE164(_ phone: String) -> Bool {
        guard phone.first == "+" else { return false }
        let digits = phone.dropFirst()
        return (7...15).contains(digits.count) && digits.first != "0" && digits.allSatisfy(\.isNumber)
    }

    private func acceptPairing(_ response: PairResponse, apiBaseURL: URL) async throws {
        let newCredential = DeviceCredential(
            deviceId: response.deviceId, deviceToken: response.deviceToken, apiBaseURL: apiBaseURL
        )
        try credentials.save(newCredential)
        // A new pairing starts clean and replaces any prior device association.
        location.stopUpdates()
        settings.reset()
        credential = newCredential
        lastUpload = nil
        setTrackingActive(response.trackingActive)
        pendingLink = nil
        message = nil
        await startSharing()
    }

    static func pairingMessage(_ error: MobileAPIError) -> String {
        switch error {
        case .pairingUsed: return "That pairing link was already used. Text PAIR to Sauron for a new one."
        case .pairingExpired: return "That pairing link expired. Text PAIR to Sauron for a new one."
        case .pairingInvalid: return "That pairing link isn’t valid. Text PAIR to Sauron for a new one."
        case .registrationRequired: return "This phone isn’t registered with Sauron yet. Register it first, then try again."
        case .network: return "Couldn’t reach Sauron. Check your connection and open the link again."
        default: return "Pairing failed. Text PAIR to Sauron for a new link."
        }
    }

    // MARK: Sharing

    func startSharing() async {
        guard let credential else { return }
        setWantsSharing(true)
        message = nil
        requestPermissionIfNeeded()
        do {
            let state = try await makeAPI(credential.apiBaseURL).setSharing(true, deviceToken: credential.deviceToken)
            setTrackingActive(state.trackingActive)
        } catch {
            handle(error)
        }
        if trackingActive, self.credential != nil {
            forceNextUpload = true
            location.startUpdates()
        }
    }

    func stopSharing() async {
        setWantsSharing(false)
        location.stopUpdates()
        message = nil
        guard let credential else { return }
        do {
            _ = try await makeAPI(credential.apiBaseURL).setSharing(false, deviceToken: credential.deviceToken)
        } catch {
            handle(error)
        }
    }

    /// Foreground: learn about STOP / WATCH ME and the latest permission state.
    func appDidBecomeActive() async {
        awaitingPrompt = false
        authorization = location.authorization
        preciseAllowed = location.preciseAllowed
        // Continue the When In Use → Always upgrade if the first prompt just finished.
        if credential != nil, wantsSharing { requestPermissionIfNeeded() }
        guard let credential else { return }
        do {
            let state = try await makeAPI(credential.apiBaseURL).status(deviceToken: credential.deviceToken)
            setTrackingActive(state.trackingActive)
        } catch {
            handle(error)
        }
        if wantsSharing, self.credential != nil {
            // Refresh a stationary user's location on open, but not right after an upload.
            if let last = lastUpload?.capturedAt, now().timeIntervalSince(last) < policy.heartbeatInterval {
                forceNextUpload = false
            } else {
                forceNextUpload = true
            }
            resumeUpdates()
        }
    }

    private func requestPermissionIfNeeded() {
        switch location.authorization {
        case .notDetermined:
            awaitingPrompt = true
            location.requestWhenInUse()
        case .whenInUse where !settings.alwaysRequested:
            // iOS shows the Always upgrade prompt once; afterwards only Settings can change it.
            settings.alwaysRequested = true
            awaitingPrompt = true
            location.requestAlways()
        default:
            break
        }
        objectWillChange.send()
    }

    /// Full updates while tracking is allowed; only significant changes after STOP,
    /// so a later WATCH ME is picked up on the next move without opening the app.
    private func resumeUpdates() {
        if trackingActive { location.startUpdates() } else { location.reduceToSignificantChanges() }
    }

    // MARK: LocationProviderDelegate

    func locationProvider(didChangeAuthorization authorization: LocationAuthorization, preciseAllowed: Bool) {
        let previous = self.authorization
        self.authorization = authorization
        self.preciseAllowed = preciseAllowed
        if authorization != .notDetermined { awaitingPrompt = false }
        guard credential != nil, wantsSharing else { return }
        if previous == .notDetermined, authorization == .whenInUse { requestPermissionIfNeeded() }
        if authorization == .whenInUse || authorization == .always { resumeUpdates() }
    }

    func locationProvider(didReceive fixes: [LocationFix]) {
        guard let fix = fixes.max(by: { $0.timestamp < $1.timestamp }) else { return }
        Task { await process(fix) }
    }

    /// Applies the upload policy to a fix and uploads it if accepted.
    func process(_ fix: LocationFix) async {
        guard let credential, wantsSharing, !isUploading else { return }
        let decision = policy.evaluate(fix, lastUploaded: lastUpload, now: now(), force: forceNextUpload)
        guard decision.shouldUpload else { return }
        isUploading = true
        defer { isUploading = false }
        let api = makeAPI(credential.apiBaseURL)
        await backgroundTask { [weak self] in
            do {
                try await api.uploadLocation(LocationUpload(fix), deviceToken: credential.deviceToken)
                self?.recordUpload(fix)
            } catch {
                self?.handle(error)
            }
        }
    }

    private func recordUpload(_ fix: LocationFix) {
        forceNextUpload = false
        let upload = UploadedLocation(
            latitude: fix.latitude, longitude: fix.longitude,
            accuracyMeters: fix.horizontalAccuracy, capturedAt: fix.timestamp
        )
        lastUpload = upload
        settings.lastUpload = upload
        message = nil
        if !trackingActive {
            // Accepted again after WATCH ME: back to full updates.
            setTrackingActive(true)
            location.startUpdates()
        }
    }

    private func handle(_ error: Error) {
        switch error as? MobileAPIError {
        case .trackingStopped:
            setTrackingActive(false)
            if wantsSharing { location.reduceToSignificantChanges() }
        case .unauthorized:
            unpair()
            message = "This iPhone is no longer paired. Pair again here, or text PAIR to Sauron for a reset link."
        case .locationRejected:
            break // Low-quality or out-of-range fix; the next one is evaluated fresh.
        case .network, .server, .invalidResponse:
            message = "Couldn’t reach Sauron. Will retry on the next update."
        default:
            message = "Something went wrong. Will retry on the next update."
        }
    }

    private func unpair() {
        location.stopUpdates()
        credentials.delete()
        settings.reset()
        credential = nil
        wantsSharing = false
        trackingActive = true
        lastUpload = nil
    }

    private func setWantsSharing(_ value: Bool) {
        wantsSharing = value
        settings.wantsSharing = value
    }

    private func setTrackingActive(_ value: Bool) {
        trackingActive = value
        settings.trackingActive = value
    }
}
