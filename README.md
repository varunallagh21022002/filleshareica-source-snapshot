# filleshareica

A work-in-progress file-sharing and chat application designed for approved sessions between phones and computers. The application explores QR or invitation-based pairing, file transfers, and session chat.

This is a **sanitized snapshot of committed source** from the private development checkout at commit `527545d`. It does not contain later local changes, credentials, deployment identity, production payment configuration, or runtime data. It is source evidence, not a claim that the current private checkout or hosted version has been released.

## Local setup

The app lives in `app/` and requires Node.js 22.13 or newer. From that directory run `npm ci`, `npm run setup:local`, `npm run db:migrate:local`, and `npm run dev`. Local setup generates a development signing key in the ignored `.dev.vars`; do not commit or share it. Authentication, advertising and payment integrations require separate configuration and are not enabled by publishing this snapshot.

The private project has additional documentation, local changes, and release checks that are not part of this snapshot. This public copy has not been tested as a production deployment. Real-network, device, large-file, and payment capabilities require their own verification; no specific speed or size guarantees are made here.
