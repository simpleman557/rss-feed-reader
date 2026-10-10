# Spec: iPhone home-screen app (PWA)

<!-- Mode: full. It touches several files (new manifest, new icons, index.html) and depends on
     behavior outside our code (iOS, Google sign-in), so every section is kept. -->

**Status:** Approved
**Date:** 2026-10-10
**Scope in one sentence:** Make the hosted feed reader installable on an iPhone home screen so article links open with a way back to the app, with no UI or access changes.

## Open questions and assumptions

Resolve these before coding unless marked otherwise.

- **ASSUMPTION A1 (unverified, the success criterion):** in an iOS home-screen app, a `target="_blank"` link to an external site opens in an in-app Safari sheet with a Done button that returns to the app. Only a real-phone test can confirm this (M-2).
- **ASSUMPTION A2 (unverified, the biggest risk):** Google sign-in via IAP works inside the home-screen app. IAP redirects to `accounts.google.com`, a different site, and iOS may handle that navigation differently in standalone mode. If sign-in cannot complete, this approach fails (M-1).
- **A3 (disproved on the real phone):** I assumed iOS keeps separate cookie storage for the home-screen app, so one extra sign-in would be needed. It was not asked for.
- **ASSUMPTION A4:** safe-area padding already exists in `web/src/App.css` (`env(safe-area-inset-*)`, verified by reading it), but it has not been checked in standalone mode. `default` is chosen as the lowest-risk status bar style, and M-1 checks it visually (see section 2).
- **RESOLVED:** the CSP needs no change. In `server/src/securityHeaders.js` the manifest falls back to `default-src 'self'`, and icons are covered by `img-src 'self' data: https: http:`. Verified by reading the file.
- **RESOLVED (amended 2026-10-10):** the original plan reused `web/public/favicon.svg`, which turned out to be the stock Vite starter bolt, so it read as a generic browser icon. Replaced with a Feed Reader icon (concept "C-Dark": RSS symbol over three article lines, on the app's dark surface `#151922`, symbol in the dark accent `#8a8af5`, lines `#e7eaf1` and `#aab1c2` so they stand out). One fixed icon, used for the browser tab and the home screen; no light/dark switching. iOS appears to take a single PNG for the home-screen icon; not verified, and not needed given this decision.

## 1. Requirements

**User outcome:** Open the feed reader from a home-screen icon like an app. Tapping an article opens it with a clear way back to the reader, with no tab switching.

**Functional requirements**
- The page is installable via Safari's Add to Home Screen, with a name and icon.
- It launches in standalone mode (no Safari toolbar).
- Article links keep working and still mark the article as read.

**Non-functional requirements**
- No change to server behavior, auth, or data.
- No added runtime weight beyond a small manifest and three icons.
- Nothing cached offline (no service worker), so the app can never show stale or broken state. Why: a caching bug in an installed app is hard for a hobbyist to diagnose and fix.

**Non-goals**
- No native wrapper (Capacitor), no app store, no Android work.
- No offline mode, push notifications, or UI changes.
- No change to the safe-area CSS. The status bar style is chosen so none should be needed.
- No change to IAP or `ALLOWED_HOSTS`.

**Acceptance criteria: trust and quality**
- Data collected: none new.
- Permissions requested: none.
- Accessibility: unchanged. Status bar text must stay readable in light and dark mode (checked in M-1).
- AI output: not applicable. Fully reversible by removing the home-screen icon.

**Pass/fail for the real-phone checks (decided by the user, after about a day of normal use)**
- **M-1 pass:** the installed app launches, completes Google sign-in once, loads the feed, and has no sign-in loop. Content is not hidden under the status bar or notch in light and dark mode.
- **M-2 pass:** tap an article, see a Done or back control, tap it, and land in the reader with the same scroll position and the article marked read.
- **Fail:** either check fails. Do not try workarounds; stop and write the Capacitor spec.

## 2. Architecture / Design

**Components**
- `web/public/manifest.webmanifest` (new): name, `display: standalone`, `start_url: /`, colours matching `theme-color` (`#f7f8fa` / `#0a0c11`), icon list.
- `web/public/*.png` (new): 180, 192 and 512 px icons. Each has a solid background (iOS fills transparent areas with black). Committed to the repo, so there is no build-time dependency. The tool used to render them is noted in the pull request.
- `web/index.html` (edited): manifest link with `crossorigin="use-credentials"`, `apple-touch-icon`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-title`.
- Status bar style: `apple-mobile-web-app-status-bar-style` is `default`. Why: `black-translucent` draws content under the status bar, and with `viewport-fit=cover` already set that would shift the layout. The existing safe-area padding was written for the browser and is unchecked in standalone mode.

**Data flow:** unchanged. The only new requests are the manifest and icon fetches, which go through IAP like everything else.

**Dependency map:** `index.html` -> manifest -> icons, served by Express static from `web/dist`. Nothing depends on the new files.

**Impact check on existing code**
- Touches: `web/index.html`, `web/public/`.
- What else depends on them: Express static serving, the CSP, IAP.
- Contracts that could break:
  - IAP: browsers fetch the manifest without cookies by default, so IAP would redirect it to sign-in. The link must use `crossorigin="use-credentials"`.
  - CSP: verified no change needed (see open questions).
  - `/theme-init.js` must stay an external script (`script-src 'self'`).

**Delete check:** no service worker, no maskable icon, no splash images. Add only if a real need appears.

## 3. Data model / schema

N/A: no data is stored or changed.

## 4. Interface contracts

| Interface | Inputs | Outputs | Errors it can raise | Who may call / mutate |
|---|---|---|---|---|
| `GET /manifest.webmanifest` | IAP session cookie | JSON manifest | 302 to Google sign-in if no cookie; 403 if Host not allowed | Browser |
| `GET` icon PNGs (180, 192, 512) | same | PNG | same | Browser |

## 5. Error handling and edge cases

| Scenario | Expected behavior | Detected how | Covered by test (ID) |
|---|---|---|---|
| Manifest fetch redirected by IAP | Install still works via the Apple tags, but name and colours may be wrong | Manual: open the manifest URL in Safari while signed in | M-0 |
| Manifest or icon missing from build | Test fails | e2e | IT-1 |
| Google sign-in blocked or loops in the installed app | Cannot use the installed app; rollback | Manual on phone | M-1 |
| Links open in an unhelpful way | Rollback and write the Capacitor spec | Manual on phone | M-2 |
| IAP session expires while the app is open | Background `/api` requests are redirected to Google and fail, likely showing the error banner instead of a login page (unverified). Recovery to try first: force-quit and relaunch. | Manual: note the behavior when it happens; document in `docs/DEPLOY.md` | M-3 |
| Host not in `ALLOWED_HOSTS` | 403 as today | Existing tests | Existing |

## 6. Integration tests

- [ ] IT-1: Playwright: the built app serves `/manifest.webmanifest` as valid JSON with `display: standalone` and a content type containing `json` or `manifest` (Express's type for `.webmanifest` is unverified; if the assertion fails, record the finding here as a spec change before touching server code); the page links it with `crossorigin="use-credentials"`; every icon listed returns 200 as `image/png`. Limit: the e2e run has no IAP, so it cannot prove IAP lets the manifest through (covered by M-0).
- [ ] IT-2: the existing desktop and mobile e2e suites (44 tests) still pass.
- [ ] M-0 (manual, after deploy): signed in, open the manifest URL in Safari and confirm it loads.
- [ ] M-1 (manual, real phone, run first): install, launch, sign in once, check the pass criteria above.
- [ ] M-2 (manual, real phone, only if M-1 passes): article link behavior, check the pass criteria above.
- [ ] M-3 (manual, opportunistic): when the sign-in eventually expires, note what the app shows and whether force-quit and relaunch recovers it.

## 7. Unit tests

N/A: there is no new logic. A unit test would only mirror the file contents.

## 8. Dependencies

| Dependency | Pinned version | Why needed | Known risks |
|---|---|---|---|
| None added | n/a | Icons are rendered once with a local tool and committed | n/a |

## 9. Deployment, configuration, and rollout

- How it runs: the same Cloud Run deploy (`gcloud run deploy feed-reader --source .`).
- Configuration needed: none.
- Release mode: direct. It is additive and harmless to existing browser users.
- Order of work: deploy the code change first (manifest, icons, tags) and run M-0, M-1 and M-2. M-1 is the first gate: if it fails, stop. Write the `README.md` and `docs/DEPLOY.md` updates only after M-1 passes, so a failed attempt leaves no docs to undo.
- Signals to watch: 302/403 responses for the manifest in Cloud Run logs; M-0 to M-3 results.
- **Rollback trigger:** M-1 or M-2 fails per the pass/fail definition. Action: remove the head tags, delete the home-screen icon, and write a Capacitor spec.
- Docs to update with this change: `README.md` (iPhone install steps), `docs/DEPLOY.md` (extra sign-in note and the expired-session recovery). No CHANGELOG exists in the repo.

## Change log

- 2026-10-10: initial draft
- 2026-10-10: amendment: replaced the icon (see the RESOLVED note above). `favicon.svg` and the three PNGs are regenerated from one drawing (rounded for the tab, full square for iOS). No change to the manifest, tags, or tests. A deploy plus a re-add of the home-screen icon is needed to see it on the phone, because iOS caches the icon when it is added.
- 2026-10-10: deployed (revision `feed-reader-00015-86k`) and tested on a real iPhone. M-0 passed (manifest shows JSON). M-1 passed (launches full screen, feeds load, status bar looks normal; no second sign-in was asked for, so A3 was wrong). M-2 passed (article opens in an in-app sheet with an X at the top left and a back button at the bottom left; both return to the same scroll position, article marked read), so A1 and A2 held. Light and dark mode both look fine in the installed app (M-1 complete). Also seen on the phone: paywalled sources let the user log in inside the in-app sheet, and two sources opened their own native apps directly, each with a back-to-Feed-Reader control. Still to do before marking Implemented: about a day of normal use, and M-3 when a sign-in eventually expires. README and DEPLOY.md updated.
- 2026-10-10: approved; built manifest, icons (rendered from `favicon.svg` with Playwright's Chromium onto `#0a0c11`) and `index.html` tags. IT-1 passes, which also confirms Express serves `.webmanifest` with a json/manifest content type, so no server change is needed. M-0 to M-3 and the docs updates remain.
- 2026-10-10: second critique; corrected A4 (safe-area padding exists in `App.css`), added a content-type check to IT-1, made the deploy-then-docs order explicit
- 2026-10-10: reconciled with spec-writer; applied critique fixes (sign-in gate M-1, pass/fail for M-2, status bar style pinned to `default`, icon background and method, IT-1 limits and M-0, expired-session scenario M-3); recorded that the CSP needs no change
