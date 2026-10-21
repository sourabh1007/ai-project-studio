# Android development preview

The Android preview is a chat-first **remote companion**, not an Android port of
Node, Git, Electron, or a coding CLI. A trusted PC/server runs AI Project Studio,
your installed AI providers, Git, tests, and builds. The phone presents task chat,
changes, and a real terminal connected to that host. The host must remain awake
and reachable.

This first draft is for one owner and trusted devices. It is not a multi-tenant
service, a Play Store release, or an untrusted-code sandbox.

## Host setup

Use the source commit named in the APK's release manifest, Node 22.5 or newer,
Git, GitHub CLI signed in to the intended account, and at least one working
Studio AI provider. Build the host normally:

```powershell
npm ci
npm run build
gh auth status
```

Generate a strong, separate mobile access key and its SHA256 hash locally.
This is **not** your GitHub token, provider API key, or password:

```powershell
node -e "const c=require('node:crypto');const k=c.randomBytes(32).toString('base64url');console.log('Access key: '+k);console.log('SHA256: '+c.createHash('sha256').update(k).digest('hex'))"
```

Keep the access key in a password manager. Enter it only into the app's sign-in
screen. Do not commit it, put it in a URL, or share it in logs/screenshots. Set
the **hash**, not the key, in the host configuration:

```powershell
$env:CW__mobile__enabled = 'true'
$env:CW__mobile__publicOrigin = 'https://studio.example.com'
$env:CW__mobile__accessKeyHash = '<SHA256 from the previous command>'
$env:CW__mobile__port = '4320'
npm run start --workspace backend
```

Replace the example origin with your real HTTPS hostname, without a path, query,
or credentials. The gateway binds **only** `127.0.0.1:4320`. Keep the ordinary
desktop API loopback-only; the preview rejects an externally bound desktop API.
Do not expose port 4319 or the gateway's plain-HTTP listener to the network.

Place a trusted HTTPS reverse proxy in front of the gateway, preferably reachable
only through a private VPN. It must preserve the configured public `Host` and set
`X-Forwarded-Proto: https`. For example, a Caddy reverse proxy on the same host:

```caddyfile
studio.example.com {
    reverse_proxy 127.0.0.1:4320 {
        header_up Host studio.example.com
        header_up X-Forwarded-Proto https
    }
}
```

Configure DNS, firewall/VPN access, and a certificate Android trusts for that
hostname. A browser on the phone must be able to open
`https://studio.example.com/mobile`. The APK does not bypass invalid certificates,
accept cleartext HTTP, or create a public tunnel for you.

The disabled-by-default `mobile` configuration namespace also owns worker/chat
limits, job/approval/session deadlines, repository import root, and agent context.
By default, approved imports are cloned into hashed subdirectories under
`mobile-repositories` alongside the host's persistence database. Override
`CW__mobile__repositoryRoot` on the host if needed; the phone cannot choose
arbitrary host paths.

## Install and connect

Use Android 8.0 (API 26) or newer with an up-to-date Android System WebView.
Download the APK and its checksum/provenance manifest from the Android draft
prerelease. Verify the APK's SHA256 against the manifest before installing it.
Android may require allowing installation from the browser/file manager you use.

Open the app, enter the HTTPS **origin only**, and connect. Sign in with the
separate access key. The native shell saves only the host origin. Authentication
uses a Secure, HttpOnly, SameSite=Strict host cookie; neither the key nor a GitHub
credential is put in browser storage or URLs.

The preview APK uses development/debug signing, not a production/Play signing
identity. A later build may require uninstalling the previous preview before
installation. Uninstalling clears the app's saved origin/cookie; host-side chats
and repositories remain on the host.

## Development workflow

1. Select an existing host GitHub checkout, or enter `owner/repository` and
   explicitly confirm **Clone on host**. The host looks up the actual default
   branch through GitHub. Existing checkouts are preserved, never overwritten.
2. Start a task in chat. The agent plans in a separate Git worktree. Discuss the
   plan, review any proposed revision, and explicitly accept it.
3. Approve **local implementation** of the exact current plan. This pass commits
   the work and plan document locally; Studio's mobile workflow stops before
   pushing or creating a PR.
4. Review changed files and available test/agent evidence. Request a publication
   preview showing the exact commit, repository URL, source/base branches, and PR
   title/body.
5. Separately approve publication. The host rejects expired or changed approvals,
   a dirty worktree, a changed branch/origin, or a different reviewed commit.
   It pushes the approved SHA, without force-pushing or disabling Git hooks, then
   creates a **draft** PR. Retrying an already-consumed approval does not repeat
   publication. Partial failures check for an existing matching PR.

Use **End terminal** before returning to agent implementation or publication.
The terminal opens only after explicit owner-level consent and uses the task's
worktree, not a shared desktop terminal. It runs the actual host CLI, including
Git, builds, tests, and repository development. Changing tabs or losing the
network detaches the display; it does not kill the CLI process.

**Important:** typed terminal commands and trusted host agents execute with the
host user's permissions. They are not constrained by the Studio publication
buttons. These workflow approvals are not an OS sandbox against malicious
agents, tools, repository instructions, or shell commands. Do not connect this
preview to an untrusted host or grant untrusted people the access key.

## Recovery and limits

Chat messages, accepted proposals, approval audit entries, and publication
consumption state persist on the host. Phone reconnects poll authoritative state
without resending mutations. Host restarts mark unsettled work interrupted;
they do not automatically rerun a plan, implementation, or publication. Inspect
the worktree and GitHub state before explicitly continuing. Initial planning can
be retried from its error card; an existing implementation is not silently reset.

If a checkout request loses its response, refresh the repository list before
retrying. A completed clone can be reused after verification; an incomplete or
conflicting directory is left intact with an explicit error.

The preview bounds concurrent mobile work, chat/audit size, sign-in attempts,
devices, transport buffers, and operation deadlines. It has no offline execution,
push notifications, background Android service, mobile merge button, or automatic
CI/PR-comment management. Published tasks link to GitHub for the subsequent review
and merge. AI statements about tests are not independent test verification; inspect
the evidence or run the commands in the terminal.

Signing out revokes that session and closes its terminal transport. It does not
delete work or stop an already-running CLI. To revoke all mobile sessions, rotate
the access key/hash and restart the host; stop any unwanted host terminals
explicitly.

## Building the APK

The Android-specific workflow builds the exact tagged source, runs the desktop
host's verification gates, and produces the APK plus source-SHA/checksum/signing
metadata. It creates a **draft prerelease**, not a desktop release. Android tags
use `android-v0.1.0-alpha.1`, avoiding the desktop `v*` release trigger.

The shell is under `mobile/android`. CI uses JDK 17, Gradle 8.11.1, Android Gradle
Plugin 8.9.2, and Android SDK/build tools 35. Build locally with those tools using
`gradle -p mobile/android testDebugUnitTest lintDebug assembleDebug`.
Real-device usability, OEM background behavior, and production
signing/Play qualification remain separate release requirements.
