import Foundation
import Security

/// The device association created by pairing. The token is scoped by the backend
/// to location updates for one user and can be revoked server-side.
struct DeviceCredential: Codable, Equatable {
    var deviceId: String
    var deviceToken: String
    var apiBaseURL: URL
}

protocol CredentialStoring {
    func load() -> DeviceCredential?
    func save(_ credential: DeviceCredential) throws
    func delete()
}

struct KeychainError: Error, Equatable { let status: OSStatus }

/// Stores the credential in the Keychain, readable after first unlock so
/// background location uploads work while the phone is locked. Never synced
/// to iCloud and never migrated to another device.
struct KeychainCredentialStore: CredentialStoring {
    var service = "com.tempmhacks.sauron.device"
    var account = "device-credential"

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func load() -> DeviceCredential? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(DeviceCredential.self, from: data)
    }

    func save(_ credential: DeviceCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

/// Non-secret app state persisted across launches.
struct SharingSettings {
    let defaults: UserDefaults

    private enum Key {
        static let wantsSharing = "wantsSharing"
        static let trackingActive = "trackingActive"
        static let alwaysRequested = "alwaysRequested"
        static let lastUpload = "lastUpload"
        static let installed = "installed"
    }

    /// False on the first launch after install. Keychain items survive app deletion,
    /// UserDefaults do not, so this detects a reinstall with a stale credential.
    var installed: Bool {
        get { defaults.bool(forKey: Key.installed) }
        nonmutating set { defaults.set(newValue, forKey: Key.installed) }
    }

    /// The in-app Start/Stop Sharing choice.
    var wantsSharing: Bool {
        get { defaults.bool(forKey: Key.wantsSharing) }
        nonmutating set { defaults.set(newValue, forKey: Key.wantsSharing) }
    }

    /// Last known messaging-channel consent (false after STOP).
    var trackingActive: Bool {
        get { defaults.object(forKey: Key.trackingActive) as? Bool ?? true }
        nonmutating set { defaults.set(newValue, forKey: Key.trackingActive) }
    }

    /// Whether Always authorization was already requested (iOS only prompts once).
    var alwaysRequested: Bool {
        get { defaults.bool(forKey: Key.alwaysRequested) }
        nonmutating set { defaults.set(newValue, forKey: Key.alwaysRequested) }
    }

    var lastUpload: UploadedLocation? {
        get { defaults.data(forKey: Key.lastUpload).flatMap { try? JSONDecoder().decode(UploadedLocation.self, from: $0) } }
        nonmutating set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: Key.lastUpload) }
    }

    func reset() {
        for key in [Key.wantsSharing, Key.trackingActive, Key.alwaysRequested, Key.lastUpload] {
            defaults.removeObject(forKey: key)
        }
    }
}
