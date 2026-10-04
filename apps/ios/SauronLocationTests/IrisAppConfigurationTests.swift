import XCTest
@testable import SauronLocation

final class IrisAppConfigurationTests: XCTestCase {
    func testEnvironmentOverridesBuildSetting() {
        let url = IrisAppConfiguration.resolve(
            environmentValue: "https://iris.example/app",
            infoPlistValue: "http://127.0.0.1:4173"
        )
        XCTAssertEqual(url, URL(string: "https://iris.example/app"))
    }

    func testRejectsNonWebAndUnexpandedValues() {
        XCTAssertNil(IrisAppConfiguration.resolve(environmentValue: nil, infoPlistValue: "$(IRIS_WEB_APP_URL)"))
        XCTAssertNil(IrisAppConfiguration.resolve(environmentValue: "file:///tmp/iris", infoPlistValue: nil))
    }

    func testFallsBackToInfoPlistValue() {
        let url = IrisAppConfiguration.resolve(
            environmentValue: "  ",
            infoPlistValue: "http://127.0.0.1:4173"
        )
        XCTAssertEqual(url, URL(string: "http://127.0.0.1:4173"))
    }

    func testWebViewOriginNormalizesDefaultPorts() {
        XCTAssertEqual(IrisWebView.origin(of: URL(string: "https://iris.example:443/map")!), "https://iris.example")
        XCTAssertEqual(IrisWebView.origin(of: URL(string: "http://localhost:4173")!), "http://localhost:4173")
    }

    func testMobileAPIRequiresHTTPSExceptForLocalDevelopment() {
        XCTAssertEqual(
            MobileAppConfiguration.resolve(environmentValue: "https://photon.example", infoPlistValue: nil),
            URL(string: "https://photon.example")
        )
        XCTAssertEqual(
            MobileAppConfiguration.resolve(environmentValue: "http://127.0.0.1:3001", infoPlistValue: nil),
            URL(string: "http://127.0.0.1:3001")
        )
        XCTAssertNil(MobileAppConfiguration.resolve(environmentValue: "http://photon.example", infoPlistValue: nil))
    }
}
