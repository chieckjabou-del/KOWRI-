# Akwé Frontend (kowri-app)

Frontend fintech premium construit pour s'adapter au backend existant sans modifier la logique metier.

## Routes principales

- `/dashboard` : home principal (solde, actions rapides, apercu activite, acces tontine)
- `/wallet` : module wallet (solde detaille, envoyer/recevoir/deposer/retirer UI, historique)
- `/tontine` : module tontine (liste perso, creation, rejoindre)
- `/tontine/:id` : detail tontine (membres, cotisation, calendrier/timeline, statut paiements, historique)

## Structure technique

- `src/features/wallet/*` : logique UI wallet
- `src/features/tontine/*` : logique UI tontine
- `src/services/api/walletService.ts` : appels API wallet centralises
- `src/services/api/tontineService.ts` : appels API tontine centralises
- `src/types/akwe.ts` : types domaine frontend

## Integration backend

- Appels API faits via `apiFetch` et services dedies.
- Aucune modification backend/base de donnees.
- Fallback simulation active si certains endpoints ne sont pas disponibles, pour garantir la navigation de demo.

## Scripts utiles

- `pnpm --filter @workspace/kowri-app run typecheck`
- `pnpm --filter @workspace/kowri-app run build`
