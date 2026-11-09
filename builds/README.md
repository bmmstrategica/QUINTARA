# Store builds

`pnpm build:store` puts the two store files here:

- `quintara.aab`: the Android app bundle, for Google Play
- `quintara.ipa`: the iOS app, for the App Store

They are built in Expo's cloud and signed with keys that belong to your accounts, so they are made on your
side rather than shipped in this ZIP. See `docs/MOBILE_BUILDS.md`.
