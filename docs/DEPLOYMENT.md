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

Migrations : `pnpm --filter @workspace/db migrate` (ou `push` sur une base de développement).

## Vercel

Le dépôt est relié à trois projets Vercel. Leur rôle :

| Projet Vercel | Répertoire racine | Rôle |
|---|---|---|
| `kowri-app` | `artifacts/kowri-app` | prévisualisation statique de l'application mobile |
| `kowri-kowri-dashboard` | doit être `artifacts/kowri-dashboard` | prévisualisation statique du back-office |
| `kowri-api-server` | `artifacts/api-server` | **aucun** : les builds sont ignorés (`ignoreCommand` dans `artifacts/api-server/vercel.json`) ; déconnecter ce projet |

Chaque `vercel.json` force l'installation et le build via pnpm (`npx pnpm@10.33.0`), car Vercel retombe sur npm sans lockfile et npm ne comprend pas les protocoles `workspace:` / `catalog:`.

Réglages requis côté Vercel pour les deux projets front-end :

- « Include source files outside of the Root Directory » activé (le build a besoin de la racine du workspace pour `pnpm-workspace.yaml`, les catalogues et `lib/*`). Ce réglage n'est pas pilotable depuis le dépôt.
- Node.js 24 : imposé par `engines.node` dans le `package.json` de chaque artefact, ce qui prime sur le réglage du projet Vercel (Node 20 est déprécié par Vercel à partir du 1er octobre 2026).

Limite : une prévisualisation Vercel n'embarque pas l'API. Les appels `/api` y échouent tant qu'aucune réécriture vers l'URL de l'API n'est configurée (ou `VITE_API_BASE` pour la file hors-ligne). Ces prévisualisations servent à vérifier l'interface, pas les parcours de bout en bout.
