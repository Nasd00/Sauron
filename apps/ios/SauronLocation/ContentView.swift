import SwiftUI
import UIKit

/// The single screen: sharing state, last successful update, and one control.
struct ContentView: View {
    @ObservedObject var model: SharingModel
    @Environment(\.openURL) private var openURL
    @State private var question = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("Sauron Location")
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)

                ForEach(model.incidents) { incident in
                    DangerCard(incident: incident) {
                        question = "How do I get away from the \(incident.title)?"
                        Task { await model.ask(question) }
                    }
                }

                content

                if model.credential != nil {
                    AssistBox(question: $question, reply: model.assistReply, isAsking: model.isAsking) {
                        Task { await model.ask(question) }
                    }
                }

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
    }

    @ViewBuilder
    private var content: some View {
        switch model.displayState {
        case .notPaired:
            Field(label: "Location Sharing", value: "Not paired")
            Explanation("Text WATCH ME to Sauron in Messages, then open the one-time link on this iPhone. For a replacement phone, text PAIR.")

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

/// One active danger: what, how far, and which way is out.
private struct DangerCard: View {
    let incident: NearbyIncident
    let askHowToLeave: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(incident.insideDangerZone ? "YOU ARE IN A DANGER ZONE" : "DANGER NEARBY")
                .font(.caption.weight(.heavy))
                .foregroundStyle(.white.opacity(0.9))
            Text(incident.title).font(.title2.bold()).foregroundStyle(.white)
            Text(summary).font(.body).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
            if let details = incident.details {
                Text(details).font(.callout).foregroundStyle(.white.opacity(0.9))
            }
            HStack {
                Button("How do I get out?", action: askHowToLeave)
                    .buttonStyle(.borderedProminent).tint(.white).foregroundStyle(.red)
                if let call = URL(string: "tel:911") {
                    Link("Call 911", destination: call).buttonStyle(.bordered).tint(.white)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(incident.insideDangerZone ? Color.red : Color.orange, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }

    private var summary: String {
        let distance = String(format: "%.1f km", incident.distanceKm)
        return incident.insideDangerZone
            ? "\(incident.hazard.capitalized). Head \(incident.headAway) to leave the area if it is safe."
            : "\(incident.hazard.capitalized), \(distance) away. Avoid the area; if you need to move, head \(incident.headAway)."
    }
}

/// Ask the help agent, the same one that answers over iMessage.
private struct AssistBox: View {
    @Binding var question: String
    let reply: String?
    let isAsking: Bool
    let send: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Ask for help").font(.subheadline).foregroundStyle(.secondary)
            HStack {
                TextField("e.g. How do I get out safely?", text: $question)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit(send)
                Button(action: send) {
                    if isAsking { ProgressView() } else { Text("Send") }
                }
                .disabled(isAsking || question.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let reply {
                Text(reply).font(.body).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Assistant: \(reply)")
            }
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
