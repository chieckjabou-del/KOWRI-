## Creator backend contract map (audit)

Backend source audited: `artifacts/api-server/src/routes/creatorEconomy.ts` and `artifacts/api-server/src/lib/creatorEconomy.ts`.

### Existing creator endpoints used by frontend

- `GET /creator/dashboard/:creatorId`
  - Returns:
    - `communities[]` with `creatorFeeRate`, `platformFeeRate`, `totalVolume`, `memberCount`
    - `stats` with `totalCommunities`, `totalMembers`, `totalVolume`, `totalEarnings`
- `GET /creator/communities?limit=50`
  - Lists active communities.
- `GET /creator/communities/:handleOrId`
  - Community detail by id or handle.
- `GET /creator/communities/:communityId/pools`
  - Returns community-linked `investmentPools[]` and `tontines[]`.
- `POST /creator/communities`
  - Creates a creator community (expects existing backend fields).
- `POST /creator/communities/:communityId/join`
  - Joins a community.
- `POST /creator/communities/:communityId/earnings`
  - Distributes creator and platform fees from a provided `transactionAmount`.

### Fee logic from backend (no invention)

In backend:
- `creatorFee = transactionAmount * (creatorFeeRate / 100)`
- `platformFee = transactionAmount * (platformFeeRate / 100)`

Rates are percentage points already (example: `5` means `5%`).

### Tontine integration route used for creator monetization

- `POST /community/tontines/:tontineId/collect`
  - Returns `{ collected, failed, totalCollected }`.
  - Frontend uses `totalCollected` as input for creator earnings distribution when creator mode is linked.

### Frontend scope implemented

- Added `/creator-dashboard` page using only existing backend creator/tontine endpoints.
- Added "mode createur" toggle inside tontine creation UI.
- Linked creator mode to existing communities and creator fee rates.
- On contribution collection, frontend can trigger creator earnings distribution through existing backend endpoint.
- Added a 60-second demo flow:
  - `/dashboard` CTA opens create flow with creator mode pre-activated.
  - Create success redirects to `/tontine/:id?demo=1`.
  - Collect in demo flow redirects to `/creator-dashboard` with visible gains update.
- Added viral loop UI in `/creator-dashboard`:
  - "Inviter des membres" section
  - dynamic invite link generation based on existing community+tontine IDs
  - live cards for members / estimated gains / real gains projection.
- Added gamification from existing backend contract only:
  - uses `/community/reputation/:userId/badges`
  - auto-triggers `/community/reputation/:userId/compute` only when score is missing (404)
  - displays score, tier and earned badges in creator dashboard.

### Robustness / anomaly hardening

- `collect` no longer fails if creator earnings distribution endpoint fails.
  - Collection success is preserved.
  - UI reports partial success and keeps user flow stable.
- API base URL is now centralized and environment-aware:
  - supports `VITE_API_BASE` (e.g. API domain in preview/production)
  - defaults to local `/api` when unset.
- SPA deployment readiness:
  - Vercel rewrite fallback to `index.html` remains active.
  - frontend fetches are aligned to centralized API URL builder.

No backend code or business logic was modified.
