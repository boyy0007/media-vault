# Media Vault Android app

A full-screen WebView around the Media Vault site, plus multi-file upload picking, downloads saved to
`Downloads/Media Vault/`, and full-screen video. On first launch it asks for the server address - the one shown on
the last page of setup on the PC: `https://{pc}.{tailnet}.ts.net:8443` over Tailscale, or `http://{PC's IP}:8091`
at home. If the server can't be reached it offers "Change address". Older installs that used the address without
`:8443` (which serves the hosted sites) are sent on to `:8443` by the sites server (user agent `MediaVaultApp/`).

Build (JDK 17 + Android SDK; create `local.properties` with `sdk.dir=C\:/path/to/Android/Sdk`):

    set JAVA_HOME=C:\Program Files\Java\jdk-17
    gradlew.bat assembleRelease
    copy app\build\outputs\apk\release\app-release.apk ..\pb_public\downloads\media-vault.apk

Release signing needs your own key: `media-vault.jks` + `keystore.properties` (`storeFile`, `storePassword`,
`keyAlias`, `keyPassword`; both gitignored). Make one with

    keytool -genkeypair -v -keystore media-vault.jks -alias media-vault -keyalg RSA -keysize 2048 -validity 10000

and back both up: updates only install over the existing app if they're signed with the same key. Bump
`versionCode` in `app/build.gradle` for each update.

A built app comes with Media Vault (`pb_public\downloads\media-vault.apk`) and is attached to each GitHub release;
installing and using it: "Android app" in the main `README.md`. After building a new one, copy it there (as above) so
the status window's "Connect a phone" and setup's last page hand out the new version, and attach it to a new release.
