import CoreLocation
import Foundation

enum LocationAuthorization: Equatable {
    case notDetermined
    case denied
    case whenInUse
    case always
}

@MainActor
protocol LocationProviderDelegate: AnyObject {
    func locationProvider(didChangeAuthorization authorization: LocationAuthorization, preciseAllowed: Bool)
    func locationProvider(didReceive fixes: [LocationFix])
}

/// Abstraction over Core Location so the sharing logic is testable.
@MainActor
protocol LocationProviding: AnyObject {
    var delegate: LocationProviderDelegate? { get set }
    var authorization: LocationAuthorization { get }
    var preciseAllowed: Bool { get }
    func requestWhenInUse()
    func requestAlways()
    /// Movement-filtered updates plus significant-change monitoring, which also
    /// relaunches the app in the background after it is terminated.
    func startUpdates()
    /// Keeps only significant-change monitoring (low power).
    func reduceToSignificantChanges()
    func stopUpdates()
}

/// Core Location configured for movement, not continuous GPS: ~100 m accuracy,
/// callbacks only after ~250 m of movement, automatic pausing when stationary.
@MainActor
final class CoreLocationProvider: NSObject, LocationProviding, CLLocationManagerDelegate {
    weak var delegate: LocationProviderDelegate?
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 250
        manager.activityType = .other
        manager.pausesLocationUpdatesAutomatically = true
        manager.showsBackgroundLocationIndicator = false
    }

    var authorization: LocationAuthorization {
        switch manager.authorizationStatus {
        case .notDetermined: return .notDetermined
        case .authorizedAlways: return .always
        case .authorizedWhenInUse: return .whenInUse
        default: return .denied
        }
    }

    var preciseAllowed: Bool { manager.accuracyAuthorization == .fullAccuracy }

    func requestWhenInUse() { manager.requestWhenInUseAuthorization() }
    func requestAlways() { manager.requestAlwaysAuthorization() }

    func startUpdates() {
        // Background updates are only valid with the location background mode and authorization.
        if authorization == .always || authorization == .whenInUse {
            manager.allowsBackgroundLocationUpdates = true
        }
        manager.startUpdatingLocation()
        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            manager.startMonitoringSignificantLocationChanges()
        }
    }

    func reduceToSignificantChanges() {
        manager.stopUpdatingLocation()
        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            manager.startMonitoringSignificantLocationChanges()
        }
    }

    func stopUpdates() {
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.allowsBackgroundLocationUpdates = false
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            delegate?.locationProvider(didChangeAuthorization: authorization, preciseAllowed: preciseAllowed)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let fixes = locations.map(LocationFix.init)
        MainActor.assumeIsolated { delegate?.locationProvider(didReceive: fixes) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Transient failures (no fix yet) are expected; the next update retries.
    }
}
