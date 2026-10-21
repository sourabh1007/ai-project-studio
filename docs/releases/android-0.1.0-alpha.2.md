# Android 0.1.0-alpha.2 - first installable development preview

Chat-first remote development for AI Project Studio, with GitHub checkout on
your trusted host, persisted conversations, **Chat / Changes / Terminal**, and
separate approvals for the plan/local implementation and exact-commit
push/draft-PR publication.

The [initial Android draft scope](android-0.1.0-alpha.1.md) is unchanged.
The alpha.1 pipeline stopped before building or releasing an APK because
Google no longer supplies the legacy Android SDK `tools` package. This build
requests supported platform tools explicitly and uses the current Java setup
action. No previous release or tag was overwritten.

Read [host setup and usage](../mobile-preview.md) before installing. Requires
Android 8.0 or newer with a current WebView, and a PC/server running the exact
source commit in the manifest behind trusted HTTPS, preferably over a private
VPN. Development executes on that host, not locally on Android.

**Internal, development/debug-signed draft prerelease only.** Check the APK's
SHA256 against its manifest. Disposable debug signing may require uninstalling
a prior preview. Not Play-ready or production-qualified; no real-device
usability certification is claimed. Host commands/agents have owner-level
permissions: approval buttons are a workflow, not an operating-system sandbox.
