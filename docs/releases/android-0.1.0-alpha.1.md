# Android 0.1.0-alpha.1 - first development draft

An owner-only Android companion for AI Project Studio with a chat-first layout
and **Chat / Changes / Terminal** task views. Git, AI coding CLIs, builds, and
tests execute on your trusted PC/server, not on Android.

## Included

- HTTPS host connection and separate access-key sign-in with revocable secure
  host cookies. The native shell has no JavaScript-to-native bridge.
- Existing host GitHub repositories and explicitly confirmed remote repository
  checkout, with the actual GitHub default branch and non-destructive recovery.
- Persisted task chats, proposed plan revisions, separate plan/implementation
  approval, and local implementation in isolated worktrees.
- Changed-file review and separate publication approval tied to the reviewed
  commit, repository destination, source/base branches, and draft PR contents.
  Dirty or changed work invalidates approval; consumed requests are not replayed.
- A genuine, explicitly authorized host terminal with reconnect and mobile
  controls. End it before agent implementation/publication.
- Authoritative status polling and interrupted-operation recovery without
  automatically resending user actions after reconnect or host restart.

## Required setup and limitations

Read [the mobile setup guide](../mobile-preview.md) before installation.
The host requires this release's source commit, installed/signed-in development
tools, and a trusted HTTPS reverse proxy, preferably accessible only over a
private VPN. Mobile access is disabled by default; the APK does not provision a
host or bundle a coding CLI.

This is a **development/debug-signed, internal draft prerelease**, not a Play
Store or production-qualified release. Verify the downloaded APK against the
published checksum/provenance manifest. Later builds can require reinstalling
because the development signing identity is disposable.

Workflow approvals are not an operating-system sandbox. Host agents and commands
you enter in the terminal retain host-user permissions. Use only trusted devices,
tools, and repositories. No on-device/offline development, push notifications,
automatic merging, CI management, or mobile PR-comment publication is included.

The APK is a first draft; no real Android-device usability certification or
production security qualification is claimed.
