import Foundation
import UserNotifications

/// Shows a danger alert on the phone. A protocol so tests can record alerts instead.
protocol IncidentNotifying: AnyObject {
    func requestAuthorization()
    func notify(_ incident: NearbyIncident)
}

/// Local notifications for dangers learned from location uploads and status checks. Uploads keep
/// running in the background while sharing is on, so alerts arrive without APNs push.
final class LocalIncidentNotifier: IncidentNotifying {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func notify(_ incident: NearbyIncident) {
        let content = UNMutableNotificationContent()
        content.title = incident.insideDangerZone ? "DANGER: \(incident.title)" : "Danger nearby: \(incident.title)"
        content.body = Self.body(for: incident)
        // Critical sounds need an Apple entitlement; time-sensitive breaks through Focus where allowed.
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.threadIdentifier = "sauron-danger"
        let request = UNNotificationRequest(identifier: "incident-\(incident.id)", content: content, trigger: nil)
        center.add(request)
    }

    static func body(for incident: NearbyIncident) -> String {
        let distance = String(format: "%.1f km", incident.distanceKm)
        let lead = incident.insideDangerZone
            ? "You are inside the danger zone. Head \(incident.headAway) to get out if it is safe."
            : "\(incident.hazard.capitalized) \(distance) away. Avoid the area."
        let details = incident.details.map { text -> String in
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let last = trimmed.last else { return "" }
            return " " + trimmed + (".!?".contains(last) ? "" : ".")
        } ?? ""
        return "\(lead)\(details) Open Sauron to ask how to get out. Call 911 in an emergency."
    }
}
