# QA report — apl.tucomprass.com

- Date: 2026-08-11 (America/Lima)
- Scope: VPS dashboard, passenger APK, driver APK; POS excluded.
- Result: DONE_WITH_CONCERNS

## Verified

- Real QA trip completed on Samsung through `he llegado` → `pasajero a bordo` → `finalizar viaje`.
- Passenger Huawei automatically opened the rating sheet after the completed trip was recovered on app restart.
- Selected 5/5; PostgreSQL recorded `completed`, `rating=5`, feedback timestamp, and `trip_feedback` row.
- Fixed and redeployed the VPS validation that rejected an empty optional comment with a rating.
- Fixed passenger recovery for completed trips that finished while the app was minimized/closed.
- Fixed passenger history to display saved VPS ratings instead of asking again.
- Driver assignment notification was observed while Samsung was minimized; Android notification channel had high importance.
- Dashboard map, live fleet, places/settings navigation, alert drawer, final location, call/WhatsApp links, filters, and alert recognition paths were exercised with QA data.
- VPS health returned `status=ok`, database reachable; dashboard returned HTTP 200.

## Concerns / not fully physical

1. A prolonged driving route with the phone physically moving could not be completed autonomously; the device was left stationary/locked after reinstall. GPS stream and heartbeat were previously verified with real device samples, but a user must drive/walk the Samsung for the final movement acceptance test.
2. Dashboard navigation automation intermittently retained the alert drawer because the live browser session was not exposing its auth/storage objects to the controller. The product API and dashboard snapshot remained healthy; this is recorded as a test-harness limitation, not patched blindly.
3. Android force-stop remains a platform limitation for data-only FCM; minimized (not force-stopped) delivery passed.

## Fixes made during this run

- `b2ddc90`: recover pending passenger feedback and allow empty VPS feedback comments.
- `56cfa92`: show saved VPS trip feedback in passenger history.

## Evidence

- `driver-current-qa.png`, `passenger-review-qa.png`, `passenger-history-final.xml`, `driver-final-qa2.xml`.
- Backend verification: completed trip with rating 5 and feedback timestamp; alert state restored to closed.
