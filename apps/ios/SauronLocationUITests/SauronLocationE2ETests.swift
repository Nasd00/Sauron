import CoreLocation
import XCTest

/// Drives the real app on a simulator against a live local backend. Run through
/// `scripts/test-mobile-ios-e2e.ts`, which issues the pairing link (passed as
/// SAURON_PAIR_URL) and checks the database afterwards. Skipped otherwise.
final class SauronLocationE2ETests: XCTestCase {
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    // Ann Arbor, then points ~450 m and ~2.1 km / ~4.2 km north.
    static let start = CLLocation(latitude: 42.2808, longitude: -83.7430)
    static let nearby = CLLocation(latitude: 42.2848, longitude: -83.7430)
    static let foregroundMove = CLLocation(latitude: 42.2998, longitude: -83.7430)
    static let backgroundMove = CLLocation(latitude: 42.3188, longitude: -83.7430)

    func testPairShareMoveRelaunchAndBackground() throws {
        guard let raw = ProcessInfo.processInfo.environment["SAURON_PAIR_URL"], let pairURL = URL(string: raw) else {
            throw XCTSkip("SAURON_PAIR_URL not set; run scripts/test-mobile-ios-e2e.ts")
        }
        XCUIDevice.shared.location = XCUILocation(location: Self.start)
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Not paired"].waitForExistence(timeout: 10))

        // Pairing link from iMessage opens the app; the user confirms.
        app.open(pairURL)
        let pair = app.buttons["Pair This iPhone"]
        XCTAssertTrue(pair.waitForExistence(timeout: 10))
        pair.tap()

        // When In Use first, then the Always upgrade.
        tapSystemButton(["Allow While Using App", "Allow While Using the App"])
        tapSystemButton(["Change to Always Allow", "Always Allow"])
        XCTAssertTrue(app.staticTexts["Active"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["37 m"].exists || app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ' m'")).count > 0
                      || app.staticTexts["Waiting for location…"].exists)
        XCTAssertTrue(app.staticTexts["Just now"].waitForExistence(timeout: 15), "first location uploaded")
        mark("first-upload")

        // Under 1 km: no upload. Over 1 km: upload.
        XCUIDevice.shared.location = XCUILocation(location: Self.nearby)
        sleep(6)
        mark("nearby-done")
        XCUIDevice.shared.location = XCUILocation(location: Self.foregroundMove)
        sleep(6)
        mark("foreground-move-done")

        // Restart keeps the pairing and resumes sharing.
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["Active"].waitForExistence(timeout: 10), "pairing survives relaunch")
        XCTAssertFalse(app.staticTexts["Not paired"].exists)
        sleep(3)

        // Background, then move: the upload happens without returning to the foreground.
        XCUIDevice.shared.press(.home)
        sleep(3)
        mark("backgrounded")
        XCUIDevice.shared.location = XCUILocation(location: Self.backgroundMove)
        sleep(12)
        mark("background-move-done")
    }

    /// Accepts a system permission prompt if one appears.
    private func tapSystemButton(_ labels: [String]) {
        for _ in 0..<20 {
            for label in labels {
                let button = springboard.buttons[label]
                if button.exists { button.tap(); return }
            }
            usleep(500_000)
        }
    }

    /// Phase markers the orchestrating script lines up with database updates.
    private func mark(_ phase: String) {
        print("SAURON_E2E_PHASE \(phase) \(Int64(Date().timeIntervalSince1970 * 1000))")
    }
}
