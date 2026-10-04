import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSharedLocation } from "../src/location.js";

test("LOC command parses with comma or space separators", () => {
  assert.deepEqual(parseSharedLocation("LOC 42.28,-83.74"), { latitude: 42.28, longitude: -83.74 });
  assert.deepEqual(parseSharedLocation("location 42.28 -83.74"), { latitude: 42.28, longitude: -83.74 });
});

test("bare coordinate pair parses only when it is the whole message", () => {
  assert.deepEqual(parseSharedLocation("42.28, -83.74"), { latitude: 42.28, longitude: -83.74 });
  assert.equal(parseSharedLocation("meet me at 42.28, -83.74 tonight"), undefined);
});

test("Apple/Google Maps URLs parse the coordinate", () => {
  assert.deepEqual(
    parseSharedLocation("https://maps.apple.com/?ll=42.2808,-83.7430&q=Here"),
    { latitude: 42.2808, longitude: -83.743 },
  );
  assert.deepEqual(
    parseSharedLocation("https://www.google.com/maps/@42.2808,-83.7430,15z"),
    { latitude: 42.2808, longitude: -83.743 },
  );
});

test("out-of-bounds and non-location text return undefined", () => {
  assert.equal(parseSharedLocation("LOC 200,-83.74"), undefined);
  assert.equal(parseSharedLocation("WATCH Ann Arbor"), undefined);
  assert.equal(parseSharedLocation(""), undefined);
});

test("native 'Send My Current Location' vCard parses, including escaped commas and folding", async () => {
  const { parseLocationVcard, isVcardAttachment } = await import("../src/location.js");
  const vcard = [
    "BEGIN:VCARD", "VERSION:3.0", "N:;Current Location;;;", "FN:Current Location",
    "item1.URL;type=pref:http://maps.apple.com/?ll=42.280800\\,-83.743000&q=42.280800\\,-83.743000",
    "item1.X-ABLabel:map url", "END:VCARD",
  ].join("\r\n");
  assert.deepEqual(parseLocationVcard(vcard), { latitude: 42.2808, longitude: -83.743 });

  const folded = "BEGIN:VCARD\r\nitem1.URL:http://maps.apple.com/?l\r\n l=42.28,-83.74\r\nEND:VCARD";
  assert.deepEqual(parseLocationVcard(folded), { latitude: 42.28, longitude: -83.74 });

  assert.equal(parseLocationVcard("BEGIN:VCARD\r\nFN:Jane Doe\r\nEND:VCARD"), undefined);
  assert.equal(isVcardAttachment("CL.loc.vcf", undefined), true);
  assert.equal(isVcardAttachment(undefined, "text/x-vcard"), true);
  assert.equal(isVcardAttachment("photo.jpg", "image/jpeg"), false);
});

test("Apple Maps place share link (coordinate=) parses, including encoded commas", () => {
  assert.deepEqual(
    parseSharedLocation("https://maps.apple.com/place?address=1%20Main%20St&coordinate=42.509770,-83.730130&name=My%20Location&map=explore"),
    { latitude: 42.50977, longitude: -83.73013 },
  );
  assert.deepEqual(
    parseSharedLocation("https://maps.apple.com/place?coordinate=42.5%2C-83.7&name=My%20Location"),
    { latitude: 42.5, longitude: -83.7 },
  );
});

test("classifyLocationShare distinguishes current location, places, and unreadable map links", async () => {
  const { classifyLocationShare } = await import("../src/location.js");
  const current = classifyLocationShare("https://maps.apple.com/place?address=1%20Main%20St,%20Brighton&coordinate=42.5,-83.7&name=My%20Location");
  assert.deepEqual(current, {
    kind: "location", location: { latitude: 42.5, longitude: -83.7 }, isCurrentLocation: true, label: "1 Main St",
  });
  const place = classifyLocationShare("https://maps.apple.com/place?coordinate=42.28,-83.74&name=Diag");
  assert.equal(place?.kind === "location" && place.label, "Diag");
  assert.deepEqual(classifyLocationShare("https://maps.app.goo.gl/x1"), { kind: "unreadable", reason: "short_link" });
  assert.deepEqual(classifyLocationShare("https://maps.apple.com/place?name=Diag"), { kind: "unreadable", reason: "no_coordinates" });
  assert.equal(classifyLocationShare("hello"), undefined);
});

test("nativeShareKind recognizes Find My and Maps extension balloons", async () => {
  const { nativeShareKind } = await import("../src/normalize.js");
  assert.equal(nativeShareKind("com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.findmy.FindMyMessagesApp"), "find_my");
  assert.equal(nativeShareKind("com.apple.messages.MSMessageExtensionBalloonPlugin:EQHXZ8M8AV:com.google.Maps.MessagesExtension"), "maps_balloon");
  assert.equal(nativeShareKind("com.apple.messages.SomethingElse"), undefined);
  assert.equal(nativeShareKind(undefined), undefined);
});
