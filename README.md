# E2 Plus II · Ride33 S4

Static firmware utility: Chrome/Edge Web Bluetooth → dashboard → CTRL.
No Ninebot account, Python installation or API server is required to use the published site.

## GitHub Pages

1. Create a separate repository. Copy **only the contents of this folder** into its root, including `lib/`, `firmware/`, `source/` and `.nojekyll`.
2. Under Settings → Pages, choose Deploy from a branch → main → /(root) → Save.
3. Wait for deployment, then open `https://USERNAME.github.io/REPOSITORY/`.

Do not publish the parent research workspace: it contains private data, dumps and logs. This folder contains the public release only.

All paths are relative. Both domain roots and repository subpaths are supported. Alternatively, put these files in `/docs` and select `/docs` in Pages. No npm build or Actions workflow is required.

GitHub documentation: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

## Local preview

From this directory: `python -m http.server 8780 --bind 127.0.0.1`, then open http://127.0.0.1:8780.
Do not use `file://`: it does not provide a suitable environment for module loading and Web Bluetooth.

## Compatibility and installation

- E2 Plus II with an N2SR serial prefix, CTRL 1.3.1 and BLE 2.1.12 only.
- Other regions, models and versions are blocked. Matching versions do not prove identical hardware revisions.
- Battery ≥50%, stationary wheel, no CTRL fault. Disconnect the charger yourself.
- Initial pairing requires the dashboard button. Optional pairing storage uses localStorage for this origin, without storage encryption; scripts on the same origin can access it. Use a trusted site and a separate browser profile on shared computers. “Forget saved keys” removes this tool's stored keys.
- No automatic connection, updates or OTA block retries. Failed transfers close the connection to prevent a late ACK from confirming another block.
- After applying, the client checks version, CTRL error and exact build ID. This is not a complete Flash readback.
- Transfer enables the stock lock. Unlocking is a separate action and requires a stationary scooter. The tool does not control the throttle.

Web Bluetooth requires HTTPS, except on localhost. Support: https://developer.chrome.com/docs/capabilities/bluetooth . Chrome on iPhone/iPad does not expose this API. Desktop operation requires a supported OS, Bluetooth adapter and browser permissions.

## Package

`firmware/ride33-s4.bin`, 54,184 bytes. SHA-256:
`8a7c6ff245dde429e3be5f86198e725e454b69a6ba5d7a9beed0e9f6ba8f4d68`.
Build `R4RD.20261002.01`, CTRL 305 (register version 1.3.1).
This is not a full Flash image for ST-Link. BLE and BMS are not updated.

## Measurements

No acceleration charts are included. Saved bench logs cover experimental builds; the useful 4× comparisons used Response2 as their baseline, not stock firmware. There is no suitable recorded stock-versus-final-road-build pair. No new measurements were taken.

On 2026-10-02, the owner reported successful installation and the desired throttle response. This is a single user report, not road or thermal qualification for every scooter.

## Source

All browser code is readable `.mjs`, HTML and CSS. See `source.html`.
Web tool license: AGPL-3.0. Third-party information: `THIRD-PARTY-NOTICES.md`.
Changing the firmware or release manifest requires renewed compatibility and integrity validation.
