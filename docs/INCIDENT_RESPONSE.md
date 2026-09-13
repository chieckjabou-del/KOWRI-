# Runbook — Incidents financiers, litiges et remboursements

Cycle obligatoire : **DETECT → FREEZE → INVESTIGATE → RECONCILE → RESOLVE →
AUDIT**. Le ledger n'est jamais réécrit : une correction est une nouvelle
écriture, décidée à deux, tracée.

## 1. Détection (DETECT)

Sources qui ouvrent un incident, sans discussion :

| Signal | Origine |
|---|---|
| Alerte `reconciliation.anomaly` (critical) | Worker de réconciliation → `ALERT_WEBHOOK_URL` |
| Alerte `kill_switch.fired` / `kill_switch.forced_off` non planifiée | Autopilot ou opérateur |
| Alerte `cash_in.expired` répétée | Requêtes non traitées |
| Réclamation client : solde, transaction absente, montant erroné | Support |
| Écart de rapprochement bancaire | Réconciliation quotidienne |
| Comportement opérateur anormal (approbation hors horaires, série de requêtes vers un même bénéficiaire) | Revue des `audit_logs` |
| Indisponibilité base / API | Monitoring |

Ouvrir l'incident : identifiant, heure, signal, périmètre supposé, responsable.

## 2. Gel (FREEZE)

Le gel précède l'analyse. Choisir le plus petit gel qui couvre le doute :

| Doute | Gel | Commande |
|---|---|---|
| Création monétaire (cash-in) | Kill switch `cash_in` | `POST /api/admin/kill-switches/cash_in/force` (super_admin, MFA) |
| Un wallet précis | Gel du wallet | `PATCH /api/admin/wallets/:walletId/status` `{"status":"frozen"}` (wallets.manage) |
| Un client | Gel de **tous** ses wallets (il n'existe pas encore d'endpoint de suspension de compte client : P1 — POST-LAUNCH ; le statut compte ne change aujourd'hui que par la décision KYC) | Même route, pour chaque wallet du client |
| Un opérateur | Désactivation du compte (révoque toutes ses sessions) | `PATCH /api/admin/auth/users/:id` `{"status":"disabled"}` (admins.manage) |
| Transferts internes | Kill switch `outbound_transfers` | `.../outbound_transfers/force` |
| Tout | Kill switch `all` | `.../all/force` |

`force` (FORCED_OFF) plutôt que `fire` : seul un `lift` humain le rouvre.
Chaque gel est audité et alerté. Les requêtes cash-in `PENDING_APPROVAL`
restent en attente pendant le gel ; elles n'exécutent jamais d'elles-mêmes.

## 3. Investigation (INVESTIGATE)

Lecture seule. Outils :

- `GET /api/admin/reconciliation/report` — état global, anomalies nommées.
- `GET /api/admin/cash-in/:id` — requête, décisions, transaction liée.
- `GET /api/transactions/:id` (opérateur) — statut, entrées ledger.
- `audit_logs` — qui a fait quoi, quand, depuis quelle IP, sous quelle session
  (`select * from audit_logs where entity_id = '<id>' order by created_at`).
- `SELECT ... FROM ledger_entries WHERE transaction_id = '<id>'` — les deux
  jambes de chaque mouvement.
- Sauvegarde du jour restaurée à part (docs/DISASTER_RECOVERY.md) pour
  comparer un état antérieur sans toucher la production.

Questions à répondre par écrit : quel montant, quels comptes, quelle autorité
de dépôt, quels opérateurs, quelle fenêtre, la conservation tient-elle, la
base et le ledger sont-ils d'accord.

## 4. Réconciliation (RECONCILE)

Avant toute correction, établir la position exacte : pour chaque compte
touché, solde ledger, solde attendu, écart, cause. L'écart doit être expliqué
à 100 % par des écritures identifiées. Un écart non expliqué n'est pas
corrigé : le gel reste.

## 5. Résolution (RESOLVE)

### 5.1 Litige client (transaction contestée)

| Cas | Décision | Action |
|---|---|---|
| Transaction `completed`, ledger équilibré, initiée par le client (session, idempotency key à son nom) | Litige rejeté | Réponse au client avec référence, horodatage, contrepartie |
| Transaction `pending`/`processing` bloquée | Résoudre l'état | Suivre `checks.stuckTransactions` ; si irrécupérable : marquer `failed` par le chemin applicatif (jamais par SQL) |
| Transaction `failed` montrée comme succès dans un client | Défaut d'affichage | Corriger le client ; aucun mouvement |
| Mouvement non autorisé prouvé (compte compromis) | Remboursement | Contre-passation (5.3) + suspension + signalement |

### 5.2 Cash-in erroné (mauvais bénéficiaire, montant, doublon)

1. La requête `EXECUTED` ne se modifie pas.
2. Si les fonds n'ont pas bougé du wallet : contre-passation du dépôt
   (`authority = reversal`, référence `REV-<request id>`), décidée par deux
   opérateurs (`ledger.approve` + super_admin), consignée dans l'incident.
3. Si les fonds ont déjà été transférés : geler les wallets destinataires,
   récupérer ce qui peut l'être par contre-passation des transferts, constater
   la perte résiduelle dans le rapport d'incident (elle apparaît dans la
   trésorerie, jamais par réécriture du passif client).
4. Le doublon bancaire (une seule remise, deux requêtes) est impossible par
   construction si les références sont uniques ; s'il s'est produit via deux
   références, corriger par contre-passation de la seconde.

### 5.3 Contre-passation (reversal) — outillage

Outillage applicatif de contre-passation à deux signatures : **P1 —
POST-LAUNCH** (voir AKWE_LAUNCH_READINESS_GATE.md §11). Jusqu'à sa livraison,
la procédure transitoire est :

1. Décision écrite signée par deux personnes (responsable Finance +
   super_admin) : transaction visée, montant, motif, incident.
2. Exécution par un ingénieur habilité, en session SQL nommée, sous
   transaction, via `processDeposit`/`processTransfer` **applicatifs**
   (`npx tsx` script versionné dans `src/tools/`), jamais par `INSERT` direct
   dans `ledger_entries` : le trigger `transactions_deposit_authority` refuse
   de toute façon un dépôt sans autorité, et `ledger_float_debit_authority`
   refuse un débit du float hors dépôt autorisé.
3. Vérification immédiate du rapport de réconciliation (`ok = true`).
4. Entrée `audit_logs` et pièce jointe dans l'incident.

Toute personne qui contourne cette procédure (SQL direct sur le ledger) est
bloquée par les triggers ; une tentative apparaît dans les logs PostgreSQL et
doit être traitée comme incident de sécurité.

### 5.4 Remboursement d'un client

Un remboursement est un mouvement ledger ordinaire : transfert de la
trésorerie vers le wallet client (`processTransfer` depuis le wallet
trésorerie, référence `REFUND-<incident>`), décidé à deux, sous limite
(≤ montant contesté), tracé. Il n'existe pas de « crédit manuel » : la seule
création monétaire reste le cash-in maker-checker.

## 6. Audit (AUDIT)

Clôture d'incident = dossier contenant : chronologie, signaux, gels posés et
levés (avec les entrées `audit_logs`), analyse, position réconciliée avant /
après, écritures de résolution, décisionnaires, cause racine, action
corrective (code + test), date de levée des gels. Le journal
`kowri_audit_gaps_2026.md` reçoit une ligne. Rétention : 10 ans.

Levée d'un gel : `POST /api/admin/kill-switches/<name>/lift` par un
super_admin **différent** de celui qui a résolu, après lecture d'un rapport de
réconciliation `ok`. Toute levée est alertée (`kill_switch.lifted`).

## 7. Cas particuliers

- **Base indisponible pendant un cash-in** : la requête est soit
  `PENDING_APPROVAL`/`APPROVED` (rien crédité), soit `EXECUTED` avec sa
  transaction dans la même transaction SQL. Il n'existe pas d'état
  intermédiaire ; en cas de doute, `cashIn.ledgerMismatch` du rapport tranche.
- **Opérateur compromis** : suspension immédiate (révoque toutes ses
  sessions), rotation de ses accès, revue de toutes ses décisions des 30
  derniers jours dans `cash_in_decisions` et `audit_logs`, contre-passation
  des dépôts frauduleux prouvés, signalement.
- **Perte de la clé KYC** : docs/DISASTER_RECOVERY.md (les documents ne sont
  plus lisibles ; l'argent n'est pas affecté).
