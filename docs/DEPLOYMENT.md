# Déploiement

## Topologie

KOWRI est un **monolithe servi par le serveur API** :

- `artifacts/api-server` (Express) expose `/api/*` **et** sert les front-ends compilés (`artifacts/kowri-app/dist`, `artifacts/kowri-dashboard/dist/public`) depuis le même processus.
- Les front-ends appellent l'API en relatif (`/api`), donc sur la même origine que la page.
- Le serveur porte des tâches de fond permanentes : scheduler de tontines, worker outbox, autopilot, auto-ping. Il doit tourner comme un **processus long** (Railway, Render, VM, conteneur), pas comme une fonction serverless.

## Serveur API (Railway ou équivalent)

Commandes définies à la racine du monorepo :

```
pnpm install --no-frozen-lockfile     # le dépôt ne fournit pas de lockfile
pnpm run railway-build                # build de lib/db puis bundle esbuild -> artifacts/api-server/dist/index.cjs
pnpm run start:api-server             # node artifacts/api-server/dist/index.cjs
```

Pour servir aussi les interfaces depuis l'API, construire les front-ends avant le démarrage :

```
pnpm --filter @workspace/api-server run build:frontends
```

Variables d'environnement : voir `artifacts/api-server/.env.example` et `docs/SECURITY_SECRETS.md` (`DATABASE_URL`, `SIGNING_SECRET`, bootstrap du premier compte opérateur, `EXPERIMENTAL_MODULES`). Pour un lancement contrôlé, partir de `.env.launch.example` à la racine : en production le processus **refuse de démarrer** sans `LAUNCH_MODULES`, sans les sept limites `CASH_IN_*` explicites et sans `ALERT_WEBHOOK_URL` (voir `AKWE_LAUNCH_READINESS_GATE.md`).

Réseau et exploitation :

- `CORS_ORIGINS` : origines navigateur autorisées à appeler l'API depuis un autre domaine (liste séparée par des virgules). Vide en production = aucune origine croisée, ce qui est le cas nominal puisque l'API sert les front-ends elle-même. À renseigner seulement si une prévisualisation Vercel ou une console partenaire doit appeler l'API à distance.
- `DATABASE_SSL` : TLS vers PostgreSQL, automatique en production pour un hôte non local (`require` pour forcer, `disable` pour couper, `DATABASE_SSL_REJECT_UNAUTHORIZED=false` pour une chaîne auto-signée).
- Arrêt : le serveur draine les requêtes en cours sur `SIGTERM` (délai `SHUTDOWN_TIMEOUT_S`, 15 s par défaut) ; configurer un délai d'arrêt au moins équivalent côté hébergeur.
- Plusieurs instances : les tâches planifiées se coordonnent par verrou consultatif PostgreSQL, il est donc possible de lancer l'API en plusieurs réplicas sans double exécution des jobs.

Migrations : `pnpm --filter @workspace/db migrate` (ou `push` sur une base de développement). Quatre migrations à ce jour : `0000` (schéma initial), `0001` (comptes opérateurs), `0002` (codes de vérification de téléphone), `0003` (durcissement du grand livre : contraintes de montants, journal immuable, équilibre débit/crédit et interdiction de découvert vérifiés par PostgreSQL à la validation de chaque transaction, second facteur opérateur, empreinte des requêtes idempotentes). Les contraintes `CHECK` de `0003` sont posées `NOT VALID` pour ne pas bloquer une base existante ; les valider une fois l'historique vérifié (`ALTER TABLE … VALIDATE CONSTRAINT …`).

Opérateurs et second facteur : en production `ADMIN_MFA_REQUIRED` vaut `true` par défaut. Un opérateur se connecte avec mot de passe puis, une fois enrôlé (`POST /api/admin/auth/mfa/setup` puis `/mfa/confirm`, ou depuis l'écran de connexion du back-office), doit présenter son code TOTP à chaque connexion. Une session sans second facteur, comme la clé partagée `ADMIN_API_KEY`, est en lecture seule : aucun cash-in, aucune revue KYC, aucun changement de frais ni de kill switch n'est possible sans code. La perte d'un authentificateur se règle par `POST /api/admin/auth/users/:id/mfa/reset` (permission `admins.manage`).

Données de démonstration : les fixtures (vingt comptes au PIN `1234`, wallets approvisionnés) ne sont créées qu'en dehors de la production. `ALLOW_DEMO_SEED=true` force leur création et est refusé par la revue des secrets en production.

Réconciliation financière : `GET /api/admin/reconciliation/report` rejoue les invariants du modèle monétaire (équilibre de chaque transaction, aucune écriture négative ou vide, aucun wallet à découvert, solde matérialisé égal au grand livre, aucune opération bloquée en `pending`, aucun transfert de float en `PENDING`, aucune paire de change permettant un aller-retour gagnant) et donne la masse monétaire par devise (passif utilisateurs, trésorerie, float plateforme, frais, compte FX, float agents). Le même rapport tourne toutes les six heures et consigne chaque anomalie dans `incidents`. Les transferts de float interrompus par un arrêt brutal sont repris automatiquement au démarrage et toutes les cinq minutes (`POST /api/admin/reconciliation/recover-float` pour forcer).

Inscription et données personnelles :

- `PHONE_VERIFICATION=required` (défaut en production) impose un code SMS avant toute création de compte ; brancher une passerelle avec `SMS_PROVIDER=http`, `SMS_WEBHOOK_URL` (reçoit un POST JSON `{to, message}`) et `SMS_WEBHOOK_TOKEN`. Sans fournisseur, le démarrage en production est refusé.
- `KYC_ENCRYPTION_KEY` (32 octets hex, `openssl rand -hex 32`) chiffre les documents d'identité en base. Obligatoire en production ; la perdre rend les documents déjà stockés illisibles, la conserver dans le gestionnaire de secrets au même titre que `SIGNING_SECRET`.

Trésorerie plateforme : les prêts sont décaissés depuis les wallets de l'utilisateur système `kowri_treasury` (un par devise, créés à la demande) et remboursés vers eux. En production ces wallets démarrent à zéro : lister leurs identifiants avec `GET /api/admin/treasury`, puis les approvisionner par le maker-checker de cash-in : `POST /api/admin/cash-in` (opérateur `ledger.write`) puis `POST /api/admin/cash-in/:id/approve` par un **autre** opérateur (`ledger.approve`), ou depuis l'écran « Cash-in » du back-office. La route directe `POST /api/wallets/:id/deposit` répond désormais `410`. Tant qu'une devise n'est pas approvisionnée, les demandes de prêt dans cette devise répondent `503 TREASURY_LIQUIDITY`. Hors production, XOF et XAF sont amorcés automatiquement au premier démarrage.

## Intégration continue

`.github/workflows/ci.yml` s'exécute sur chaque pull request et sur `main` : typecheck et build des deux front-ends d'un côté ; de l'autre, un PostgreSQL 16 de service reçoit les migrations versionnées, l'API démarre et les huit suites (`test-gating`, `test-integrity`, phases 3 à 7, `test-adversarial`) sont rejouées, puis l'arrêt gracieux est vérifié. La suite adversariale rejoue les attaques de l'audit d'infrastructure financière (double dépense, plafonds en concurrence, prêts et remboursements simultanés, aller-retour de change, idempotence, reprise après crash, invariants imposés par PostgreSQL) et échoue si l'une d'elles redevient possible. Une PR dont la CI est rouge ne doit pas être fusionnée. Le dépôt ne fournit pas de lockfile, la CI installe donc avec `--no-frozen-lockfile`.

## Vercel

Le dépôt est relié à trois projets Vercel. Leur rôle :

| Projet Vercel | Répertoire racine | Rôle |
|---|---|---|
| `kowri-dashboard` | `artifacts/kowri-dashboard` | prévisualisation statique du back-office (projet créé le 13 septembre 2026, réglages par défaut corrects) |
| `kowri-kowri-dashboard` | `artifacts/kowri-app` | malgré son nom, prévisualisation statique de l'**application mobile** (seul ancien projet dont les réglages sont bons) ; à renommer `kowri-app-web` |
| `kowri-app` | `artifacts/kowri-app` | **à conserver** : porte le déploiement de production de l'application mobile (build d'avril 2026, encore servi sur son URL). L'inclusion des fichiers hors répertoire racine a été activée le 13 septembre 2026 pour que ses builds de branche repartent |
| `kowri-api-server` | `artifacts/api-server` | **supprimable** : aucun déploiement n'a jamais réussi, aucun domaine personnalisé ; les builds sont ignorés (`ignoreCommand` dans `artifacts/api-server/vercel.json`). Exporter ses variables d'environnement avant suppression |

Chaque `vercel.json` force l'installation et le build via pnpm (`npx pnpm@10.33.0`), car Vercel retombe sur npm sans lockfile et npm ne comprend pas les protocoles `workspace:` / `catalog:`.

Réglages requis côté Vercel pour les deux projets front-end :

- « Include source files outside of the Root Directory » activé (le build a besoin de la racine du workspace pour `pnpm-workspace.yaml`, les catalogues et `lib/*`). Ce réglage n'est pas pilotable depuis le dépôt.
- Node.js 24 : imposé par `engines.node` dans le `package.json` de chaque artefact, ce qui prime sur le réglage du projet Vercel (Node 20 est déprécié par Vercel à partir du 1er octobre 2026).

Limite : une prévisualisation Vercel n'embarque pas l'API. Les appels `/api` y échouent tant qu'aucune réécriture vers l'URL de l'API n'est configurée (ou `VITE_API_BASE` pour la file hors-ligne). Ces prévisualisations servent à vérifier l'interface, pas les parcours de bout en bout.
