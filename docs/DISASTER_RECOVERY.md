# Sauvegarde, restauration et reprise (DR)

Ce document décrit ce qui est **prouvé** par `artifacts/api-server/test-disaster-recovery.mjs` (exécuté en CI), ce que les opérateurs doivent faire, et les décisions qui restent à prendre. Il ne décrit pas un dispositif hébergeur (snapshots managés, réplication) : celui-ci dépend du fournisseur retenu et vient **en plus** de la sauvegarde logique décrite ici, jamais à sa place.

## 1. Ce qui est prouvé

| Preuve | Comment | Résultat attendu |
|---|---|---|
| Une sauvegarde logique se prend et se restaure | `scripts/db-backup.sh` (`pg_dump` format custom, instantané sérialisable) puis `scripts/db-restore.sh` dans une base vide | restauration + manifeste vérifié (comptes de lignes, migrations, masse monétaire) |
| La restauration est **fidèle** | comparaison de 17 agrégats avant/après : transactions, écritures, sommes débit/crédit, wallets et soldes, demandes de cash-in par statut, décisions, audit, clés d'idempotence, comptes et sessions opérateurs, KYC, références, migrations, triggers, fonctions | identiques |
| Les protections sont restaurées et **actives** | après restauration : modification d'une écriture, altération d'une demande de cash-in, suppression d'un audit → refusées par PostgreSQL | refus `append-only` / `CASH_IN_IMMUTABLE` / `APPEND_ONLY` |
| L'application repart sur la restauration | seconde instance API démarrée sur la base restaurée : sessions opérateur et utilisateur émises **avant** la sauvegarde valides, connexion par PIN, rapport de réconciliation propre, masse monétaire identique | OK |
| Les états en cours survivent | une demande de cash-in laissée `PENDING_APPROVAL` avant la sauvegarde est approuvée sur la restauration → `EXECUTED`, bénéficiaire crédité une fois ; une clé d'idempotence d'avant la sauvegarde rejoue la réponse sans second débit | OK |
| Les documents KYC survivent chiffrés | chiffrés dans le dump (aucun clair), lisibles avec la clé, illisibles sans (échec d'authentification GCM, jamais de sortie corrompue) | OK |
| La clé KYC se **rotate** | `src/tools/rotateKycKey.ts` rechiffre documents et secrets TOTP dans une transaction ; l'ancienne clé n'ouvre plus rien ; une mauvaise ancienne clé arrête tout sans rien écrire ; `--dry-run` n'écrit rien | OK |
| Perdre `SIGNING_SECRET` ne perd rien de financier | instance redémarrée avec un autre secret : sessions, soldes, ledger et documents (avec `KYC_ENCRYPTION_KEY`) intacts | OK |
| Un dump altéré n'est pas restauré | un octet ajouté → `CHECKSUM MISMATCH`, arrêt avant toute écriture | OK |
| Une restauration n'écrase jamais de l'argent vivant | cible contenant déjà des écritures → refus | OK |

Les corruptions injectées à la main dans la base restaurée (section CR de la suite) sont documentées dans `AKWE_P0_FINANCIAL_CONTROL_GATE.md` §10.

## 2. Secrets et clés : ce qui doit être sauvegardé

| Élément | Où | Si perdu | Sauvegarde |
|---|---|---|---|
| Dump PostgreSQL | stockage objet hors site, chiffré côté stockage | perte de tout l'historique depuis le dump précédent | quotidien au minimum (voir §4) |
| `KYC_ENCRYPTION_KEY` | coffre / KMS, **jamais** dans le dump ni dans git | documents d'identité et secrets TOTP **définitivement illisibles** (prouvé : aucun autre chemin) → tous les opérateurs doivent réenrôler leur second facteur, tous les KYC sont à refaire | escrow séparé du dump, deux détenteurs, rotation possible avec `rotateKycKey.ts` |
| `SIGNING_SECRET` | env | requêtes internes signées en vol et codes OTP en attente invalidés ; en développement sans `KYC_ENCRYPTION_KEY`, la clé KYC dérivée est perdue (c'est pourquoi la clé explicite est obligatoire en production) | escrow ; rotation = déploiement simultané sur toutes les instances |
| `DATABASE_URL` | env | aucun impact sur les données | recréer un rôle |
| Mots de passe / TOTP opérateurs | dans le dump (hachés / chiffrés) | rien à faire | inclus |
| `ADMIN_API_KEY` | env | à retirer de toute façon | — |

Règle : **un dump sans `KYC_ENCRYPTION_KEY` restaure l'argent mais pas les identités.** Les deux se sauvegardent séparément et se testent ensemble (la suite le fait).

## 3. Procédures

### 3.1 Sauvegarde

```
scripts/db-backup.sh "$DATABASE_URL" /backups/kowri
```

Produit `kowri-<horodatage>.dump`, son `.sha256` et un `manifest.json` (migrations appliquées, comptes, masse monétaire par devise). Copier les trois fichiers hors site. Le dump contient les triggers, fonctions et le journal de migrations `drizzle.__drizzle_migrations` : la base restaurée est directement au bon niveau de schéma.

### 3.2 Restauration (exercice ou incident)

```
psql "$MAINTENANCE_URL" -c 'create database kowri_restore owner kowri'
scripts/db-restore.sh /backups/kowri/kowri-<horodatage>.dump "postgres://…/kowri_restore"
```

Le script refuse un dump dont le checksum ne correspond pas, refuse une cible qui contient déjà un ledger, et sort en erreur si le manifeste ne correspond pas. Puis : pointer une instance API sur la base restaurée avec `KYC_ENCRYPTION_KEY` et `SIGNING_SECRET`, lire `GET /api/admin/reconciliation/report` (doit être `ok: true`), vérifier que les demandes de cash-in `PENDING_APPROVAL` sont bien là (`GET /api/admin/cash-in?status=PENDING_APPROVAL`), puis basculer le trafic.

### 3.3 Rotation de `KYC_ENCRYPTION_KEY`

```
cd artifacts/api-server
DATABASE_URL=… KYC_ENCRYPTION_KEY_OLD=<ancienne> KYC_ENCRYPTION_KEY=<nouvelle> npx tsx src/tools/rotateKycKey.ts --dry-run
DATABASE_URL=… KYC_ENCRYPTION_KEY_OLD=<ancienne> KYC_ENCRYPTION_KEY=<nouvelle> npx tsx src/tools/rotateKycKey.ts
```

Puis déployer la nouvelle clé sur toutes les instances. `KYC_ENCRYPTION_KEY_OLD` accepte plusieurs clés séparées par des virgules (`dev` = clé de développement dérivée du `SIGNING_SECRET` courant, `dev:<secret>` = dérivée d'un autre secret) pour une base écrite sous plusieurs clés. Une ligne qu'aucune ancienne clé n'ouvre arrête l'outil sans rien écrire.

### 3.4 Exercice périodique

Rejouer `node test-disaster-recovery.mjs` contre une copie de production (variables `DATABASE_URL`, `DR_ADMIN_URL`, `KYC_ENCRYPTION_KEY`, `SIGNING_SECRET`), ou au minimum §3.2 sur le dernier dump. Un exercice qui n'a pas été fait depuis plus d'un mois doit être considéré comme une sauvegarde non prouvée.

## 4. RPO / RTO — propositions à valider

Ce sont des **propositions**, pas des engagements : elles dépendent de l'hébergeur et du budget.

| Objectif | Proposition | Ce que ça implique |
|---|---|---|
| RPO (perte maximale) | **15 minutes** | archivage WAL continu (PITR) chez l'hébergeur ou `wal-g`/`pgBackRest` ; le dump logique quotidien seul donne un RPO de 24 h |
| RTO (retour en service) | **2 heures** | dump ≤ quelques Go, restauration mesurée à quelques minutes ; le reste est le temps humain (décision, secrets, bascule DNS) |
| Rétention | 35 jours de dumps + 7 jours de WAL | obligations réglementaires à confirmer (conservation des journaux financiers souvent 5–10 ans → archivage long des dumps mensuels) |
| Fréquence de l'exercice | mensuel | la suite automatisée le fait en CI sur une base de test ; l'exercice sur copie de production reste manuel |

Pendant une restauration, les demandes de cash-in initiées après le dernier point de sauvegarde et non encore exécutées sont perdues ; leur preuve externe (référence bancaire) permet de les refiler. Les demandes exécutées après le point de sauvegarde le sont aussi : c'est exactement ce que le RPO mesure et pourquoi le PITR est proposé.

## 5. Ce qui n'est pas couvert

- Réplication et bascule automatique : dépendent de l'hébergeur.
- Sauvegarde du stockage objet éventuel (aucun aujourd'hui : les documents sont en base).
- Perte simultanée du dump et de la clé : rien ne peut être récupéré, par construction.
- Les tables `metrics`, `incidents`, `event_log` sont sauvegardées mais ne font pas partie des agrégats vérifiés (elles ne portent pas d'argent).
