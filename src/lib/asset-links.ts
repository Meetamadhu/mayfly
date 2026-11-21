/**
 * Digital Asset Links (/.well-known/assetlinks.json): proves to Android that the Mayfly APK belongs to this
 * site, so the app opens full screen instead of with a browser bar. Built from two settings:
 *
 *   ANDROID_PACKAGE_NAME      e.g. com.meetamadhu.mayfly (the package id in android/twa-manifest.json)
 *   ANDROID_CERT_SHA256       the signing key's SHA-256 fingerprint, AA:BB:...:FF (several allowed, comma-separated)
 *
 * Both are public: the fingerprint identifies the key without revealing it. Without them the route is a 404.
 */
const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function assetLinks(env: Record<string, string | undefined> = process.env) {
  const packageName = env.ANDROID_PACKAGE_NAME?.trim() ?? "";
  const fingerprints = (env.ANDROID_CERT_SHA256 ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (!PACKAGE.test(packageName) || fingerprints.length === 0 || !fingerprints.every((f) => FINGERPRINT.test(f))) {
    return null;
  }
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: fingerprints },
    },
  ];
}
