# AKWE Growth Strategy - 30 jours (Go Live)

## Objectif principal

Passer d'un produit "techniquement live" a un moteur d'acquisition et d'activation mesurable:

1. Plus d'inscriptions qualifiees.
2. Plus d'activation J0/J1 (premiere action de valeur).
3. Plus de viralite WhatsApp et referral.
4. Pilotage quotidien par founder dashboard.

## KPI nord et KPI operationnels

- KPI nord: `activation_rate` (nouveaux inscrits qui realisent une transaction completee sur la periode).
- KPI operationnels:
  - `wallet_adoption_rate`
  - `tx_success_rate`
  - `repeat_user_rate`
  - `wau_mau_proxy`
  - `savings_stickiness`
  - `avg_first_value_hours`
  - `growth.referral.share_clicked` (channel whatsapp / copy)
  - `growth.referral.link_copied`

## Piliers d'execution (30 jours)

### Pilier 1 - Acquisition qualifiee (J1-J10)

- Domaine premium `akwe.app` raccorde a Vercel (front public).
- Toutes les URLs d'invitation normalisees sur `https://akwe.app/register?...`.
- Lancement messages WhatsApp courts et longs (A/B) pour:
  - particuliers
  - marchands
  - createurs de tontine

### Pilier 2 - Onboarding conversion mobile (J1-J14)

- Entree utilisateur via `/growth` (pre-auth landing) au lieu d'un redirect brut vers login.
- Instrumentation funnel:
  - `growth.auth.login_viewed`
  - `growth.auth.login_submitted`
  - `growth.auth.login_success|failed`
  - `growth.auth.register_step_viewed|completed`
  - `growth.auth.register_submitted|success|failed`
- Auto-normalisation numero mobile + hints UX pour reduction friction.
- Suppression du delai artificiel post-inscription (auto-login immediat).

### Pilier 3 - Referral + engine WhatsApp (J3-J20)

- Carte referral visible sur dashboard principal (`DashboardHome`).
- CTA:
  - "Partager sur WhatsApp"
  - "Copier mon lien"
- Tracking:
  - `growth.referral.link_generated`
  - `growth.referral.share_clicked`
  - `growth.referral.link_copied`
- Attribution marketing:
  - capture `ref`, `utm_source`, `utm_medium`, `utm_campaign` des l'arrivee.

### Pilier 4 - Activation "first value" (J5-J25)

- CTA dashboard instruments:
  - envoi
  - depot
  - retrait
  - recevoir
- Deep-links wallet (`/wallet?action=deposit|receive|withdraw`) pour reduire le nombre de taps.
- Event: `growth.activation.first_value_action`.

### Pilier 5 - Founder operating system (J7-J30)

- Route backend `/api/founder/mvp?period=7d|30d|90d`.
- Dashboard founder `/founder` dans l'app:
  - cards KPI
  - serie nouveaux vs actives
  - breakdown volume par type de transaction
  - totaux operatoires
- Gouvernance access:
  - `FOUNDER_USER_IDS` (backend)
  - `VITE_FOUNDER_USER_IDS` (frontend)

## Plan d'actions hebdomadaire

### Semaine 1 - Foundation data + conversion

- Connecter domaine.
- Valider tracking events.
- Activer landing `/growth`.
- Monitorer erreurs login/register.

Sorties attendues:
- Dashboard founder exploitable.
- Pipeline referral fonctionnel.

### Semaine 2 - Intensification acquisition

- Campagnes WhatsApp communautaires (particuliers + createurs + marchands).
- Scripts d'invitation via leaders de tontine.
- Ajustements copy sur ecrans auth et referral.

Sorties attendues:
- hausse `growth.referral.share_clicked`
- baisse `avg_first_value_hours`

### Semaine 3 - Optimisation activation

- Analyser steps les plus abandonnes.
- Optimiser erreurs actionnables (auth, transfert, wallet).
- Renforcer nudges post-inscription sur dashboard.

Sorties attendues:
- hausse `activation_rate`
- hausse `wallet_adoption_rate`

### Semaine 4 - Scale et standardisation

- Standardiser playbook acquisition locale (zones, relais, scripts).
- Stabiliser cadence quotidienne founder:
  - check KPI matin
  - actions correctives midi
  - revue soir.
- Preparer extension rewards referral cote backend (phase 2).

Sorties attendues:
- hausse `repeat_user_rate`
- hausse `wau_mau_proxy`

## Risk register et mitigations

- Risque: fraude referral.
  - Mitigation: reward declenchee seulement apres action eligible + caps + delai de validation.
- Risque: faible adoption founder dashboard.
  - Mitigation: review quotidienne obligatoire basee sur 3 KPI max.
- Risque: conversion mobile degradee sur petits ecrans.
  - Mitigation: CTA prioritaires + simplification formulaire + feedback inline.

## Definition of done (Go Live Growth)

La strategie 30 jours est consideree active si:

1. Domaine premium connecte et utilise dans les liens referral.
2. Events funnel + referral remontent.
3. Founder dashboard accessible et alimente.
4. Au moins une boucle acquisition WhatsApp executee avec suivi KPI.
