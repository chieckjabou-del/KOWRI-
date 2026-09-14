# Runbook — Réconciliation financière quotidienne

Statut : **procédure obligatoire au lancement contrôlé**. Une journée sans
réconciliation signée est une journée sans preuve que l'argent des clients
est là. Ce runbook fixe la fréquence, le propriétaire, les seuils, l'escalade,
le blocage, la résolution, la rétention et la trace d'audit.

## 1. Ce qui est réconcilié

| Objet | Source A | Source B | Invariant |
|---|---|---|---|
| Passif clients | Somme des soldes wallets clients (ledger) | `supply.userLiabilities` du rapport | Identique, par devise |
| Création monétaire | Dépôts `authority = cash_in_request` (ledger) | `cash_in_requests` en statut `EXECUTED` | 1 requête EXECUTED ⇔ 1 transaction `cash-in:<id>` ; totaux égaux (`cashIn.executedTotal`, `cashIn.ledgerMismatch = []`) |
| Conservation | `created − destroyed` | `liabilities + treasury + fees + fx` | `conservationGap = 0` par devise (I10) |
| Fonds réels | Relevés bancaires / mobile money des comptes de collecte | Somme des requêtes `EXECUTED` du jour, par source et référence | Chaque référence bancaire a exactement une requête ; chaque requête EXECUTED a un mouvement bancaire |
| Trésorerie plateforme | Solde ledger `platform_float`, trésorerie | Capital déclaré par la direction | Écart expliqué et signé |
| Intégrité | I1–I16 (`GET /admin/reconciliation/report`) | — | `ok = true`, `anomalies = []` |

Le rapport est produit par `GET /api/admin/reconciliation/report` (opérateur
authentifié, session MFA vérifiée en production) et, toutes les six heures,
par le worker `scheduledFinancialReconciliation` qui écrit une entrée
`reconciliation.report` dans `audit_logs` et envoie une alerte `critical`
(`reconciliation.anomaly`) sur `ALERT_WEBHOOK_URL` dès qu'une anomalie
apparaît.

## 2. Fréquence et propriétaire

| Contrôle | Fréquence | Propriétaire | Suppléant |
|---|---|---|---|
| Rapport automatique | Toutes les 6 h (worker) | Système | — |
| Réconciliation quotidienne signée | Chaque jour ouvré avant 10:00 (J pour J−1) | Responsable Finance / Conformité (**à nommer**) | Second opérateur `compliance` |
| Rapprochement bancaire des cash-in | Chaque jour avec la réconciliation | Même propriétaire | — |
| Revue hebdomadaire | Lundi | CTO + Finance | — |

Le nom du propriétaire et du suppléant doit être inscrit ici avant le
lancement : **DECISION REQUIRED**.

## 3. Procédure quotidienne (J pour J−1)

1. Se connecter au back-office avec une session MFA vérifiée.
2. Ouvrir le rapport : `GET /api/admin/reconciliation/report`. Conserver le
   JSON complet (voir §7 rétention).
3. Vérifier, dans l'ordre :
   1. `ok = true` et `anomalies = []`.
   2. `supply[*].conservationGap = 0` pour chaque devise.
   3. `cashIn.ledgerMismatch = []`, `cashIn.overdueOpen = 0`.
   4. `checks.depositsWithoutAuthority = 0` et
      `checks.depositsNonProductionAuthority = 0` (en production, aucun
      dépôt `treasury_seed`, `demo_seed`, `legacy_pre_gate`).
   5. `checks.stuckTransactions`, `checks.stuckFloatTransfers`,
      `checks.overdrawnWallets`, `checks.balanceDrift`,
      `checks.unbalancedTransactions` vides.
4. Rapprochement bancaire : exporter les requêtes `EXECUTED` de J−1
   (`GET /api/admin/cash-in?status=EXECUTED`), les comparer ligne à ligne
   avec les relevés des comptes de collecte (référence, montant, devise,
   date). Toute référence bancaire sans requête, ou requête sans mouvement
   bancaire, est une anomalie.
5. Vérifier les compteurs d'alerting : `GET /api/admin/alerts/status`
   (`failed = 0` ; sinon, le canal d'alerte est en panne : incident).
6. Signer la réconciliation : un opérateur `compliance` poste une entrée
   d'audit via `POST /api/admin/alerts/test` avec
   `{"note": "reconciliation J-1 OK <initiales>"}` (trace immuable dans
   `audit_logs`, action `alerts.test`) ou, si l'outillage dédié n'est pas
   encore livré (P1), consigne le résultat dans le registre de réconciliation
   (fichier signé, horodaté, conservé avec le JSON).

## 4. Seuils d'alerte et escalade

| Constat | Gravité | Action immédiate | Escalade |
|---|---|---|---|
| `conservationGap ≠ 0` (n'importe quelle devise) | **Critique** | Déclencher le kill switch `all` (`POST /admin/kill-switches/all/fire`) ; ouvrir un incident (docs/INCIDENT_RESPONSE.md) | CTO + Direction dans l'heure |
| `cashIn.ledgerMismatch` non vide | **Critique** | Kill switch `cash_in` ; geler les wallets concernés | CTO + Finance |
| Dépôt sans autorité, ou autorité non-production en production | **Critique** | Kill switch `all` ; incident | CTO + Direction |
| Écart bancaire ≥ 1 requête ou ≥ 100 000 XOF cumulés | **Élevé** | Kill switch `cash_in` jusqu'à explication ; incident | Finance + CTO le jour même |
| `overdueOpen > 0` (requêtes non décidées au-delà du délai) | Moyen | Traiter ou rejeter les requêtes ; vérifier la charge de l'équipe d'approbation | Finance |
| `stuckTransactions` / `stuckFloatTransfers` non vides | Moyen | `POST /admin/reconciliation/recover-float` (ledger.write) ; suivre les transactions bloquées | CTO si > 24 h |
| Alerting `failed > 0` | Élevé | Rétablir le webhook ; jusque-là, réconciliation manuelle toutes les 6 h | CTO |
| Rapport indisponible (5xx, timeout) | Élevé | Traiter comme anomalie ; investiguer la base | CTO |

Tant qu'un constat **Critique** ou **Élevé** n'est pas résolu, aucun nouveau
cash-in n'est approuvé et aucune levée de kill switch n'est autorisée
(**blocage**). La levée exige deux personnes : celle qui a résolu et celle qui
vérifie le rapport redevenu `ok`.

## 5. Résolution

- Aucune correction ne se fait en réécrivant le ledger : `ledger_entries`,
  `transactions`, `cash_in_requests`, `cash_in_decisions`, `audit_logs` sont
  protégés par des triggers (append-only, `no_truncate`). Une correction est
  une **nouvelle** écriture (contre-passation, `authority = reversal`)
  décidée à deux, documentée dans l'incident.
- Un écart bancaire se résout du côté bancaire (mouvement retrouvé, référence
  corrigée dans la banque) ou par une contre-passation si la requête a été
  exécutée à tort. Jamais en modifiant la requête.
- La cause racine est consignée dans `kowri_audit_gaps_2026.md` (journal) et,
  si elle est logicielle, corrigée avec un test qui la reproduit.

## 6. Ce que le rapport ne prouve pas (limites connues)

- Le float agents n'a pas de compte ledger dédié : `supply.agentFloat` est
  informatif, non assertable. Le module agents reste **hors périmètre** tant
  que ce compte n'existe pas.
- Le rapprochement bancaire n'est pas automatisé (pas de rail) : il est
  manuel, ligne à ligne, et c'est précisément pour cela que les limites
  quotidiennes de cash-in sont basses au lancement.
- Le rapport lit la base de production ; s'il est indisponible, la
  réconciliation est faite sur la dernière sauvegarde restaurée à part
  (docs/DISASTER_RECOVERY.md) et signalée comme telle.

## 7. Rétention et audit

| Élément | Où | Durée |
|---|---|---|
| JSON du rapport quotidien | Stockage documentaire chiffré (hors base) | 10 ans (obligations comptables) |
| Relevés bancaires rapprochés | Idem | 10 ans |
| Entrées `audit_logs` (`reconciliation.report`, `alerts.test`, kill switches) | Base (append-only) + sauvegardes | Durée de vie de la base + sauvegardes |
| Incidents et décisions de contre-passation | docs + journal | 10 ans |

Toute lecture du rapport par un opérateur est elle-même auditée
(`admin.*` dans `audit_logs`).
