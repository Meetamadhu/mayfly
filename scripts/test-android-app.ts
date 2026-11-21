/**
 * Pieces the Android app relies on: the asset links file and the web app manifest's icon handling.
 * Run with: npx tsx scripts/test-android-app.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { iconUrl } from "../src/lib/app-icons";
import { assetLinks } from "../src/lib/asset-links";

const FP = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, "0")).join(":");
let passed = 0;
const ok = (value: unknown, message: string) => {
  assert.ok(value, message);
  passed += 1;
};

ok(assetLinks({}) === null, "nothing set: no asset links (the route answers 404)");
ok(assetLinks({ ANDROID_PACKAGE_NAME: "com.meetamadhu.mayfly" }) === null, "package without a fingerprint: none");
ok(assetLinks({ ANDROID_CERT_SHA256: FP }) === null, "fingerprint without a package: none");
ok(assetLinks({ ANDROID_PACKAGE_NAME: "mayfly", ANDROID_CERT_SHA256: FP }) === null, "a package name needs a dot");
ok(assetLinks({ ANDROID_PACKAGE_NAME: "com.x.y", ANDROID_CERT_SHA256: "AB:CD" }) === null, "a short fingerprint is refused");
ok(assetLinks({ ANDROID_PACKAGE_NAME: "com.x.y", ANDROID_CERT_SHA256: `${FP}, nonsense` }) === null, "one bad fingerprint refuses all");

const links = assetLinks({ ANDROID_PACKAGE_NAME: " com.meetamadhu.mayfly ", ANDROID_CERT_SHA256: `${FP.toLowerCase()}, ${FP}` });
assert.deepEqual(links, [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "com.meetamadhu.mayfly", sha256_cert_fingerprints: [FP, FP] },
  },
]);
passed += 1;

const dir = mkdtempSync(path.join(tmpdir(), "mayfly-icons-"));
ok(iconUrl("icon512", dir) === null, "a missing icon isn't listed");
writeFileSync(path.join(dir, "icon-512.png"), "png");
ok(iconUrl("icon512", dir) === "/icons/icon-512.png", "an icon that exists is listed");

const twa = JSON.parse(readFileSync(path.join(__dirname, "..", "android", "twa-manifest.json"), "utf8"));
ok(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(twa.packageId), "the app's package name is valid");
for (const key of ["fullScopeUrl", "webManifestUrl", "iconUrl", "maskableIconUrl"]) {
  ok(new URL(twa[key]).host === twa.host, `${key} is on the app's own site`);
}
ok(twa.iconUrl.endsWith("/icons/icon-512.png") && twa.maskableIconUrl.endsWith("/icons/maskable-512.png"), "the app uses the icon names the site serves");
ok(twa.signingKey.alias === "mayfly", "the signing key alias matches the build");

console.log(`${passed} checks passed`);
