# AKWÊ — LAUNCH READINESS GATE

Dernière étape de contrôle avant décision de lancement. Point de départ :
commit `a823b5d` (P0 Financial Control Gate, verdict CONDITIONALLY READY).
Ce document transforme ce verdict en décision formelle, avec la preuve qui
la soutient et, pour chaque condition, le responsable, la preuve attendue et
l'étape avant laquelle elle doit être livrée.

Périmètre : lancement contrôlé (canary financier), cash-in manuel sur
preuve bancaire, sans rail fournisseur. Rien ici n'est un nouvel audit
général ; ce qui n'est pas nécessaire au lancement est classé P1/P2/P3 (§11).

---

## 1. Executive Decision

**DECISION : CONDITIONALLY READY — ACTIONS REQUIRED.**

Le code, la base et les procédures permettent un lancement contrôlé du
périmètre défini en §2, sous les conditions de §10. La plateforme n'est
**pas** READY FOR CONTROLLED LAUNCH aujourd'hui parce que cinq éléments
échappent à ce dépôt et n'ont pas pu être vérifiés ici : les limites
d'exposition ne sont pas signées par le métier, les opérateurs nommés
n'existent pas encore en production, l'environnement de production (secrets,
PITR, rôle PostgreSQL applicatif, canal d'alerte) n'a pas été inspecté, le
rejeu de la restauration sur une copie de production n'a pas eu lieu, et la
validation juridique/réglementaire est en attente.

Elle n'est **pas** BLOCKED : aucune faille de création, de vol ou de perte
d'argent non détectable n'a été trouvée lors de la seconde passe
adversariale ; chaque flux autorisé est conservé et prouvé par des tests qui
tournent en CI ; chaque fonctionnalité insuffisamment contrôlée est
**désactivée par défaut en production** et ne peut être ouverte que par une
décision explicite (`LAUNCH_MODULES`).

Ce qui a changé depuis `a823b5d` (ce gate) :

| Chantier | Livré |
|---|---|
| Périmètre de lancement centralisé | `LAUNCH_MODULES` (défaut production : `none`), gate aux routes **et** dans chaque fonction de service qui déplace de l'argent (workers, cron, appels internes compris) ; `GET /api/health/launch-scope` |
| Kill switches financiers | `cash_in`, `credit`, `agent_operations`, `creator_earnings`, `cash_out`, `external_rails`, `fx` ; **propagation inter-instances** en ≤ 5 s (trouvé pendant le gate : un switch tiré sur une instance ne fermait pas les autres avant redémarrage) ; alerte à chaque tir/verrou/levée |
| Gate de configuration production | refus de démarrer sans `LAUNCH_MODULES`, sans les 7 limites `CASH_IN_*` explicites, sans `ALERT_WEBHOOK_URL`, avec des limites non emboîtées ou un module mal orthographié |
| Alerting sortant | `lib/alerting.ts` : POST JSON signé HMAC (`X-Akwe-Signature`) vers `ALERT_WEBHOOK_URL` ; anomalies de réconciliation, kill switches, cash-in expirés ; `POST /admin/alerts/test` |
| Limite manquante | `CASH_IN_DAILY_COUNT_PER_BENEFICIARY` (nombre de cash-in par client et par jour) |
| Sécurité client | statut de transaction affiché dans l'app mobile (pending/failed/reversed jamais présentés comme succès) ; écran « Envoyer » : route `POST /transactions/transfer` qui **n'existait pas** (l'envoi par numéro échouait toujours) ; succès affiché uniquement si `status = completed` |
| Runbooks | `docs/RECONCILIATION_RUNBOOK.md`, `docs/INCIDENT_RESPONSE.md`, `.env.launch.example` |
| Preuve | `test-launch-gate.mjs` (§12), en CI |

---

## 2. Exact Launch Scope

Matrice de lancement. « ON » signifie : activé dans la configuration de
production recommandée (`.env.launch.example`) ; « OFF » signifie : refusé à
la route (503 `MODULE_NOT_IN_LAUNCH_SCOPE`) et dans le service, quel que soit
l'appelant, tant que `LAUNCH_MODULES` ne le nomme pas.

| Module | Décision | Mécanisme | Preuve |
|---|---|---|---|
| Inscription / OTP | **ON** | `PHONE_VERIFICATION=required`, `SMS_PROVIDER=http` obligatoire en production | secretsCheck ; test-phase7 |
| Wallets, soldes, historique | **ON** | cœur, kill switch `all` | test-integrity, test-launch-gate §5 |
| Transferts internes | **ON** | `guard("outbound_transfers")` ; conservation prouvée | test-launch-gate 5c–5d, test-concurrency |
| Cash-in manuel sur preuve bancaire | **ON** | maker-checker, MFA, limites explicites, `guard("cash_in")` | test-cashin (120), test-launch-gate §3, §4, §8 |
| Rails de paiement automatisés | **OFF — NOT IN LAUNCH SCOPE** | aucun fournisseur, aucun faux fournisseur ; `settlements`/`clearing`/`connectors` sont `EXPERIMENTAL` et `guard("external_rails")` | test-launch-gate 9f ; docs/EXTERNAL_RAIL_ARCHITECTURE.md |
| Cash-out | **OFF** | aucune route ; `processWithdrawal` refuse (`assertModuleEnabled("cash_out")` + `guard("cash_out")`) | test-launch-gate §6 |
| Crédit | **OFF** (pas de politique écrite) | module `credit` ; `guard("credit")` sur décaissement et remboursement | test-launch-gate 3g, 4l |
| Float agent | **OFF** (pas de compte ledger dédié, float non assertable) | module `agents` ; `guard("agent_operations")` ; schedulers agents inertes | test-launch-gate 9d |
| Tontines | **OFF au lancement** (contrôlées financièrement mais hors canary) | module `tontines` ; scheduler inerte quand OFF | test-phase5/7 pour la conservation ; test-launch-gate 3g |
| Épargne | **OFF au lancement** | module `savings` (`accrueYield` crée de l'argent sous autorité `savings_yield` : décision de rendement requise) | idem |
| Pools d'investissement / assurance | **OFF** | modules `pools`, `insurance` | idem |
| FX / diaspora | **OFF** | module `fx` ; `guard("fx")` ; `runDueRecurringTransfers` gardé | test-launch-gate 4m |
| Commissions créateurs | **OFF** | module `creator_earnings` ; la déclaration ne crédite jamais (`credited:false`) même quand ON | test-launch-gate §7 |

Configuration de référence : `LAUNCH_MODULES=none`. Ouvrir un module = une
ligne de configuration, une décision écrite, et la preuve listée en §10.

---

## 3. Financial Exposure

### 3.1 Limites de cash-in (DECISION REQUIRED)

Toutes les limites sont lues depuis l'environnement, centralisées dans
`lib/cashIn.ts` (`cashInLimits()`), exposées par `GET /admin/cash-in/limits`
et **obligatoires en production** (le processus refuse de démarrer si une
seule manque ; test-launch-gate 2a–2b). Aucune limite critique n'est cachée
dans le code (test 1f).

| Limite | Variable | Valeur canary proposée (XOF-équivalent) | Statut |
|---|---|---|---|
| Par opération | `CASH_IN_MAX_PER_OPERATION` | 2 000 000 | DECISION REQUIRED |
| Seuil de seconde approbation (troisième opérateur) | `CASH_IN_SECOND_APPROVAL_THRESHOLD` | 500 000 | DECISION REQUIRED |
| Par opérateur et par jour | `CASH_IN_DAILY_LIMIT_PER_OPERATOR` | 10 000 000 | DECISION REQUIRED |
| Par client et par jour (montant) | `CASH_IN_DAILY_LIMIT_PER_BENEFICIARY` | 5 000 000 | DECISION REQUIRED |
| Par client et par jour (nombre) | `CASH_IN_DAILY_COUNT_PER_BENEFICIARY` | 5 | DECISION REQUIRED |
| Plateforme par jour | `CASH_IN_DAILY_LIMIT_PLATFORM` | 50 000 000 | DECISION REQUIRED |
| Expiration d'une demande non décidée | `CASH_IN_EXPIRY_HOURS` | 24 | DECISION REQUIRED |

Règles de blocage (toutes prouvées) : dépassement → 409 avec code nommé
(`CASH_IN_LIMIT_OPERATION|OPERATOR|BENEFICIARY|BENEFICIARY_COUNT|PLATFORM`),
sommes journalières lues et écrites sous verrou consultatif (pas de
dépassement par concurrence, test-concurrency), référence bancaire unique,
bénéficiaire suspendu re-vérifié à l'exécution, wallet non actif refusé.

### 3.2 Exposition du canary (« CANARY FINANCIAL LAUNCH »)

| Paramètre | Proposition | Mécanisme |
|---|---|---|
| Exposition quotidienne maximale (création monétaire) | 50 000 000 XOF | `CASH_IN_DAILY_LIMIT_PLATFORM` |
| Exposition maximale par client | 5 000 000 XOF / jour, 5 opérations | limites bénéficiaire |
| Nombre maximal de clients | à fixer par le métier (recommandation : ≤ 500 la première semaine) | pas de mécanisme technique : contrôle par l'inscription (DECISION REQUIRED) |
| Nombre maximal d'opérateurs | 1 super_admin de garde + 2 `operations` + 2 `compliance` | comptes nommés, MFA |
| Cash-in par jour | ≤ 50 (recommandation) | pas de mécanisme technique global ; `overdueOpen` et alertes `cash_in.expired` signalent la saturation |
| Arrêt automatique | anomalie de réconciliation → alerte critical ; autopilot existant (kill switches `outbound_transfers`, `all`) | worker 6 h + autopilot |
| Arrêt manuel | `POST /admin/kill-switches/<cash_in|outbound_transfers|all>/force` par un super_admin MFA | prouvé, propagé, alerté, audité |

Ce qui manque : un compteur global « nombre de clients / cash-in par jour »
n'existe pas comme limite technique ; il est couvert par le plafond de
montant et par la procédure. Classé P1 (§11).

### 3.3 Trésorerie

La trésorerie plateforme ne peut être approvisionnée en production **que**
par le maker-checker (`seedTreasuryFloat` inerte en production, autorité
`treasury_seed` refusée par la base en production ; test-launch-gate 3d,
test-cashin). Le crédit étant OFF, aucun décaissement de trésorerie n'est
possible au lancement.

---

## 4. Security Controls

| Contrôle | État | Preuve |
|---|---|---|
| Ledger double entrée, append-only, équilibré par trigger | En place (migration 0003) | test-integrity I1–I3, corruptions injectées (DR) |
| Aucun dépôt sans autorité nommée ; float non débitable hors dépôt autorisé | En place (0004) | test-launch-gate 9h (INSERT SQL direct refusé : `DEPOSIT_WITHOUT_AUTHORITY`) |
| Immutabilité cash-in, décisions, audit ; `TRUNCATE` bloqué | En place | test-launch-gate 8c–8f, test-cashin |
| Idempotence liée au corps, par utilisateur | En place | test-integrity 14j, test-concurrency |
| Périmètre de lancement au niveau service | En place | test-launch-gate 9d (grep de chaque point d'entrée), 6d (eval direct de `processWithdrawal`) |
| Secrets : aucun secret dans git, fixtures, logs, front, bundles | Vérifié sur ce dépôt : seul le hash SHA-256 du PIN de démo `1234` dans `seed.ts` (fixture non-production) ; `VITE_ADMIN_API_KEY` lu en repli par le dashboard : **à ne pas définir** en production | grep du dépôt ; `docs/SECURITY_SECRETS.md` |
| Secret manquant = comportement sûr | Oui : refus de démarrer (SIGNING_SECRET, KYC key, MFA, SMS, LAUNCH_MODULES, limites, alerting) ; `SECRETS_STRICT=false` est signalé comme avertissement | test-launch-gate §2 |
| Clé partagée `ADMIN_API_KEY` | Lecture seule sous MFA ; **non définie** en production = pas un credential | test-launch-gate 3f |
| Alerting | Signé HMAC, compteurs `sent/failed`, test opérateur | test-launch-gate 3t–3v, 4c, 4i |

---

## 5. Operator Controls

| Test | Résultat | Preuve |
|---|---|---|
| MFA : code invalide, code périmé (5 pas), enrôlement, mot de passe seul refusé après enrôlement, mot de passe + code | Conformes | test-launch-gate 3i–3m |
| Session non vérifiée = lecture seule (initiation, approbation, kill switch, alertes refusés) | Conforme | 3j, test-operators §3 |
| Opérateur désactivé : session tuée, plus de lecture ni d'initiation | Conforme | 9a |
| Token rejoué après logout | Refusé | 9b |
| Changement de rôle / reset mot de passe / reset MFA révoquent les sessions | Conforme | test-operators 2e–2k |
| Rôles faibles (support, auditor, compliance, operations) sur kill switches et alertes | Refusés (`system.control` seul) | 4o, 3u |
| Utilisateur produit sur contrôles opérateurs | Refusé | 9c |
| Approbations simultanées d'un même checker | Une seule exécution | 8a |
| Auto-approbation | Refusée (permission puis règle des quatre yeux) | 3o, test-cashin A2 |
| Matrice complète 20 actions × 8 appelants | 226 vérifications | test-operators |

Limite connue : le verrou anti-force-brute des connexions est en mémoire par
instance (P1).

---

## 6. Backup / DR

| Élément | État | Preuve |
|---|---|---|
| Sauvegarde `pg_dump` custom + SHA-256 + manifeste | Script livré | `scripts/db-backup.sh`, test-disaster-recovery |
| Restauration dans une base isolée, refus par-dessus un ledger vivant, comparaison manifeste | Prouvé | test-disaster-recovery |
| Seconde instance API sur la restauration (sessions, PIN, PENDING approuvé, idempotence rejouée) | Prouvé | idem |
| Clé KYC : perte, rotation multi-clés | Prouvé | idem, `src/tools/rotateKycKey.ts` |
| RPO / RTO | **Documentés et réalistes, non garantis** : RPO = intervalle de sauvegarde (24 h sans PITR ; minutes avec PITR hébergeur) ; RTO mesuré localement sur base de test (restauration + démarrage < 5 min) — **non mesuré sur volume de production** | `docs/DISASTER_RECOVERY.md` |
| Rejeu sur copie de production | **Non fait** (pas d'accès) | condition §10 |

---

## 7. Reconciliation

`docs/RECONCILIATION_RUNBOOK.md` : fréquence (worker 6 h + réconciliation
quotidienne signée avant 10:00), propriétaire (**à nommer**), seuils
d'alerte, escalade, blocage (aucun cash-in, aucune levée de switch tant
qu'un constat critique/élevé est ouvert), résolution (jamais par réécriture
du ledger), rétention 10 ans, audit.

Preuve de conservation, flux par flux (test-launch-gate §5) :

| Flux | Effet sur `created` | `conservationGap` | Statut lancement |
|---|---|---|---|
| Cash-in manuel | +montant (autorité `cash_in_request`), passif +montant | 0 | ON |
| Transfert interne | 0 | 0 | ON |
| Remboursement de prêt | 0 (wallet → trésorerie) | 0 | OFF (crédit) |
| Commission créateur | 0, zéro écriture, `credited:false` | 0 | OFF |
| Épargne (rendement) | +rendement (autorité `savings_yield`) | 0 | OFF |
| Tontine, pools, FX | 0 (test-phase5/7, test-integrity I1–I16) | 0 | OFF |
| Trésorerie | approvisionnée par cash-in uniquement | 0 | ON |

Non assertable : float agent (pas de compte ledger) → module OFF.

---

## 8. Incident Response

`docs/INCIDENT_RESPONSE.md` : DETECT → FREEZE → INVESTIGATE → RECONCILE →
RESOLVE → AUDIT ; table des gels (switch, wallet, opérateur), litiges,
cash-in erroné, contre-passation (**outillage à deux signatures : P1** ;
procédure transitoire par script applicatif, jamais par SQL — les triggers
refusent de toute façon), remboursement (transfert trésorerie → client,
jamais de « crédit manuel »), clôture et rétention.

Constat pendant le gate : il n'existe pas d'endpoint de suspension de compte
client (le statut change seulement par la décision KYC). Gel = gel de tous
ses wallets. Endpoint dédié classé P1.

---

## 9. Regulatory / Legal Gate

Aucune ligne n'est « conforme » sans preuve. Statuts : CONFIRMED (prouvé
dans ce dépôt), DOCUMENTED (procédure écrite, non validée), PENDING
LEGAL/REGULATORY VALIDATION, BLOCKER.

| Exigence | Statut | Note |
|---|---|---|
| Statut réglementaire de l'activité (établissement de monnaie électronique / agent / partenariat bancaire, BCEAO/UEMOA ou autre juridiction) | **PENDING LEGAL/REGULATORY VALIDATION** | Le dépôt ne peut pas l'établir. Sans cadre, la détention de fonds clients est un **BLOCKER** de lancement public ; un pilote fermé sous convention bancaire reste à valider juridiquement |
| Cantonnement des fonds clients (compte de collecte séparé, rapprochement quotidien) | DOCUMENTED | Runbook de réconciliation ; compte bancaire à ouvrir et prouver |
| KYC : identification, niveaux, conservation chiffrée | CONFIRMED (technique) / PENDING (niveaux exigés par le régulateur) | Documents chiffrés au repos, clé sous escrow (condition) |
| LCB-FT / AML : screening synchrone bloquant, alertes, revue | CONFIRMED (technique) / PENDING (procédure déclarative, listes de sanctions réelles) | Aucune liste officielle branchée : DECISION REQUIRED |
| Plafonds par client cohérents avec le niveau KYC | CONFIRMED (technique) / PENDING (valeurs réglementaires) | limites KYC + limites cash-in |
| Piste d'audit immuable, rétention | CONFIRMED (technique) / DOCUMENTED (10 ans) | `audit_logs` append-only, `no_truncate` |
| Protection des données personnelles (base légale, information, droits) | PENDING LEGAL VALIDATION | Politique de confidentialité et registre non présents dans le dépôt |
| Conditions générales, tarification affichée, reçus et références | DOCUMENTED / PENDING | Références de transaction présentes (`reference`) ; CGU non présentes dans le dépôt |
| Crédit, épargne rémunérée, assurance, tontines | **OFF** — PENDING pour chacun (agrément / partenariat) | Ne pas ouvrir sans validation |
| Change / transferts internationaux | **OFF** — PENDING | idem |
| Signalement d'incidents à l'autorité | DOCUMENTED (runbook) / PENDING (délais et forme réglementaires) | |

---

## 10. Open Blockers (conditions avant lancement)

Aucun blocker technique prouvé. Conditions, chacune avec responsable, preuve
attendue et étape :

| # | Condition | Responsable | Preuve attendue | Avant |
|---|---|---|---|---|
| C1 | Signer les limites `CASH_IN_*` et l'exposition canary (§3) | Direction + Finance | Valeurs inscrites dans la configuration de production, décision écrite | Configuration production |
| C2 | Cadre juridique / réglementaire du pilote (§9, ligne 1) | Direction + Conseil juridique | Avis écrit ; convention bancaire ou agrément | Premier client réel |
| C3 | Opérateurs nommés : ≥ 2 `operations`, ≥ 2 `compliance`, 1 super_admin de garde, tous enrôlés MFA ; `ADMIN_API_KEY` et `VITE_ADMIN_API_KEY` **non définis** | CTO | `GET /admin/auth/users`, `mfaEnrolled=true` pour chacun ; revue des secrets sans avertissement `ADMIN_API_KEY` | Premier cash-in |
| C4 | Environnement de production : secrets générés (`SIGNING_SECRET`, `KYC_ENCRYPTION_KEY` sous escrow à deux détenteurs), rôle PostgreSQL applicatif ≠ propriétaire, TLS base, `LAUNCH_MODULES=none`, `ALERT_WEBHOOK_URL` vers un canal d'astreinte réel | CTO + Ops | Journal de démarrage sans `[secrets] ERROR` ; `POST /admin/alerts/test` reçu sur le canal | Déploiement |
| C5 | Sauvegardes planifiées + PITR hébergeur ; rejeu de `test-disaster-recovery.mjs` sur une copie de production ; RTO mesuré | Ops | Rapport de rejeu daté, RTO chiffré dans `docs/DISASTER_RECOVERY.md` | Premier client réel |
| C6 | Réconciliation quotidienne : propriétaire et suppléant nommés, compte de collecte identifié, première réconciliation signée à blanc | Finance | Registre de réconciliation J0 | Premier cash-in |
| C7 | Protection de branche `main` (CI verte obligatoire, revue) | CTO | Réglage GitHub | Déploiement |
| C8 | Listes de sanctions / PPE réelles ou décision documentée de lancer sans (pilote fermé) | Conformité | Décision écrite | Premier client réel |
| C9 | Garder OFF : crédit, agents, cash-out, rails, FX, tontines, épargne, pools, assurance, commissions — jusqu'à décision écrite et preuve §2 | Direction | `GET /health/launch-scope` en production | Permanent |

---

## 11. Post-Launch P1 (et P2/P3)

**P1 — POST-LAUNCH (avant toute extension de périmètre)**
- Outil de contre-passation à deux signatures (aujourd'hui procédure transitoire par script).
- Endpoint de suspension de compte client (aujourd'hui gel des wallets).
- Compte ledger dédié au float agent (préalable au module `agents`).
- Compteurs techniques « clients / cash-in par jour » en plus des plafonds de montant.
- Verrou anti-force-brute partagé entre instances (Redis ou table).
- Rapprochement bancaire outillé (import de relevé, matching par référence).
- Politique de crédit écrite + test de scoring avant `credit`.
- Politique de rendement d'épargne (qui paie `savings_yield`) avant `savings`.

**P2 — PRODUCT / HARDENING**
- Cookie `httpOnly` + CSP pour le back-office ; retrait définitif du repli `VITE_ADMIN_API_KEY`.
- Frais affichés côté mobile lus depuis l'API (aujourd'hui 0,5 % calculé localement dans l'écran Envoyer).
- Page « historique complet » mobile avec filtres de statut.
- Reçus PDF / SMS de confirmation.

**P3 — FUTURE**
- Rail fournisseur (docs/EXTERNAL_RAIL_ARCHITECTURE.md), cash-out, FX, multi-région.

---

## 12. Evidence

### 12.1 Suite `test-launch-gate.mjs`

Contre une instance de développement (:8080, tous modules ON) et une
**instance de production** lancée par la suite (`NODE_ENV=production`,
`LAUNCH_MODULES=none`, MFA imposé, sans clé partagée, limites explicites,
alerting vers un récepteur local qui vérifie la signature HMAC) :

1. Périmètre explicite, centralisé, visible (6 vérifications).
2. Boot production : trois configurations fautives refusées avec le motif (5).
3. Instance production : fixtures démo ignorées, aucun `[secrets] ERROR`, pas de seed trésorerie, 16 routes de modules optionnels (variantes casse/slash) en 503, clé partagée refusée, MFA (code faux, périmé, enrôlement, relogin), cash-in de bout en bout sous deux opérateurs MFA, limites par opération / seuil de seconde signature / nombre par bénéficiaire, alerte de test signée reçue, compteurs, rapport de réconciliation (23).
4. Kill switches : tir sur l'instance production, alerte critical, **adoption par l'autre instance en < 10 s**, refus 503 sur l'autre instance, demande PENDING intacte, recover/lift propagés et alertés, exécution après levée une seule fois, audit, switches `credit`/`fx`/`creator_earnings` effectifs, switch inconnu 404, rôles faibles 403 (16).
5. Conservation flux par flux (9).
6. Cash-out OFF : statique, dynamique (15 chemins × 3 appelants), eval direct du service avec module OFF puis ON (5).
7. Commissions créateurs : montants falsifiés, communauté inexistante, autre utilisateur, anonyme, 12 rejeux concurrents, clé partagée, vieilles routes ; zéro écriture ledger (6).
8. Machine à états cash-in : double approbation simultanée, EXECUTED/REJECTED/EXPIRED terminaux, immutabilité SQL de l'expiration et des faits, décisions append-only (8).
9. Seconde passe adversariale : opérateur désactivé, token rejoué, utilisateur produit, gates de service (grep de chaque point d'entrée), montage des routeurs, chemins internes/expérimentaux en production, dépôt direct, INSERT SQL sans autorité (9).
10. Arrêt propre de l'instance production (1).

Décompte : voir le résultat final en fin de document (§12.4).

### 12.2 Suites existantes (toutes en CI)

gating 357 (routes sondées sans credential, 0 ouverte hors liste publique) ·
integrity 198 · phase3 80 · phase4 106 · phase5 116 · phase7 152 · phase6 75 ·
adversarial 85 · cashin 120 · operators 226 · concurrency 95 ·
disaster-recovery 65 · launch-gate 88 = **1 763 vérifications, 0 échec**
(régression complète rejouée sur ce commit, base locale PostgreSQL 16).

### 12.3 Fichiers de ce gate

`artifacts/api-server/src/lib/launchScope.ts`, `middleware/launchScope.ts`,
`lib/alerting.ts`, `lib/killSwitch.ts` (switches financiers, sync
inter-instances), `lib/secretsCheck.ts`, `lib/cashIn.ts` (compteur
bénéficiaire, `CASH_IN_LIMIT_ENV`), gardes dans `creatorEconomy.ts`,
`liquidityEngine.ts`, `communityFinance.ts`, `savingsEngine.ts`,
`diasporaService.ts`, `tontineScheduler.ts`, `walletService.ts`,
`settlementService.ts`, `routes/credit.ts`, `routes/index.ts`,
`routes/creatorEconomy.ts`, `routes/diaspora.ts`, `routes/health.ts`,
`routes/admin.ts` (alertes, patch-tontines hors production),
`routes/transactions.ts` (transfert par numéro), `index.ts` (schedulers
conditionnés, sync des switches, alerte d'expiration), app mobile
(`TransactionRow.tsx`, `Dashboard.tsx`, `Send.tsx`), dashboard
(`WarRoomDashboard.tsx`), `test-launch-gate.mjs`, `.github/workflows/ci.yml`,
`docs/RECONCILIATION_RUNBOOK.md`, `docs/INCIDENT_RESPONSE.md`,
`.env.launch.example`.

### 12.4 Résultat final

- `test-launch-gate.mjs` : **88 vérifications, 0 échec** (trois instances
  production fautives refusées, une instance production conforme démarrée,
  exercée et arrêtée proprement).
- Migrations `0000`–`0004` appliquées sur une base vierge : 88 tables,
  même jeu de triggers que la base de développement.
- Régression complète des 13 suites : 1 763 vérifications, 0 échec (§12.2).
  Typecheck API, libs et deux fronts : 0 erreur. Builds mobile et
  back-office : OK. Arrêt gracieux SIGTERM vérifié (instance production du
  gate, et job CI).

---

## Matrice finale

| Gate | Status | Evidence | Blocking? |
|---|---|---|---|
| Cash-in maker-checker | PASS | test-cashin 120, test-launch-gate §3/§8, triggers 0004 | Non |
| Cash-in limits | PASS (technique) / DECISION REQUIRED (valeurs) | test-launch-gate 1e–1f, 3q–3s, §2 | Oui — C1 |
| Treasury | PASS | approvisionnement par maker-checker seul ; seed inerte en production | Non |
| Ledger integrity | PASS | I1–I16, corruptions injectées, INSERT SQL refusé | Non |
| Reconciliation | PASS (technique) / ACTION REQUIRED (propriétaire, compte de collecte) | runbook, worker 6 h, alerte critical | Oui — C6 |
| Backup/restore | PASS (local) / ACTION REQUIRED (copie de production) | test-disaster-recovery | Oui — C5 |
| RPO/RTO | DOCUMENTED, non garanti | docs/DISASTER_RECOVERY.md | Oui — C5 |
| Operator MFA | PASS | test-launch-gate 3i–3m, test-operators | Non (C3 pour les comptes réels) |
| RBAC | PASS | test-operators 226, test-launch-gate 4o, 9a–9c | Non |
| Creator earnings | PASS (ne crée jamais d'argent) — module OFF | test-launch-gate §7 | Non |
| Agent float | OFF | module `agents`, guard | Non (P1 avant ouverture) |
| Credit | OFF | module `credit`, guard | Non (politique avant ouverture) |
| Cash-out | OFF | §6 | Non |
| External rails | NOT IN LAUNCH SCOPE | §9f, docs | Non |
| Incident response | DOCUMENTED (outil de contre-passation P1) | docs/INCIDENT_RESPONSE.md | Non |
| Regulatory/legal | PENDING LEGAL/REGULATORY VALIDATION | §9 | **Oui — C2** |
| Production secrets | PASS (gate de boot) / ACTION REQUIRED (environnement réel) | test-launch-gate §2, §3 | Oui — C4 |
| Monitoring/alerts | PASS (technique) / ACTION REQUIRED (canal réel) | alerting signé, test opérateur | Oui — C4 |
| Kill switches | PASS | §4, propagation inter-instances | Non |
| Customer transaction status | PASS | statut affiché, envoi mobile réparé, succès seulement si `completed` | Non |
