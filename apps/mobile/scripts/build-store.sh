#!/usr/bin/env bash
# Builds the store versions of the Quintara app in Expo's cloud and downloads them:
#   builds/quintara.aab  (Android, for Google Play)
#   builds/quintara.ipa  (iOS, for the App Store)
# Run from the repository root:  pnpm build:store
# The first run asks you to sign in to Expo and to Apple, and creates or reuses your signing keys.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/apps/mobile"
OUT="$ROOT/builds"
EAS="npx --yes eas-cli@25"
export EAS_NO_VCS=1   # the project is not a git repository; .easignore at the root says what is left out of the upload

command -v node >/dev/null || { echo "Install Node.js 22 or later first: https://nodejs.org"; exit 1; }
mkdir -p "$OUT"

echo "1. Expo account"
$EAS whoami >/dev/null 2>&1 || $EAS login
grep -q '"projectId"' app.json || $EAS init --non-interactive --force || $EAS init

echo "2. Building Android (.aab) and iOS (.ipa). This takes about 20 to 40 minutes."
echo "   The first time, answer the questions about credentials: let Expo create the Android upload key"
echo "   and sign in with your Apple Developer account so it can create the iOS certificate and profile."
$EAS build --platform all --profile production --wait

echo "3. Downloading"
for platform in android ios; do
  ext=$([ "$platform" = android ] && echo aab || echo ipa)
  url=$($EAS build:list --platform "$platform" --status finished --distribution store --limit 1 --json --non-interactive \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s)[0];process.stdout.write(b&&b.artifacts&&b.artifacts.buildUrl||"")})')
  if [ -z "$url" ]; then echo "   No finished $platform build was found. See https://expo.dev for the build log."; continue; fi
  curl -fL --progress-bar -o "$OUT/quintara.$ext" "$url"
  echo "   $OUT/quintara.$ext"
done

echo "Done. Upload quintara.aab to Google Play Console and quintara.ipa to App Store Connect (or run: $EAS submit --platform all --profile production)."
