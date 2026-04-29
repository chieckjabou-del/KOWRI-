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

No backend code or business logic was modified.
