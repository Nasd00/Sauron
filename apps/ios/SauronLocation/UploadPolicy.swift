import CoreLocation
import Foundation

/// A Core Location fix, reduced to what the upload decision needs.
struct LocationFix: Equatable {
    var latitude: Double
    var longitude: Double
    /// Meters; negative means invalid.
    var horizontalAccuracy: Double
    /// Meters per second; negative means unknown.
    var speed: Double
    var timestamp: Date
}

extension LocationFix {
    init(_ location: CLLocation) {
        self.init(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            horizontalAccuracy: location.horizontalAccuracy,
            speed: location.speed,
            timestamp: location.timestamp
        )
    }
}

/// The last location the backend accepted. Persisted across launches.
struct UploadedLocation: Codable, Equatable {
    var latitude: Double
    var longitude: Double
    var accuracyMeters: Double
    var capturedAt: Date
}

/// Movement-based upload rules: send when the user has moved about 1 km from the
/// last uploaded point, or when nothing has been uploaded for 15 minutes while the
/// device is moving. Low-quality and stale fixes are never sent.
struct UploadPolicy {
    var minimumDistanceMeters: Double = 1_000
    var maximumAccuracyMeters: Double = 500
    var heartbeatInterval: TimeInterval = 15 * 60
    /// At or above this speed (m/s, ~3.6 km/h) the device counts as moving.
    var movingSpeed: Double = 1.0
    /// Displacement from the last upload that also counts as moving when speed is unknown.
    var movingDisplacementMeters: Double = 200
    /// Cached fixes older than this are ignored.
    var maximumFixAge: TimeInterval = 5 * 60

    enum Decision: Equatable {
        case upload(UploadReason)
        case skip(SkipReason)

        var shouldUpload: Bool {
            if case .upload = self { return true }
            return false
        }
    }

    enum UploadReason: Equatable { case first, forced, moved, heartbeat }
    enum SkipReason: Equatable { case lowAccuracy, stale, outOfOrder, notMovedEnough }

    /// `force` (sharing just started, or the app came to the foreground) bypasses
    /// the distance/time rules but never the quality checks.
    func evaluate(_ fix: LocationFix, lastUploaded: UploadedLocation?, now: Date, force: Bool = false) -> Decision {
        guard fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= maximumAccuracyMeters else { return .skip(.lowAccuracy) }
        guard now.timeIntervalSince(fix.timestamp) <= maximumFixAge else { return .skip(.stale) }
        guard let last = lastUploaded else { return .upload(.first) }
        guard fix.timestamp > last.capturedAt else { return .skip(.outOfOrder) }
        if force { return .upload(.forced) }

        let distance = Self.distanceMeters(from: last, to: fix)
        if distance >= minimumDistanceMeters { return .upload(.moved) }
        let moving = fix.speed >= movingSpeed || distance >= movingDisplacementMeters
        if moving, fix.timestamp.timeIntervalSince(last.capturedAt) >= heartbeatInterval { return .upload(.heartbeat) }
        return .skip(.notMovedEnough)
    }

    static func distanceMeters(from last: UploadedLocation, to fix: LocationFix) -> Double {
        CLLocation(latitude: last.latitude, longitude: last.longitude)
            .distance(from: CLLocation(latitude: fix.latitude, longitude: fix.longitude))
    }
}
