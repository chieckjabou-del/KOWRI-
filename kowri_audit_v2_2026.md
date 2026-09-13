# KOWRI — Audit approfondi v2 (13 septembre 2026)

Périmètre : branche `claude/akwe-cto-audit-l7ln2q` (PR #17), état après les phases 1 à 5, les comptes opérateurs et le gel des modules expérimentaux.
Méthode : lecture complète des routeurs, du ledger, des schémas et des deux front-ends, puis **sondes HTTP réelles sans aucune authentification** contre l'API lancée en local (PostgreSQL 16, `NODE_ENV=development`). Chaque constat marqué « sondé » a été reproduit.

Volumétrie : API 23 000 lignes, application mobile 17 000, back-office 13 600 ; 47 routeurs montés dans `artifacts/api-server/src/routes/index.ts`.

## 1. Synthèse

| Sévérité | Nombre | Résumé |
|---|---|---|
| Critique | 3 | Routes qui créent ou modifient de l'argent **sans authentification** (agents, liquidité FX, taux FX) |
| Élevée | 7 | Fuite de données internes sans authentification, IDOR sur le crédit, remboursement de prêt inopérant, plafonds KYC insensibles à la devise, paiement de tontine non ajusté aux cotisations réellement encaissées |
| Moyenne | 12 | Robustesse (transactions partielles, arrêt non gracieux, schedulers multi-instances), durcissement HTTP, validation trop agressive, PII en base |
| Faible / processus | 6 | Pas de CI, pas de lockfile, rôles non reflétés dans l'interface, stockage du jeton mobile |

Ce qui est **sain et vérifié** : ledger en partie double avec verrous `FOR UPDATE`, sessions hachées, PIN hachés (migration des anciens hashs au login), idempotence par utilisateur avec réservation en base, filtrage fraude/AML synchrone, webhooks signés HMAC avec délai et sans suivi de redirection, worker outbox avec politique de relance par classe d'erreur, comptes opérateurs avec rôles et contrôle des secrets au démarrage. 651 vérifications automatisées passent.

## 2. Constats critiques

### C1 — Le réseau d'agents est entièrement ouvert (sondé)
Fichier : `artifacts/api-server/src/routes/agents.ts` (21 routes, aucune ligne `router.use(authenticate…)`).

Reproduit sans en-tête d'authentification :
- `POST /api/agents` → 201, crée un agent **et un wallet marchand** rattaché à n'importe quel `userId` existant.
- `POST /api/agents/:id/cash-update` avec `{"cashBalance":5000000}` → 200, la table `agent_wallets` affiche `5 000 000` de cash.
- `POST /api/agents/:id/liquidity-transfer` n'est bloqué que par l'absence d'en-tête `Idempotency-Key` ; avec cet en-tête il appelle `executeFloatTransfer` qui **déplace de l'argent dans le ledger** (`lib/liquidityEngine.ts`).
- `GET /api/agents` liste tous les agents, téléphones et soldes.

Impact : n'importe qui sur Internet peut fabriquer de la liquidité d'agent, transférer du float entre agents, valider des rapprochements et lire tout le réseau. L'application mobile appelle ces routes, donc l'exposition est réelle en production.

### C2 — Pools de liquidité FX réinitialisables et réservables sans authentification (sondé)
Fichier : `artifacts/api-server/src/routes/fxLiquidityRoute.ts`.
- `POST /api/fx/liquidity/pools/init` → 200 `{"initialized":true,"poolCount":6}` : recrée les pools (1 075 000 000 en local).
- `POST /api/fx/liquidity/reserve` accepte des réservations qui consomment la liquidité disponible.

Impact : épuisement ou remise à zéro des pools de change par un tiers, blocage des transferts diaspora.

### C3 — Taux de change modifiables sans authentification (sondé)
Fichier : `artifacts/api-server/src/routes/fx.ts`.
- `POST /api/fx/rates/snapshot` → 200 `{"snapshotted":24}`.
- `POST /api/fx/convert` répond aux conversions pour quiconque.
Si une route d'écriture de taux est ajoutée dans ce routeur (ou si `snapshot` prend un jour des valeurs en entrée), elle sera ouverte. Aujourd'hui l'impact est la pollution de l'historique des taux et le déni de service par saturation.

## 3. Constats élevés

### E1 — Données internes exposées sans authentification (sondé)
Toutes ces routes ont répondu 200 sans en-tête :

| Route | Fichier | Ce qui sort |
|---|---|---|
| `GET /api/analytics/overview` | `routes/analytics.ts` | volumes, nombre d'utilisateurs, wallets actifs |
| `GET /api/system/events`, `/metrics`, `/snapshot` | `routes/system.ts` | flux d'événements internes avec identifiants d'utilisateurs, métriques serveur, version Node |
| `GET /api/system/report/full`, `/summary` | `routes/systemReport.ts` | rapport complet de la plateforme |
| `GET /api/regulatory/reports`, `/export` | `routes/regulatory.ts` | rapports réglementaires (activités suspectes, gros montants) ; `POST /generate` ouvert |
| `GET /api/fraud/intel/network/graph`, `/scores`, `/stats` | `routes/fraudIntel.ts` | graphe des wallets, scores de risque par wallet ; `POST /scores/compute` et `/anomaly/detect` ouverts |
| `GET /api/warroom/incidents` | `routes/warroom.ts` | incidents internes |
| `GET /api/payment-routes`, `POST /select` | `routes/paymentRoutes.ts` | routage des processeurs ; `POST /` et `PATCH /:id` ouverts |
| `GET /api/archive/stats`, `/query?walletId=` | `routes/archive.ts` | historique archivé de n'importe quel wallet ; `POST /run` ouvert |
| `GET /api/product/architecture` | `routes/productArchitecture.ts` | inventaire de l'architecture |
| `GET /api/debug-build` | `app.ts:35` | chemins du système de fichiers du serveur |
| `GET /api/settlements`, `/api/connectors`, `/api/clearing` | gelés par `experimental()` **uniquement en production** ; ouverts en préproduction/staging |

Impact : divulgation d'informations réglementées (rapports d'activité suspecte) et de la topologie interne ; surface d'attaque pour de la reconnaissance.

### E2 — Module crédit : lecture croisée entre utilisateurs
Fichier : `artifacts/api-server/src/routes/credit.ts`. Le routeur est authentifié (`router.use(authenticate())`, ligne 19) mais :
- `GET /credit/loans`, `GET /credit/scores`, `GET /credit/repayments?userId=`, `GET /credit/loans/:id` ne filtrent pas sur `req.auth.userId` : un client connecté lit les prêts et scores des autres.
- `POST /credit/scores/:userId/compute` recalcule le score de n'importe qui.

### E3 — Remboursement de prêt qui n'encaisse rien
Fichier : `credit.ts:335` — le remboursement cherche un wallet dont `userId = "system"`. Ce compte n'est créé nulle part ; le remboursement est alors enregistré avec `transactionId: null` **sans mouvement d'argent**, et le prêt peut passer en « remboursé » gratuitement. Le bloc `catch` renvoie 400 pour toute erreur, ce qui masque le problème.

### E4 — Plafonds KYC et limiteur de débit insensibles à la devise
Fichier : `lib/walletService.ts:223-266` et `lib/rateLimiter.ts`. Le plafond mensuel est exprimé en XOF (`100 000` au niveau 0) mais s'applique tel quel à un wallet EUR ou USD (100 000 EUR ≈ 65 millions XOF). Les sommes horaires/journalières du limiteur additionnent des devises différentes. `getMonthlyVolume` utilise le mois local du serveur, pas celui de l'utilisateur.

### E5 — Paiement de tontine calculé sur les cotisations théoriques
Fichier : `lib/tontineScheduler.ts:284-319`. `payoutAmount` = somme des cotisations de **tous** les membres, même si `collectContributions` a enregistré des cotisations manquées (lignes 109-160). Si un membre n'a pas payé, le wallet de la tontine ne couvre pas le montant, `processTransfer` échoue, la tontine reste bloquée sur ce round (le verrou `hasReceivedPayout = 2` est bien relâché, mais rien ne rejoue). `computeNextDate` part de « maintenant » et non de la date planifiée : les rounds dérivent dans le temps.

### E6 — Transfert de float multi-étapes non transactionnel
Fichier : `lib/liquidityEngine.ts` (`executeFloatTransfer`, `submitReconciliation`). Plusieurs écritures successives avec compensation « au mieux » ; une panne entre deux étapes laisse un float débité d'un côté sans crédit de l'autre. Combiné à C1, c'est un vecteur direct de création d'argent.

### E7 — Idempotence des agents stockée dans un champ texte
`agents.ts` range la clé d'idempotence dans la colonne `note` des opérations ; une recherche texte n'est ni indexée ni fiable, et un double envoi peut passer.

## 4. Constats moyens

| # | Constat | Fichier | Impact |
|---|---|---|---|
| M1 | `POST /agents` sans `userId` insère un wallet avec `userId = agentId` (clé étrangère violée → 500) | `agents.ts:136` | erreur serveur, journal pollué |
| M2 | `investInPool` calcule les parts sur `goalAmount` et non sur la valeur réelle du pool ; `redeemPoolPosition` prend le premier wallet de l'utilisateur sans contrôle de devise et autorise le rachat pendant que le pool est encore « open » | `lib/communityFinance.ts:62-118` | dilution injuste, crédit dans une mauvaise devise |
| M3 | CORS ouvert à toutes les origines, aucun en-tête de sécurité (pas de `helmet`), limite de corps JSON implicite (100 ko par défaut mais non déclarée) | `app.ts:18-19` | CSRF sur les routes à jeton dans l'en-tête limité, mais clickjacking et lecture inter-origine possibles |
| M4 | Pas d'arrêt gracieux (`SIGTERM` ignoré), `uncaughtException` avalée, quatre `setInterval` de schedulers sans verrou distribué, auto-ping HTTP interne | `index.ts:15-150` | double exécution des jobs si deux instances tournent ; transactions coupées au redéploiement |
| M5 | Filtre anti-injection qui rejette l'apostrophe et le point-virgule | `middleware/validate.ts` | les noms « N'Guessan », « D'Almeida » sont refusés à l'inscription |
| M6 | Tout message contenant « not found » devient un 404, y compris des erreurs internes | `middleware/errorHandler.ts:70` | diagnostics faussés |
| M7 | Inscription sans vérification du téléphone (pas d'OTP) ; sessions de 24 h sans purge des sessions expirées | `routes/users.ts`, `routes/walletProduct.ts:52`, `lib/session*.ts` | faux comptes, table de sessions qui grossit |
| M8 | Documents KYC (images/base64) stockés dans la table `kyc_records` | `lib/db/src/schema/*` | PII lourde en base, sauvegardes volumineuses, exposition en cas de fuite SQL |
| M9 | Plusieurs tables sans clés étrangères ; `ledgerBalance` fait un `SUM` du ledger à chaque opération | `lib/db/src/schema/*`, `lib/walletService.ts` | dégradation linéaire avec le volume ; incohérences possibles |
| M10 | Pas de configuration SSL pour la connexion PostgreSQL | `lib/db/src/index.ts` | connexion en clair si l'hébergeur ne force pas TLS |
| M11 | `withDeadlockRetry` existe mais n'est jamais utilisé | `lib/walletService.ts` | verrous concurrents non rejoués |
| M12 | `GET /users` renvoie téléphone et e-mail de tous les utilisateurs aux rôles admin sans filtre de permission fine (`users.read` non appliqué à cette route) | `routes/users.ts:43-63` | tout opérateur voit tout l'annuaire |

## 5. Constats faibles et processus

- **F1** Aucune CI GitHub (`.github/` absent) : rien n'exécute `typecheck` ni les 6 suites sur une PR. Les seules vérifications automatiques sont les builds Vercel des front-ends.
- **F2** Pas de `pnpm-lock.yaml` : installations non reproductibles, `pnpm audit` inexploitable.
- **F3** Back-office : `hasPermission` existe mais n'est utilisé nulle part ; tous les menus sont visibles quel que soit le rôle (l'API refuse, mais l'expérience est trompeuse).
- **F4** Application mobile : jeton stocké dans `localStorage` **et** `sessionStorage` (`kowri-app/src/lib/auth.tsx:43-53`) ; un XSS suffit à le voler. Pas de rotation ni d'expiration côté client.
- **F5** `GET /api/admin/auth/roles` est public (liste des permissions par rôle). Peu sensible mais inutile à exposer.
- **F6** Node local 22 contre `engines.node 24.x` ; les suites tournent sur une version différente de la cible.

## 6. Plan de remédiation proposé (par ordre)

État : chantier A **livré le 13 septembre 2026** (voir le journal dans `kowri_audit_gaps_2026.md` ; suite `test-gating.mjs`, 335 routes, 0 ouverte). C1, C2, C3, E1, F5 et M1 sont clos.

1. **Chantier A — fermer les routes ouvertes** (C1, C2, C3, E1, F5) : ajouter `authenticate()` + `requirePermission` sur agents, fx, fx/liquidity, analytics, system, system/report, regulatory, fraud/intel, warroom, payment-routes, archive, product/architecture ; supprimer `/api/debug-build` ou le mettre derrière `requireAdmin` ; appliquer `experimental()` **et** `requireAdmin` sur settlements/connectors/clearing. Adapter les appels de l'application mobile (les écrans agents devront passer par une session agent authentifiée). Ajouter un test qui parcourt tous les routeurs et échoue si une route de mutation répond autre chose que 401/403 sans jeton.
2. **Chantier B — crédit** (E2, E3) : filtrer par `req.auth.userId`, créer un wallet plateforme identifié (`kowri_treasury`) et l'utiliser pour décaissement et remboursement, propager les erreurs au `errorHandler`.
3. **Chantier C — argent et devises** (E4, E5, E6, E7, M2) : plafonds KYC convertis par devise, limiteur par devise, payout de tontine basé sur le solde réel encaissé avec rejeu automatique, `executeFloatTransfer` dans une transaction unique, colonne d'idempotence dédiée pour les agents, parts de pool sur la valeur réelle.
4. **Chantier D — durcissement serveur** (M3, M4, M6, M10) : CORS liste blanche, `helmet`, limite de corps, arrêt gracieux, verrou de scheduler en base (`SELECT … FOR UPDATE SKIP LOCKED`), SSL Postgres.
5. **Chantier E — données et validation** (M5, M7, M8, M9, M11, M12) : assouplir le filtre, OTP à l'inscription, purge des sessions, stockage objet pour les documents KYC, clés étrangères manquantes, table de soldes matérialisés.
6. **Chantier F — processus** (F1 à F4, F6) : CI GitHub Actions (typecheck + 6 suites contre PostgreSQL), lockfile committé, menus du back-office filtrés par rôle, jeton mobile en `sessionStorage` seul avec expiration.

Chaque chantier est livrable séparément sur la même PR ou sur des PR successives, avec les suites existantes rejouées à chaque étape.
