# AKWE GO LIVE Growth Certificate

Date: 2026-05-04

## Resultat global

GO LIVE Growth: OUI

Le produit est operationnel avec:
- funnel d'entree mobile optimise,
- instrumentation growth,
- moteur referral WhatsApp actif dans les ecrans critiques,
- dashboard founder en place (backend + frontend),
- URLs publiques unifiees vers `akwe.app`.

## Verifications techniques executees

1. Domaine premium:
   - `akwe.app` verifie disponible sur Vercel.
   - achat/raccordement DNS reste une operation de compte Vercel (hors codebase).

2. Nettoyage URLs:
   - liens d'invitation et partage migrés vers `https://akwe.app/...`.
   - plus d'URLs Vercel aleatoires detectees dans le frontend principal.

3. Onboarding funnel:
   - route publique `/growth` ajoutee.
   - redirect racine vers `/growth` pour visiteurs non connectes.
   - login/register instrumentes + normalisation numerique.

4. Referral + WhatsApp engine:
   - card referral ajoutee au `DashboardHome`.
   - partage WhatsApp + copie lien disponibles.
   - tracking growth uniforme sur dashboard, creator dashboard et detail tontine.

5. Mobile conversion UX:
   - deep-links wallet (`/wallet?action=...`) depuis dashboard.
   - ouverture contextuelle des modales wallet.
   - reduction du nombre de taps pour action de valeur.

6. Founder analytics mode:
   - endpoint backend: `GET /api/founder/mvp?period=7d|30d|90d`.
   - route frontend: `/founder`.
   - cartes KPI + series + breakdown volume.
   - acces conditionne par allowlist env (`FOUNDER_USER_IDS`, `VITE_FOUNDER_USER_IDS`).

## Event taxonomy active (extraits)

- `growth.auth.login_viewed|submitted|success|failed`
- `growth.auth.register_step_viewed|completed`
- `growth.auth.register_submitted|success|failed`
- `growth.activation.dashboard_viewed`
- `growth.activation.first_value_action`
- `growth.referral.link_generated`
- `growth.referral.share_clicked`
- `growth.referral.link_copied`
- `growth.referral.invite_opened`

## Conditions de production

Avant campagne scale:
- definir `VITE_PUBLIC_APP_URL=https://akwe.app` dans Vercel frontend,
- definir `FOUNDER_USER_IDS` sur l'API,
- definir `VITE_FOUNDER_USER_IDS` sur le frontend,
- connecter DNS du domaine achete sur le projet Vercel cible.

## Conclusion

La base produit-growth est en place et exploitable immediatement.
Le prochain levier est execution operationnelle: campagnes WhatsApp, rituels founder quotidiens, et iteration copy/UX a partir des evenements remontes.
