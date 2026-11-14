# fil3shareica

A responsive website for private file transfers and chat between phones and computers. Create a two-device or group session, join through its QR code or invitation link, approve participants, and send multiple files in either direction.

The current local implementation also includes account/access pages, prepaid checkout plumbing, labelled development payments/ads, device registration and signed peer access. Read [the implementation and launch guide](../docs/MARKET_IMPLEMENTATION.md) for current rules and external activation requirements. Older research documents are historical proposals, and the live hosted website is unchanged until deployed separately.

## Run locally

Requires Node.js 22.13 or newer and npm.

```sh
npm ci
npm run setup:local
npm run db:migrate:local
npm run dev
```

Open the URL printed by the server, normally `http://localhost:5173`. To test on one computer, use independent browser profiles/contexts. Create a session, open its invitation in the other profile and approve the guest. A Standard sender completes one labelled test ad per Send batch, including its files and group recipients. Receiving, accepting, chatting and saving require no ad. Prepare one send credit in advance or use development sign-in/checkout to test Premium. Both sides can send and receive at the same time. Local test advertisements generate no revenue and development checkout collects no money.

For a production-build preview (including offline paid-lease support), run `npm run build` then `npm start -- --port 5180`. The start script reads the ignored local settings without putting secret values in command arguments or in the build. The production preview still uses local simulated accounts/payments when loopback development mode is explicitly enabled.

Switching back to development removes only this app’s production service worker and shell caches. Refresh once if a previous production preview appears unstyled; account identity, settings and send credits are preserved. Production caching validates stylesheet/script MIME types and excludes Vite development modules.

For a phone, use the deployed **HTTPS** URL. `localhost` on a phone means the phone itself. An ordinary HTTP LAN address does not provide the secure browser APIs this application needs. Self-hosted phone access needs a trusted HTTPS origin and a reachable server; two devices on the same network can then use a direct WebRTC payload path.

## Transfer behavior

- Select multiple files or drag them into the page. Choose **a folder** or drop a directory to prepare a ZIP64 archive with a unique root, nested paths, Unicode names, and empty folders. The receiver gets the ZIP as a file and extracts it locally. No file-type filter excludes apps or game installers; receiving never installs them. Incoming batches require acceptance.
- Browser folder preparation uses pinned `@zip.js/zip.js` 2.24.0 in STORE mode, streamed ZIP64 output and temporary local browser storage, with at most 10,000 entries and 64 directory levels. Preparation checks capacity, supports cancellation and cleans up staged archives. Unsupported browsers explain how to pre-archive with a file manager. Ordinary selected files remain disk-backed File references. See the [large-file qualification record](../docs/LARGE_FILE_QUALIFICATION.md) before enabling any 100 GB marketing claim.
- Sessions use a compact `/<six-character-code>` address; the display name stays inside the page. The copied invitation and QR also include a private key, so the code alone cannot grant access. Historical `/s/name-code` invitations remain supported. **Scan QR code** appears under **Join a session** and opens a rear-camera reader on supported phones.
- Choose **A group** to invite up to seven other devices. The host approves each participant. Everyone can send files to **All participants** or one selected person; each recipient separately accepts files and gets its own transfer progress. Guest **Leave session** affects only that participant. Host **End session** invalidates the invitation and closes every group connection.
- **Session chat** sends messages directly over encrypted peer channels, either privately or to all participants. Messages remain in the current page's memory and disappear on refresh; the server does not retain chat contents. The sender label means the message was sent from that device, not that every recipient read it.
- Approved pairings survive refresh in the same tab. Interrupted, selected, or unsaved files must be sent again. An explicit Leave/End session ends the pairing; sparse coordinator heartbeats keep the signaling lease alive. If both devices lose signaling for over 30 minutes, refresh recovery can expire, while a healthy local file connection continues. Closing a tab clears its local pairing credentials.
- File bytes use encrypted WebRTC data channels. The server routes short-lived, encrypted pairing signals and does not upload or store file contents.
- Transfer progress and useful speed come from real transfer events, not simulated timers.
- Direct-only mode excludes internet relays. Automatic mode can use TURN when configured.
- On supported browsers, choose a destination folder or save a single incoming large file directly to disk before accepting. Browsers without direct saving use a verified download fallback limited to **64 MiB total pending and unsaved downloads in the tab**, across all senders. The application target is **100,000,000,000 bytes per file**, up to 500 files per batch; it is independent of Standard/Premium. Browser capability, storage and qualification requirements still apply. The public 100 GB claim remains disabled until a real transfer and physical-device qualification pass.
- Optional hello capabilities advertise receiver limits, direct saving modes, selected destination, ZIP64 delivery and browser/native platform. Older hello messages remain accepted; the receiver enforces its limits before acceptance. Group UI reports each receiver independently.
- Modern peers share a 32 MiB receive-window pool across the group, with at most two active 4 MiB windows per peer. Excess accepted files wait with zero credit. Disk writes and incremental hashing are awaited; raw queued frames have a separate bounded pool with header allowance. Browser/native network buffers are outside those application budgets.
- Temporary outages while both pages remain open retain receiving writers and hash state. Peers negotiate checkpoints; a replacement transport resumes from the last written offset, re-reading the sender's prefix in bounded chunks if needed. Verified receipts and final digests can be replayed without another Send operation. Refresh or browser closure still requires sending interrupted files again.
- Native companion help does not require an installation or advertise unpublished installers/APKs. Browser and native connections are compatible only when they implement the same protocol.
- Received downloads also offer **Save as…**: a native file picker on supported desktop browsers, or the system file share sheet when available on phones. A share sheet does not confirm the final save destination.
- Free transfers share 65% of a measured actual-payload reference; paid **Maximum speed** removes that tier limit for a pair if either endpoint has verified paid access. Send authorization belongs only to the sender and is separate from paid speed eligibility. The optional user bandwidth cap remains effective in every tier. **Retest next transfer** measures the next real accepted payload; short files can finish before calibration. Screen wake is requested when supported. The browser cannot reserve Wi-Fi bandwidth, disable other applications or guarantee a fixed rate.
- One immutable Send operation covers all selected files/folders and recipients. A prepared credit is reserved, then spent only after the first verified file; completely rejected/failed batches release it. Retries reuse their original operation. Offline successful batches without a credit are journaled in IndexedDB; reconnect alone never opens an ad. Local tests exercise explicit catch-up, while production compulsory advertising remains disabled pending an approved compatible provider. No inventory allows the current send free and preserves older offline counts.
- Group fanout uses one shared sender scheduler for the free pool and total user bandwidth cap, with per-file fairness and receiver backpressure. Unsaved received files share a 64 MiB memory budget across the group. Supported destination folders stream to disk. Concurrent files with the same name get distinct destination names.
- Keep both pages open. A phone locking, switching apps, or losing its browser process can interrupt the transfer. Browser download handoff is distinguished from a confirmed direct save.
- The Bluetooth control explains the browser limitation: general browser-to-browser Bluetooth file sharing needs native support. Local file traffic can use Wi-Fi or a hotspot without internet, but loading the website, initial pairing, and refresh recovery need the signaling server.

## Release and ownership records

- [Large-file qualification and device matrix](../docs/LARGE_FILE_QUALIFICATION.md): tests required before publishing a 100 GB support claim.
- [IP ownership and filing preparation](../docs/IPR_AND_LAUNCH_REVIEW.md): owner/contributor review, trademark clearance and copyright filing steps; no legal clearance or filing is implied.
- Public branding is `fil3shareica`; the speed benefit is **Maximum speed**. Existing protocol, entitlement and browser-storage keys deliberately retain compatibility identifiers. The intended domain is `fil3shareica.com`; buying it, changing DNS and publishing are separate actions.

## Internet relay configuration

Direct connections and public STUN work without a TURN account. Some mobile, company, and restrictive networks require a TURN relay. The application reports whether a relay is configured instead of claiming universal internet connectivity.

Set runtime secrets in your deployment environment. For local testing, create an ignored `.dev.vars` file. Choose **one** option:

```dotenv
ICE_SERVERS_JSON='[{"urls":"turns:your-relay.example:443?transport=tcp","username":"temporary-user","credential":"temporary-secret"}]'
```

Or let the server generate short-lived Cloudflare TURN credentials:

```dotenv
CLOUDFLARE_TURN_KEY_ID=your-turn-key-id
CLOUDFLARE_TURN_API_TOKEN=your-turn-key-api-token
```

Keep management credentials server-side. Do not put them in browser code, source control, invitation links, or screenshots. Provider bandwidth allowances and charges apply. No paid service is provisioned automatically.

## Checks

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
```

The end-to-end suite requires a running development server and Google Chrome. Set `PLAYWRIGHT_BASE_URL` to test a different local URL. The suite pairs independent browser contexts and verifies real transferred file contents, as well as mobile layout and failure cases.

## Project layout

- `app/`: responsive pages and session API routes.
- `components/`: file, pairing, transfer, and settings interfaces.
- `hooks/use-share.ts` and `lib/client/`: browser signaling, file protocol, encryption, and integrity.
- `lib/server/` and `db/`: bounded session/group admission, authentication, and D1 signaling storage. Short-lived group metadata includes per-pair connection credentials scoped to the two approved endpoints; files and chat contents stay off the server.
- `drizzle/`: schema migrations; `scripts/migrate-local.mjs` applies them only to the local preview database.
- `tests/`: server/protocol tests and independent-browser transfer checks.

The Sites manifest declares the `DB` binding. Hosted deployment applies the committed schema migrations. `npm start` serves the production build locally after `npm run build`; it does not deploy the site. Hosted audience controls still apply: a private deployment requires the owner to sign in on each device. Making a deployment publicly reachable is a separate access setting, while individual transfer sessions remain invitation-based.
