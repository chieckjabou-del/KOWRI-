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

Variables d'environnement : voir `artifacts/api-server/.env.example` et `docs/SECURITY_SECRETS.md` (`DATABASE_URL`, `SIGNING_SECRET`, bootstrap du premier compte opérateur, `EXPERIMENTAL_MODULES`).

Réseau et exploitation :

- `CORS_ORIGINS` : origines navigateur autorisées à appeler l'API depuis un autre domaine (liste séparée par des virgules). Vide en production = aucune origine croisée, ce qui est le cas nominal puisque l'API sert les front-ends elle-même. À renseigner seulement si une prévisualisation Vercel ou une console partenaire doit appeler l'API à distance.
- `DATABASE_SSL` : TLS vers PostgreSQL, automatique en production pour un hôte non local (`require` pour forcer, `disable` pour couper, `DATABASE_SSL_REJECT_UNAUTHORIZED=false` pour une chaîne auto-signée).
- Arrêt : le serveur draine les requêtes en cours sur `SIGTERM` (délai `SHUTDOWN_TIMEOUT_S`, 15 s par défaut) ; configurer un délai d'arrêt au moins équivalent côté hébergeur.
- Plusieurs instances : les tâches planifiées se coordonnent par verrou consultatif PostgreSQL, il est donc possible de lancer l'API en plusieurs réplicas sans double exécution des jobs.

Migrations : `pnpm --filter @workspace/db migrate` (ou `push` sur une base de développement).

Trésorerie plateforme : les prêts sont décaissés depuis les wallets de l'utilisateur système `kowri_treasury` (un par devise, créés à la demande) et remboursés vers eux. En production ces wallets démarrent à zéro : lister leurs identifiants avec `GET /api/admin/treasury`, puis les approvisionner avec `POST /api/wallets/:id/deposit` (permission `ledger.write`). Tant qu'une devise n'est pas approvisionnée, les demandes de prêt dans cette devise répondent `503 TREASURY_LIQUIDITY`. Hors production, XOF et XAF sont amorcés automatiquement au premier démarrage.

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
