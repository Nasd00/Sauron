import SwiftUI
import UIKit

/// The single screen: sharing state, last successful update, and one control.
struct ContentView: View {
    @ObservedObject var model: SharingModel
    @Environment(\.openURL) private var openURL
    @State private var phoneNumber = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            Text("Sauron Location")
                .font(.largeTitle.bold())
                .accessibilityAddTraits(.isHeader)

            content

            if let message = model.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Notice: \(message)")
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var content: some View {
        switch model.displayState {
        case .notPaired:
            Field(label: "Location Sharing", value: "Not paired")
            Explanation("Already registered with Sauron? Enter that phone number to pair this iPhone and start syncing your location.")
            TextField("+1 555 123 4567", text: $phoneNumber)
                .textContentType(.telephoneNumber)
                .keyboardType(.phonePad)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(12)
                .background(.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("Registered phone number")
            PrimaryButton("Pair & Start Sharing") {
                Task { await model.pairRegistered(phone: phoneNumber) }
            }
            Explanation("Not registered yet? Register first from a Sauron watch area. For a replacement phone, text PAIR for a reset link.")

        case let .confirmPairing(host):
            Field(label: "Pair this iPhone", value: host)
            Explanation("Sauron will keep your incident watch current using this iPhone’s location.")
            PrimaryButton("Pair This iPhone") { Task { await model.confirmPairing() } }
            Button("Cancel", role: .cancel) { model.cancelPairing() }
                .frame(maxWidth: .infinity)

        case .pairing:
            Field(label: "Location Sharing", value: "Pairing…")
            ProgressView().accessibilityLabel("Pairing")

        case .stoppedFromMessages:
            Field(label: "Location Sharing", value: "Stopped from Messages")
            Explanation("You sent STOP. Text WATCH ME to Sauron to turn live location back on.")

        case let .needsPermission(problem):
            Field(label: "Location Sharing", value: problem.title)
            Explanation(problem.explanation)
            PrimaryButton("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }

        case .active:
            Field(label: "Location Sharing", value: "Active")
            updateDetails
            PrimaryButton("Stop Sharing", role: .destructive) { Task { await model.stopSharing() } }

        case .off:
            Field(label: "Location Sharing", value: "Off")
            updateDetails
            PrimaryButton("Start Sharing") { Task { await model.startSharing() } }
        }
    }

    @ViewBuilder
    private var updateDetails: some View {
        if let upload = model.lastUpload {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Field(label: "Last updated", value: Self.relative(upload.capturedAt, now: context.date))
            }
            Field(label: "Accuracy", value: "\(Int(upload.accuracyMeters.rounded())) m")
        } else {
            Field(label: "Last updated", value: "Waiting for location…")
        }
    }

    static func relative(_ date: Date, now: Date) -> String {
        if now.timeIntervalSince(date) < 60 { return "Just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: now)
    }
}

extension PermissionProblem {
    var title: String {
        switch self {
        case .denied: return "Location access required"
        case .backgroundRequired: return "Background access required"
        case .preciseRequired: return "Precise location required"
        }
    }

    var explanation: String {
        switch self {
        case .denied, .backgroundRequired:
            return "Sauron needs Always Location access to keep your incident watch current when you move."
        case .preciseRequired:
            return "Sauron needs Precise Location to keep your incident watch current when you move."
        }
    }
}

private struct Field: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline).foregroundStyle(.secondary)
            Text(value).font(.title2.weight(.semibold))
        }
        .accessibilityElement(children: .combine)
    }
}

private struct Explanation: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).font(.body).fixedSize(horizontal: false, vertical: true)
    }
}

private struct PrimaryButton: View {
    let title: String
    let role: ButtonRole?
    let action: () -> Void

    init(_ title: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.title = title
        self.role = role
        self.action = action
    }

    var body: some View {
        Button(role: role, action: action) {
            Text(title).font(.headline).frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
    }
}
