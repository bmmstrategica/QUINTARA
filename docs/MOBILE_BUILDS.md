# Building the store apps: quintara.aab and quintara.ipa

The Android app bundle (`.aab`) and the iOS app (`.ipa`) are built in Expo's cloud build service (EAS Build) and
signed with keys that belong to your Google Play and Apple accounts. That is why they are not in the ZIP: a file
signed with someone else's key would be refused by both stores. Building them takes one command once the
accounts are ready.

## What you need, once

| | Cost | Where |
|---|---|---|
| An Expo account | Free plan works (builds queue) | expo.dev/signup |
| An Apple Developer Program membership, as an organisation | US$99 a year | developer.apple.com/programs (needs a D-U-N-S number for a company) |
| A Google Play developer account | US$25, once | play.google.com/console |
| A computer with Node.js 22 or later | | nodejs.org (macOS, Windows or Linux; no Xcode or Android Studio needed) |

In App Store Connect, create the app with the bundle ID `com.quintara.app`. In Google Play Console, create the
app with the package name `com.quintara.app`. Both are set in `apps/mobile/app.json`.

## Build

From the project folder (unzipped):

```
pnpm install
pnpm build:store
```

The script:
1. signs you in to Expo and links the project (the first time only);
2. builds Android and iOS together with the `production` profile in `apps/mobile/eas.json`, pointing at
   `https://api.quintaralifestyle.com`;
3. downloads the results to `builds/quintara.aab` and `builds/quintara.ipa`.

The first time, it asks about credentials. Choose to let Expo:
- **Android:** generate a new upload keystore. Expo keeps it safe, and you can download a copy from expo.dev.
  Google Play holds the app signing key itself (Play App Signing).
- **iOS:** sign in with your Apple ID so Expo can create the distribution certificate and provisioning profile.

Later builds reuse them with no questions. Each build increases the build number automatically.

## Send to the stores

- Upload `quintara.aab` in Google Play Console (start with the Internal testing track), and `quintara.ipa`
  through Transporter or App Store Connect (TestFlight first).
- Or let Expo do it: fill in the Apple IDs in the `submit` section of `apps/mobile/eas.json`, put a Google Play
  service account key at `apps/mobile/google-play-service-account.json` (it is never uploaded or committed),
  then run `npx eas-cli@25 submit --platform all --profile production`.

The store listings, review account and privacy answers are in `docs/RELEASE.md`.

## Test builds

`npx eas-cli@25 build --platform android --profile preview` makes an `.apk` that installs directly on an
Android phone, against the staging server. For iPhones, TestFlight is the way to test.
