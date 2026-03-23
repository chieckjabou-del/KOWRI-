# KOWRI V5.0 — Audit Complet Fonctionnalités Tontines

**Date :** 23 mars 2026  
**Périmètre :** Toutes les fonctionnalités tontines dans le code source  
**Projet :** KOWRI Financial Super-App

---

## 1. ROUTES API TONTINES

### routes/tontines.ts → monté sur `/api/tontines`

| Méthode | Chemin | Fichier:Ligne | Description |
|---------|--------|---------------|-------------|
| `GET` | `/api/tontines` | tontines.ts:21 | Liste toutes les tontines — paginée, filtrable par `status` |
| `POST` | `/api/tontines` | tontines.ts:49 | Crée une tontine + enrôle l'admin comme membre #1 |
| `GET` | `/api/tontines/:tontineId` | tontines.ts:87 | Détail : tontine + liste membres (jointure noms) + totalContributed |

### routes/communityFinance.ts → monté sur `/api/community`

| Méthode | Chemin | Fichier:Ligne | Description |
|---------|--------|---------------|-------------|
| `POST` | `/api/community/tontines/:id/activate` | communityFinance.ts:29 | Active une tontine pending, crée le wallet pool, assigne l'ordre de paiement, crée le job scheduler |
| `POST` | `/api/community/tontines/:id/members` | communityFinance.ts:69 | Ajoute un membre (vérif capacité + dédoublonnage) |
| `POST` | `/api/community/tontines/:id/collect` | communityFinance.ts:102 | Cycle de cotisation — débit wallet de chaque membre (clé d'idempotence requise) |
| `POST` | `/api/community/tontines/:id/payout` | communityFinance.ts:114 | Cycle de paiement au prochain bénéficiaire (clé d'idempotence requise) |
| `GET` | `/api/community/tontines/:id/schedule` | communityFinance.ts:126 | Planning complet tour par tour avec dates projetées |
| `POST` | `/api/community/tontines/:id/bids` | communityFinance.ts:166 | Soumettre une enchère pour un slot de paiement anticipé (modèle auction) |
| `GET` | `/api/community/tontines/:id/bids` | communityFinance.ts:186 | Lister les enchères triées par montant décroissant |
| `POST` | `/api/community/tontines/:id/positions/list` | communityFinance.ts:196 | Mettre en vente un slot sur le marché secondaire |
| `GET` | `/api/community/tontines/:id/positions/market` | communityFinance.ts:213 | Voir les listings ouverts pour une tontine |
| `POST` | `/api/community/tontines/positions/:listingId/buy` | communityFinance.ts:226 | Acheter un slot listé : transfert wallet P2P + swap de membre |
| `GET` | `/api/community/tontines/positions` | communityFinance.ts:238 | Marché secondaire global — tous listings ouverts, paginé |
| `GET` | `/api/community/reputation/:userId` | communityFinance.ts:260 | Lire le score de réputation en cache |
| `POST` | `/api/community/reputation/:userId/compute` | communityFinance.ts:272 | Recalculer le score de réputation depuis l'activité tontine + prêts |
| `GET` | `/api/community/scheduler/jobs` | communityFinance.ts:285 | Liste les 50 derniers jobs scheduler |

### routes/admin.ts → monté sous le routeur admin

| Méthode | Chemin | Fichier:Ligne | Description |
|---------|--------|---------------|-------------|
| `POST` | `/api/admin/patch-tontines` | admin.ts:85 | Exécute `patchTontineMembers()` — backfille les membres seed du pool "Abidjan Traders" |

---

## 2. TABLES BASE DE DONNÉES TONTINES

| Table | Fichier schéma | Colonnes importantes |
|-------|----------------|----------------------|
| `tontines` | schema/tontines.ts:9 | `id, name, description, contribution_amount (numeric 20,4), currency, frequency (enum), max_members, member_count, current_round, total_rounds, status (enum), admin_user_id, wallet_id, next_payout_date` |
| `tontine_members` | schema/tontines.ts:24 | `id, tontine_id, user_id, payout_order, has_received_payout (0=non / 1=oui / 2=en-cours verrou), contributions_count, joined_at` |
| `tontine_position_listings` | schema/phase7.ts:203 | `id, tontine_id, seller_id, payout_order, ask_price, currency, status (open/processing/sold), buyer_id, transaction_id, expires_at, sold_at` |
| `tontine_bids` | schema/phase7.ts:222 | `id, tontine_id, user_id, bid_amount, desired_position, status (pending/resolved), round_number, resolved_at` |
| `reputation_scores` | schema/phase7.ts:238 | `user_id, score, contribution_rate, repayment_rate, tontine_score (max 25 pts), tier (new/bronze/silver/gold/platinum)` |
| `scheduler_jobs` | schema/phase7.ts:295 | `id, job_type (tontine_contribution / tontine_payout), entity_id, scheduled_at, status, attempts, max_attempts, error` |
| `credit_scores` | schema/credit.ts:20 | Colonne `tontine_participation` (poids 20% dans le score crédit composite) |
| `wallets` | schema/wallets.ts:8 | Enum `wallet_type` inclut **"tontine"** (wallets pool) |
| `transactions` | schema/transactions.ts:8 | Enum `transaction_type` inclut **"tontine_contribution"** et **"tontine_payout"** |

---

## 3. FONCTIONS MÉTIER TONTINES

### lib/tontineScheduler.ts

| Fonction | Ligne | Ce qu'elle fait |
|----------|-------|-----------------|
| `runContributionCycle(tontineId)` | :16 | Pour chaque membre : débit wallet perso → wallet pool. Gère les échecs partiels. Publie event `tontine.contributions.collected`. Crée job payout automatiquement. |
| `runPayoutCycle(tontineId)` | :72 | Verrou optimiste (`hasReceivedPayout=2`). Transfère `contributionAmount × memberCount` au prochain bénéficiaire. Avance `currentRound`. Marque `completed` si dernier tour. Audit log + event. |
| `computeNextDate(frequency)` | :156 | Calcule la prochaine date : weekly+7j / biweekly+14j / monthly+1mois |
| `assignPayoutOrder(tontineId, model)` | :164 | 4 modèles : **fixed** (no-op), **random** (CSPRNG randomBytes), **auction** (tri par montant d'enchère → bids résolus), **admin** (stub — ne fait rien) |
| `listPositionForSale(params)` | :196 | Vérifie l'absence de listing ouvert existant. Insère dans `tontine_position_listings`. Publie event `tontine.position.listed`. |
| `buyTontinePosition(listingId, buyerId)` | :221 | Verrou optimiste (`status=processing`). Transfert P2P buyer→seller. Swap `userId` dans `tontine_members`. Marque `sold`. Rollback automatique sur erreur. |
| `createSchedulerJob(...)` | :285 | Insère un job dans `scheduler_jobs` (status=pending) |
| `getPendingJobs(jobType?)` | :294 | Lit les jobs pending triés par date. **Non appelée nulle part — aucun processus ne la consomme.** |

### lib/reputationEngine.ts

| Fonction | Ligne | Ce qu'elle fait |
|----------|-------|-----------------|
| `computeReputationScore(userId)` | :20 | Agrège tontine_score (max 25 pts), contribution_rate, repayment_rate, longevity, regularity, reciprocity → score 0–100 → tier |
| `getReputationScore(userId)` | :108 | Lecture directe en DB (pas de recalcul) |
| `computeCreditScoreFromActivity(userId)` | :114 | `tontineParticipation` = 20% du score crédit composite |

### lib/seed.ts

| Fonction | Ligne | Ce qu'elle fait |
|----------|-------|-----------------|
| `patchTontineMembers()` | :292 | Backfille les membres de "Abidjan Traders Pool" si < 6 membres en base |

---

## 4. TYPES DE TONTINES SUPPORTÉS

### Fréquences (enum Postgres `tontine_frequency`)
- `weekly` — cycle de 7 jours
- `biweekly` — cycle de 14 jours
- `monthly` — cycle d'un mois

### Statuts (enum Postgres `tontine_status`)
- `pending` → état initial à la création
- `active` → après activation (pool wallet créé, scheduler démarré)
- `completed` → automatiquement défini quand tous les tours sont terminés

> ⚠️ **"cancelled"** est accepté dans le guard de validation du router (`tontines.ts:19`)  
> mais **absent de l'enum Postgres** → toute écriture avec ce statut lèverait une erreur DB.

### Modèles de rotation (TypeScript uniquement — `RotationModel`)
- `fixed` — ordre d'inscription conservé (défaut)
- `random` — ordre aléatoire cryptographique (CSPRNG via `randomBytes`)
- `auction` — le plus offrant obtient le slot le plus tôt
- `admin` — accepté comme valeur valide, mais ne fait rien (stub)

### Statuts listings secondaires
- `open` → en vente
- `processing` → achat en cours (verrou optimiste)
- `sold` → vendu

### Statuts enchères
- `pending` → soumise, en attente de résolution
- `resolved` → résolue à l'activation de la tontine

---

## 5. FONCTIONNALITÉS MARCHÉ SECONDAIRE

### Tables en base
| Table | Description |
|-------|-------------|
| `tontine_position_listings` | Listings de vente de slots — colonnes : tontineId, sellerId, payoutOrder, askPrice, buyerId, transactionId, expiresAt, soldAt |
| `tontine_bids` | Enchères pour prise de position anticipée — colonnes : tontineId, userId, bidAmount, desiredPosition, status, roundNumber, resolvedAt |

### Routes opérationnelles (marché secondaire)
| Route | Statut | Description |
|-------|--------|-------------|
| `POST /api/community/tontines/:id/positions/list` | LIVE | Crée un listing (anti-doublon) |
| `GET /api/community/tontines/:id/positions/market` | LIVE | Listings ouverts par tontine |
| `GET /api/community/tontines/positions` | LIVE | Marché global paginé |
| `POST /api/community/tontines/positions/:listingId/buy` | LIVE | Achat : transfert P2P + swap slot + rollback |
| `POST /api/community/tontines/:id/bids` | LIVE | Soumettre une enchère |
| `GET /api/community/tontines/:id/bids` | LIVE | Voir les enchères |

### Fonctions
| Fonction | Fichier:Ligne | Statut |
|----------|---------------|--------|
| `listPositionForSale()` | tontineScheduler.ts:196 | LIVE — avec verrou anti-doublon |
| `buyTontinePosition()` | tontineScheduler.ts:221 | LIVE — avec verrou optimiste et rollback |

---

## 6. STATUT PAR FONCTIONNALITÉ (LIVE / PARTIAL / STUB)

| Fonctionnalité | Statut | Notes |
|----------------|--------|-------|
| Créer une tontine | **LIVE** | Enrôle l'admin automatiquement |
| Lister / filtrer les tontines | **LIVE** | Pagination + filtre par status |
| Détail tontine + membres | **LIVE** | Jointure avec les noms d'utilisateurs |
| Rejoindre une tontine | **LIVE** | Vérif capacité + dédoublonnage |
| Activer une tontine | **LIVE** | Crée pool wallet, assigne ordre, schedule job |
| Cycle de cotisation | **LIVE** | Débits partiels tolérés, idempotent |
| Cycle de paiement | **LIVE** | Verrou optimiste, rollback, auto-completion |
| Planning des tours | **LIVE** | Dates projetées par fréquence |
| Rotation **fixed** | **LIVE** | Ordre d'inscription conservé |
| Rotation **random** | **LIVE** | CSPRNG (`randomBytes`) |
| Rotation **auction** | **LIVE** | Bids résolus à l'activation |
| Rotation **admin** | **STUB** | Branche `else { return }` — ne fait rien |
| Marché secondaire — listing | **LIVE** | Anti-doublon par seller+tontine |
| Marché secondaire — achat | **LIVE** | Transfert P2P + swap slot + rollback |
| Enchères (bids) | **PARTIAL** | Bids stockés et listables ; pas de mécanisme d'attribution automatique sur le marché secondaire |
| Score de réputation | **LIVE** | 5 composantes, tier calculé |
| Impact tontine sur crédit | **LIVE** | 20% du score crédit composite |
| Exécution automatique scheduler | **MANQUANT** | `getPendingJobs()` existe mais n'est jamais appelée |
| Expiration des listings | **MANQUANT** | `expires_at` stocké, jamais vérifié ni enforced |
| Quitter une tontine | **MANQUANT** | Aucune route DELETE /members/:userId |
| Annuler une tontine | **MANQUANT** | Status "cancelled" hors de l'enum DB |
| Notifications temps-réel | **MANQUANT** | `eventBus.publish()` appelé partout, zéro subscriber |

---

## 7. CE QUI MANQUE COMPLÈTEMENT

### 1. Scheduler automatique — CRITIQUE
`getPendingJobs()` existe dans `tontineScheduler.ts:294` mais **n'est jamais appelée**.  
Aucun `setInterval`, `cron`, ni worker dans `app.ts` ou `outboxWorker.ts` ne déclenche les cycles.  
Les jobs `tontine_contribution` et `tontine_payout` s'accumulent dans la table `scheduler_jobs` sans jamais s'exécuter.  
**Les cycles doivent être déclenchés manuellement via API.**

### 2. Modèle de rotation `admin` — STUB
Dans `assignPayoutOrder()` (tontineScheduler.ts:183), la branche `admin` tombe dans le `else { return }`.  
Le modèle est accepté comme valeur valide mais ne produit aucun effet — l'ordre reste celui de l'inscription.

### 3. Status `cancelled` — INCOHÉRENCE SCHEMA
Le guard de validation dans `tontines.ts:19` liste `"cancelled"` comme statut valide.  
L'enum Postgres `tontine_status` ne contient que `pending | active | completed`.  
Toute tentative d'écrire le statut `cancelled` lèverait une erreur de contrainte DB.

### 4. Expiration des listings — FONCTIONNALITÉ MORTE
La colonne `expires_at` est stockée sur `tontine_position_listings`.  
Aucun processus ne vérifie ni n'expire les listings périmés.  
Un listing avec `expires_at` dans le passé reste ouvert indéfiniment.

### 5. Quitter une tontine — ABSENT
Aucune route `DELETE /api/tontines/:id/members/:userId` n'existe.  
Un membre ne peut pas quitter une tontine une fois inscrit.

### 6. Annuler une tontine — ABSENT
Aucune route ni logique pour passer une tontine en `cancelled`, stopper le scheduler, et rembourser les membres.

### 7. Event Bus sans subscribers — FONCTIONNALITÉ MORTE
`eventBus.publish()` est appelé sur : `tontine.contributions.collected`, `tontine.payout.completed`, `tontine.rotation.assigned`, `tontine.position.listed`, `tontine.position.sold`.  
Aucun subscriber n'est enregistré dans le codebase — les événements sont émis dans le vide.

### 8. Bids du marché secondaire sans résolution
Le système d'enchères (`tontine_bids`) sert deux usages distincts :
- **Activation** : bids résolus lors de `assignPayoutOrder()` en mode `auction` → LIVE
- **Marché secondaire** : bids soumis et listables mais sans mécanisme d'attribution automatique → PARTIAL

Il n'existe pas de route pour "résoudre" des enchères sur des listings du marché secondaire.

---

*Document généré automatiquement depuis le code source KOWRI V5.0 — 23 mars 2026*
