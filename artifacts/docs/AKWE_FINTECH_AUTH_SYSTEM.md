# AKWE Fintech Authentication System

## Mission coverage

This implementation delivers an end-to-end modern auth baseline for AKWE with:

1. Phone + OTP as primary login.
2. Google / Apple optional fast login.
3. Biometric unlock after first login (device-bound token model).
4. 4-digit secure PIN fallback.
5. Progressive KYC by transaction limits.
6. Device trust scoring.
7. Suspicious login detection.
8. Mobile-first weak network UX signals.

## Backend components

### New auth risk/trust data model
- `auth_otp_challenges`
- `auth_login_events`
- `auth_device_trust`

Defined in:
- `lib/db/src/schema/phase6.ts`

### New fintech auth core library
- `artifacts/api-server/src/lib/authFintech.ts`

Responsibilities:
- OTP challenge generation/verification.
- PIN verification with device trust updates.
- Biometric token verification/enablement.
- Suspicious login scoring (risk score).
- KYC limit status hydration at login.
- Auth event logging.

### Auth endpoints (API)
- `POST /api/auth/otp/request`
- `POST /api/auth/otp/verify`
- `POST /api/auth/pin/login`
- `POST /api/auth/social/login`
- `POST /api/auth/biometric/enable`
- `POST /api/auth/biometric/login`
- `GET /api/auth/risk/:userId`
- `POST /api/auth/login` (legacy compatibility, now with trust/event tracking)

Main file:
- `artifacts/api-server/src/routes/auth.ts`

### Legacy endpoint hardening
- `POST /api/wallet/login` marked deprecated with `410 Gone`.
- `POST /api/users/login` upgraded to trust/risk-aware flow with consistent metadata.

Files:
- `artifacts/api-server/src/routes/walletProduct.ts`
- `artifacts/api-server/src/routes/users.ts`

## Frontend components

### Login UI overhaul
- OTP-first flow.
- PIN fallback action.
- Optional social fast login buttons (env-gated).
- Biometric unlock action when device token exists.
- Security meta panel (risk/device trust/KYC hints).
- Network/degradation signals via response headers.

File:
- `artifacts/kowri-app/src/pages/Login.tsx`

### New frontend auth service
- `artifacts/kowri-app/src/services/api/authService.ts`

### Device biometric local store
- `artifacts/kowri-app/src/lib/biometricUnlock.ts`

### Weak network UX baseline
- API helper now sends:
  - `x-network-quality`
  - `x-client-hint: weak-network-mobile`

File:
- `artifacts/kowri-app/src/lib/api.ts`

## Security model summary

### OTP
- Short-lived challenge (`5 min`).
- Attempt-limited OTP verification.
- Challenge consume-on-success behavior.

### PIN fallback
- Device-level failed attempt counter.
- Temporary block after repeated failures.
- Trust score decay/recovery depending on behavior.

### Device trust
- Per user + device profile.
- Trust score bounded and updated on success/failure.
- IP hash continuity signal.

### Suspicious login scoring
- Factors:
  - low trust score
  - new IP
  - repeated failures
  - blocked state
  - fallback method usage
- Output:
  - `riskScore`
  - `suspicious` boolean

### KYC progressive limits
- Login payload includes:
  - current level
  - monthly limit
  - used and remaining amount
  - next-level hint

## Operational notes

### Social fast login toggles
- `AUTH_GOOGLE_ENABLED=1`
- `AUTH_APPLE_ENABLED=1`

### Founder/auth risk observability
- Risk endpoint:
  - `/api/auth/risk/:userId`
- Auth events persisted in `auth_login_events`.

### Production readiness caution
- `debugOtp` is currently returned by OTP request endpoint for rapid integration/testing.
- Before public production, replace with SMS provider dispatch and remove `debugOtp` from responses.

## Goal alignment

This architecture is tuned for:
- low-friction mobile onboarding,
- measurable fraud-aware auth posture,
- resilient login under weak network,
- and a UX benchmark target comparable to leading mobile money onboarding flows.
