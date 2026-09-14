# AKWÊ — FINAL CLOSE-OUT / EVIDENCE GATE

Gate de fermeture des neuf conditions du `AKWE_FINAL_GO_NO_GO_GATE.md`.
Chaque condition reçoit un seul statut : **PASS** (preuve présente et
vérifiée), **FAIL** (preuve absente ou insuffisante), **BLOCKED EXTERNAL**
(action humaine, juridique, bancaire ou organisationnelle), **TECHNICAL FIX
REQUIRED** (anomalie réelle du système). Date : 14 septembre 2026.

---

## 1. État du commit

| Élément | Valeur |
|---|---|
| Commit de référence | `4965ad3c1eae74d6c4fc18ace4eb3e328733a6b9` |
| Branche | `claude/akwe-cto-audit-l7ln2q` = `origin/claude/akwe-cto-audit-l7ln2q` (identiques au début de cette gate) |
| Arbre de travail | propre ; `git diff 4965ad3` vide avant les modifications documentaires listées en §20 |
| `main` | `afee47ac` — PR #17 **non fusionnée** ; `main` ne contient aucun des contrôles décrits ici ; **non protégée** (API GitHub, `protected: false`, vérifié pendant cette gate) |
| CI | run #6 verte sur `4965ad3` (typecheck + builds ; 13 suites PostgreSQL 16) |
| Fichiers `.env` | seuls `.env.launch.example`, `artifacts/api-server/.env.example`, `artifacts/kowri-app/.env.example` sont suivis ; aucun `.env` réel sur le disque ; `.env*` ignorés |
| Code de production modifié par cette gate | **aucun** |

## 2. Résumé exécutif

**FINAL REAL-MONEY STATUS : 🔴 NO-GO.**

Le système démontre tout ce qu'un système peut démontrer seul : périmètre
canary fermé sur ses trois niveaux (route, service, scheduler), création
monétaire impossible hors maker-checker, conservation exacte, kill switches
effectifs et propagés, sauvegarde et restauration rejouées et chronométrées,
non-régression verte sur `4965ad3`.

Rien de ce qui manque ne se fabrique dans le dépôt. Sur les neuf conditions,
**une seule est PASS (C9)** ; les huit autres sont **BLOCKED EXTERNAL**, et
la plus importante, **C2 (cadre réglementaire)**, n'a aucune preuve. Tant
qu'AKWÊ ne peut pas prouver son droit de recevoir et détenir des fonds
clients, aucun XOF réel ne doit entrer.

L'étape suivante n'est pas technique : obtenir les preuves de §20, puis
rejouer ce gate tel quel.

## 3. Périmètre canary

`LAUNCH_MODULES=none` = **cœur seulement**. Sémantique vérifiée dans
`src/lib/launchScope.ts` (la liste ne contient que les modules optionnels ;
le cœur n'a pas d'entrée et ne peut pas être désactivé par cette variable),
`.env.launch.example` et `docs/DEPLOYMENT.md`.

| Fonction | Autorisée ? | Preuve | Limite |
|---|---|---|---|
| Signup OTP | OUI | `PHONE_VERIFICATION=required`, `SMS_PROVIDER` obligatoire en production (secretsCheck ; test-launch-gate §2) | rate limit login ; SMS réel NOT VERIFIED |
| KYC | OUI | niveaux, documents chiffrés AES-256-GCM, workflow d'approbation (test-phase7, DR) | listes de sanctions : **absentes** |
| Wallet | OUI | création à l'inscription, gel effectif (canary-adversarial AU2) | — |
| Solde | OUI | lecture propriétaire seulement (AU1) | — |
| Historique | OUI | statut réel de chaque transaction affiché (mobile) ; scope au propriétaire | — |
| Transfert interne | OUI | conservation 0, double dépense impossible, idempotence (canary-adversarial DS1, ID1–ID2, RC1) | vélocité 10/min, 5 M/h, 20 M/j par wallet ; plafonds KYC ; kill switch `outbound_transfers` |
| Cash-in manuel | OUI | maker-checker, MFA, limites `CASH_IN_*`, expiration, immutabilité (test-cashin 120, test-launch-gate §3/§8) | limites **non signées** (C1) ; kill switch `cash_in` |
| Treasury | OUI | alimentée uniquement par cash-in ; seed inerte en production (test-launch-gate 3d) | plafond = cumul des plafonds plateforme (DECISION REQUIRED) |
| Réconciliation | OUI | rapport I1–I16 + conservation ; worker 6 h ; alerte critical | propriétaire **non nommé** (C6) |
| Alerting | OUI | HMAC signé, compteurs, test opérateur (test-launch-gate 3t–3v) | canal réel NOT VERIFIED (C4) |
| Crédit | NON | route 503, `assertModuleEnabled("credit")` + `guard("credit")` dans le handler (test-launch-gate 3g, 4l, 9d) | — |
| Cash-out | NON | aucune route ; `processWithdrawal` refuse module OFF (test-launch-gate §6) | — |
| Agent float | NON | route 503, `executeFloatTransfer` gardé, schedulers agents inertes (9d, index.ts) | — |
| FX | NON | route 503, `sendRemittance`/`runDueRecurringTransfers` gardés, `guard("fx")` (4m) | — |
| Diaspora | NON | même module `fx` | — |
| Tontine | NON | routes `/tontines`, `/community` 503 ; `runContributionCycle`/`runPayoutCycle` gardés ; `tontineSchedulerTick` inerte | — |
| Savings | NON | route 503 ; `createSavingsPlan`/`accrueYield`/`matureSavingsPlan` gardés | — |
| Pools | NON | route 503 ; `investInPool`/`distributePoolReturns`/`redeemPoolPosition` gardés | — |
| Insurance | NON | route 503 ; `joinInsurancePool`/`fileClaim`/`adjudicateClaim` gardés | — |
| Creator commissions | NON | route earnings 503 ; `distributeCreatorEarnings` gardé ; ne crédite jamais même ON (test-launch-gate §7) | — |
| Rails automatisés / règlements / clearing / connecteurs | NON | `EXPERIMENTAL_MODULES` non défini → 503 ; `guard("external_rails")` (9f) | — |

## 4. Résultats des tests (cette gate, sur `4965ad3`)

| Suite | Résultat | Note |
|---|---|---|
| `test-gating.mjs` | 357 routes sondées sans credential, **0 ouverte** | — |
| `test-launch-gate.mjs` | **88 / 88** | Premier passage : 84/88, quatre échecs sur le rapport de réconciliation (`I12 : 2 demandes de cash-in expirées depuis plus d'une heure et toujours ouvertes`). Cause : l'API locale avait été arrêtée plusieurs heures ; le worker d'expiration (toutes les 5 min) n'avait pas encore tourné après la remise en route. L'approbation refuse de toute façon une demande dont l'expiration est passée (`cashIn.ts`, `CASH_IN_EXPIRED`, prouvé test-launch-gate 8g). Rejoué après le premier tick : 88/88. **Détection attendue, pas une régression** — consigné comme comportement à connaître au redémarrage après une longue indisponibilité. |
| `test-canary-adversarial.mjs` | **18 / 18** | création monétaire (six chemins × trois appelants, INSERT SQL), destruction, double dépense, course sur approbation, autorisation inter-clients, séparation opérateurs, idempotence, kill switches, réconciliation, reprise |
| Réconciliation locale pendant les suites | `ok = true`, écart 0 | — |

Résultat attendu par la mission, point par point : zéro route financière non
protégée ✔ ; zéro création monétaire arbitraire ✔ ; zéro double dépense ✔ ;
zéro cross-client ✔ ; maker-checker intact ✔ ; MFA intact ✔ ; idempotence
intacte ✔ ; conservation intacte ✔ ; aucun PENDING inexpliqué ✔ (les deux
PENDING expirés du premier passage sont expliqués et fermés) ; kill switches
fonctionnels ✔.

## 5. C1–C9

### C1 — Limites financières

| Vérifié | Constat |
|---|---|
| Limites cash-in par opération, seuil de seconde signature, par opérateur/jour, par client/jour (montant et nombre), plateforme/jour, expiration | Imposées, refus 409 typés, sommes sous verrou consultatif, obligatoires en production (test-launch-gate 1e–1f, 2a–2b, 3q–3s) |
| Limite par transaction (transferts) | vélocité 10/min, 5 M/h, 20 M/j par wallet ; plafonds KYC par niveau |
| Exposition canary (clients, transactions/jour, plafond mensuel, float) | **aucun mécanisme technique** pour le nombre de clients, le plafond mensuel et le float ; couverts par le plafond plateforme journalier et par procédure |
| Kill switch `cash_in` | prouvé (503, PENDING intact, propagé, alerté) |
| Dépassement | 409 `CASH_IN_LIMIT_*`, 429 `RATE_LIMITED`, `KYC_LIMIT` — rien n'est partiellement exécuté |
| Procédure d'augmentation exceptionnelle | **absente** : une limite se change en modifiant l'environnement et en redémarrant ; aucune procédure à deux signatures n'est écrite |
| Approbation métier signée | **absente** du dépôt et des preuves fournies |

**C1 = BLOCKED EXTERNAL.** Les valeurs proposées (`.env.launch.example`,
`AKWE_FINAL_GO_NO_GO_GATE.md` §14) ne sont pas modifiées ; elles restent des
propositions.

### C2 — Cadre réglementaire

Recherche dans le dépôt (`grep` sur BCEAO, UEMOA, agrément, licence,
établissement de monnaie électronique, cantonnement, safeguarding,
partenaire bancaire, CGU, politique de confidentialité) : seuls les rapports
d'audit et runbooks mentionnent ces sujets. Aucun avis juridique, aucun
agrément, aucune convention avec un établissement autorisé, aucun compte de
collecte, aucune politique publiée, aucune restriction géographique
formalisée.

| Point | Preuve |
|---|---|
| Droit de recevoir/détenir des fonds clients | aucune |
| Statut réglementaire applicable, agrément ou partenaire réglementé | aucune |
| Convention avec un établissement autorisé | aucune |
| Compte de collecte, cantonnement, séparation fonds clients / fonds opérationnels | aucune (le runbook de réconciliation le prévoit, rien ne l'atteste) |
| Obligations KYC/AML | technique en place ; obligations réglementaires non établies |
| Conservation des données, plaintes, reporting, restrictions géographiques | aucune |

**C2 = BLOCKED EXTERNAL → FINAL REAL-MONEY STATUS = NO-GO.**

### C3 — Opérateurs réels

| Vérifié | Constat |
|---|---|
| ≥ 2 `operations`, ≥ 2 `compliance`, ≥ 1 `super_admin` réels | **aucun environnement cible** ; la base locale ne contient que des comptes de test |
| MFA enrôlé | mécanisme prouvé (test-launch-gate 3i–3m) ; personne d'enrôlé |
| Séparation des responsabilités | imposée par la base (initiateur ≠ approbateur ≠ second approbateur) |
| Indépendance vis-à-vis de `ADMIN_API_KEY` / `VITE_ADMIN_API_KEY` | en production, `ADMIN_API_KEY` absente n'est pas un credential (3f) ; sa non-définition réelle et celle de `VITE_ADMIN_API_KEY` sur les projets Vercel : NOT VERIFIED |
| Révocation d'un opérateur | `PATCH /api/admin/auth/users/:id {"status":"disabled"}` révoque toutes ses sessions (prouvé, test-launch-gate 9a) |
| Perte du second facteur | `POST /api/admin/auth/users/:id/mfa/reset` (admins.manage) puis réenrôlement ; documenté (`docs/SECURITY_SECRETS.md`, `docs/INCIDENT_RESPONSE.md` §7) |

**C3 = BLOCKED EXTERNAL.**

### C4 — Environnement de production

| Élément | Statut |
|---|---|
| API déployée | **inexistante** : Vercel `kowri-api-server` ignoré par conception (dernier déploiement `CANCELED`), Railway non configuré ni accessible |
| Base de production, migrations | inexistantes / NOT VERIFIED |
| Secrets réels (`SIGNING_SECRET`, `KYC_ENCRYPTION_KEY`), SMS/OTP, alerting, logs, monitoring | NOT VERIFIED (aucun environnement) |
| Kill switches, `LAUNCH_MODULES=none` | prouvés sur instance locale en configuration production ; état réel NOT VERIFIED |
| HTTPS, CORS, trusted proxy, limites de corps | code présent (`app.set("trust proxy", 1)`, `cors(corsOptions())`, `express.json({ limit })`), `DATABASE_SSL` automatique hors localhost ; NOT VERIFIED en réel |
| Secret exposé côté frontend | aucun dans les sources ; `VITE_ADMIN_API_KEY` sur Vercel NOT VERIFIED |

Le gate de boot garantit qu'un processus production **refuse de démarrer**
sans `LAUNCH_MODULES`, sans les sept limites, sans `ALERT_WEBHOOK_URL`, sans
clé KYC valide, sans SMS (test-launch-gate §2). **C4 = BLOCKED EXTERNAL.**

### C5 — Backup / restore / DR

| Preuve locale (rejouée cette gate et la précédente) | Preuve sur environnement cible |
|---|---|
| `scripts/db-backup.sh` : 0,82 s, dump 4,8 Mo, SHA-256, manifeste | aucune (pas d'environnement) |
| `scripts/db-restore.sh` : 1,01 s, checksum ok, « manifest verified: counts, migrations and money supply match » | aucune |
| `test-disaster-recovery.mjs` 65/65 : seconde instance API sur la restauration, sessions, PIN, idempotence, PENDING approuvé, audit, ledger, KYC illisible sans clé, récupération avec clé, rotation | aucune |
| RPO réel | **théorique** : = intervalle entre dumps (24 h si dump quotidien) ; aucun PITR configuré |
| RTO réel | **théorique** : < 1 min sur 48 Mo de test ; non mesuré sur volume et hébergeur réels ; le temps humain domine |
| Sauvegarde automatique, fréquence, conservation | non planifiées (pas d'environnement) |

**C5 = BLOCKED EXTERNAL** (mécanisme PASS, production non démontrée).

### C6 — Réconciliation

| Vérifié | Constat |
|---|---|
| Propriétaire humain nommé | **« à nommer »** (`docs/RECONCILIATION_RUNBOOK.md` §2) |
| Fréquence quotidienne, sources, ledger, transactions, pending, cash-in, écarts, seuils, escalade, signature, conservation | documentés |
| Compte de collecte identifié, rapprochement bancaire | non identifié ; procédure écrite, jamais exécutée |
| Réconciliation technique | MATCH sur la base locale (écart 0, quatre devises) ; pas de régression |

**C6 = BLOCKED EXTERNAL.**

### C7 — Protection du dépôt

API GitHub pendant cette gate : `main` `protected: false` ; aucune règle
de PR, CI ou revue obligatoire ; push direct possible. La branche réellement
déployable (`main`) ne contient pas les contrôles. Réglage de dépôt hors du
périmètre du code. **C7 = BLOCKED EXTERNAL.**

### C8 — Compliance opérationnelle

| Brique | État réel | Avant premier client | Avant montée en charge | OFF pendant le pilote |
|---|---|---|---|---|
| Sanctions / PPE screening | **absent** (`riskScreening.ts` : vélocité et schémas seulement) | intégration réelle **ou** décision écrite de pilote fermé (clients nominativement connus) | intégration réelle | — |
| KYC | technique en place | niveaux exigés par le régulateur validés | — | — |
| Politique AML écrite | absente | obligatoire | — | — |
| Conservation des données, confidentialité | runbooks (10 ans) ; politique de confidentialité absente | obligatoire | — | — |
| CGU, tarification | absentes du dépôt ; frais mobile calculés localement (P2) | obligatoire | — | — |
| Plaintes, remboursement, incident, notification client | `docs/INCIDENT_RESPONSE.md` (§5.1, §5.4, §7) ; délai de réponse client DECISION REQUIRED | validation juridique | — | — |
| Journalisation | `audit_logs` append-only, `no_truncate` | — | — | — |
| Reporting réglementaire | forme et délais PENDING | obligatoire | — | — |

**C8 = BLOCKED EXTERNAL.** Rien n'est marqué conforme.

### C9 — Modules non prouvés OFF

Vérifié sur `4965ad3` aux trois niveaux :

1. **Route** : 16 chemins optionnels (variantes casse/slash comprises) → 503 `MODULE_NOT_IN_LAUNCH_SCOPE` sur l'instance production (test-launch-gate 3g) ; montage `launchModule()` de chaque routeur (9e).
2. **Service** : `assertModuleEnabled` et/ou `guard` présents dans `creatorEconomy`, `liquidityEngine`, `diasporaService`, `walletService.processWithdrawal`, `savingsEngine`, `communityFinance`, `tontineScheduler`, `routes/credit`, `cashIn`, `settlementService` (9d) ; `processWithdrawal` refuse module OFF par appel direct (6d).
3. **Scheduler / jobs** : `tontineSchedulerTick` et schedulers agents inertes quand OFF (`index.ts`, 9d) ; gestionnaires d'événements = notifications uniquement (aucun mouvement d'argent).

Kill switches : `credit`, `agent_operations`, `creator_earnings`,
`cash_out`, `external_rails`, `fx` en plus des modules OFF ; tous `ENABLED`
au départ, fire/force/lift prouvés, propagation ≤ 5 s, alertes, audit.

**C9 = PASS.**

## 6. Preuves

| Preuve | Où |
|---|---|
| Suites de cette gate | §4 ; sorties conservées hors dépôt |
| Suites CI sur `4965ad3` | run #6, 13 suites, 1 763 vérifications |
| Sauvegarde/restauration chronométrées | `AKWE_FINAL_GO_NO_GO_GATE.md` §11 (rejouées) |
| Protection de branche | API GitHub, cette gate |
| Sémantique `LAUNCH_MODULES` | `src/lib/launchScope.ts`, `.env.launch.example`, `docs/DEPLOYMENT.md` |
| Révocation opérateur, reset MFA | test-launch-gate 9a ; test-operators 2e–2k ; `docs/SECURITY_SECRETS.md` |
| Approbation d'une demande expirée refusée | `src/lib/cashIn.ts` (`CASH_IN_EXPIRED`) ; test-launch-gate 8g |

## 7. Conditions externes

C1 (décision métier), C2 (juridique/réglementaire), C3 (organisation),
C4 (hébergement et secrets), C5 (hébergeur PITR, copie de production),
C6 (Finance : propriétaire, compte de collecte), C7 (réglage GitHub),
C8 (conformité, juridique). Aucune ne se résout par du code ; aucune n'a été
contournée.

## 8. Limites

Voir C1 et `AKWE_FINAL_GO_NO_GO_GATE.md` §14. État : imposées, non signées.
Manques techniques connus et acceptés pour un pilote : pas de compteur
global de clients ni de transactions/jour, pas de plafond mensuel, pas de
plafond de float distinct, pas de procédure d'augmentation exceptionnelle.

## 9. Opérateurs

Voir C3. Modèle prouvé, personnes absentes.

## 10. Production

Voir C4. Inexistante.

## 11. DR

Voir C5. Local prouvé et chronométré ; production théorique.

## 12. Réconciliation

Voir C6. Technique MATCH ; opérationnellement sans propriétaire.

## 13. Conformité

Voir C8. Aucune brique marquée conforme ; matrice avant premier client /
avant montée en charge / OFF.

## 14. Modules OFF

Voir C9. PASS aux trois niveaux, kill switches compris.

## 15. Canary exposure

**Non définie faute de signature.** Aucune valeur n'est inventée ici ; les
propositions restent celles du gate précédent. **BLOCKED EXTERNAL.**

## 16. Rollback

`AKWE_FINAL_GO_NO_GO_GATE.md` §16, inchangé : `force` du switch (`all`,
`cash_in` ou `outbound_transfers`) par un super_admin MFA, effet ≤ 5 s sur
toutes les instances, PENDING intact ; constat par le rapport ; retour de
version sans migration inverse (migrations additives) ; retour de données par
`scripts/db-restore.sh` dans une base isolée puis bascule à deux ; levée par
un super_admin différent après rapport `ok`. Kill switch d'urgence prouvé
cette gate (canary-adversarial KS1 ; test-launch-gate §4).

## 17. Incident response

`docs/INCIDENT_RESPONSE.md` couvre désormais explicitement (nouvelle
section 7, ajoutée par cette gate) : suspicion de fraude, erreur de crédit,
transfert bloqué, double opération, litige client, cash-in contesté,
compromission opérateur, compromission de clé, perte du second facteur,
indisponibilité de la base, restauration, gel des opérations, communication
client, escalade réglementaire. Deux points restent des décisions : le délai
de réponse client et la forme du signalement réglementaire (dépend de C2).

## 18. Matrice finale

| Gate | Condition | Statut | Preuve | Bloquant ? | Action |
|---|---|---|---|---|---|
| C1 | Limites signées | BLOCKED EXTERNAL | limites imposées (tests) ; aucune signature | OUI | Direction + Finance signent le tableau §14 du gate précédent et le reportent dans l'environnement |
| C2 | Cadre réglementaire | BLOCKED EXTERNAL | aucune preuve | **OUI** | Avis juridique, agrément ou convention avec un établissement autorisé, compte de collecte, cantonnement |
| C3 | Opérateurs MFA | BLOCKED EXTERNAL | modèle prouvé ; aucun compte réel | OUI | Créer et enrôler ≥ 2 operations, ≥ 2 compliance, 1 super_admin ; sans clés partagées |
| C4 | Production réelle | BLOCKED EXTERNAL | aucun environnement | OUI | Héberger l'API, base PITR, secrets, canal d'alerte réel prouvé |
| C5 | DR réel | BLOCKED EXTERNAL | local 65/65, chronométré | OUI | Rejeu sur copie de production, PITR, RTO mesuré |
| C6 | Réconciliation propriétaire | BLOCKED EXTERNAL | runbook ; « à nommer » | OUI | Nommer propriétaire et suppléant, identifier le compte de collecte, réconciliation J0 signée |
| C7 | main protégée | BLOCKED EXTERNAL | `protected: false` | OUI | Protéger `main` (PR, CI, revue, pas de push direct) et fusionner la PR #17 |
| C8 | Compliance | BLOCKED EXTERNAL | sanctions absentes ; politiques absentes | OUI | Sanctions/PPE ou décision de pilote fermé ; AML, CGU, tarification, confidentialité, plaintes publiés |
| C9 | Modules non prouvés OFF | **PASS** | test-launch-gate 88/88, 9d/9e, 6d ; kill switches | non | Maintenir `LAUNCH_MODULES=none` |

**TECHNICAL PASS** — ce que le système démontre : périmètre canary fermé aux
trois niveaux ; aucune création monétaire hors maker-checker (HTTP, clé
partagée, super_admin, SQL) ; conservation exacte ; double dépense et course
impossibles ; isolation inter-clients ; séparation opérateurs imposée par la
base ; MFA imposé ; idempotence liée au corps ; kill switches effectifs,
propagés, alertés, audités ; sauvegarde/restauration reproductibles ; boot
production refusé sans configuration explicite ; 357 routes sans credential
toutes fermées.

**OPERATIONAL PASS** — ce qui est réellement opérationnel aujourd'hui :
**rien** au sens d'un service financier réel. Il n'existe ni environnement de
production, ni opérateur, ni propriétaire de réconciliation, ni compte de
collecte.

**EXTERNAL BLOCKERS** — C1, C2, C3, C4, C5, C6, C7, C8.

## 19. Verdict

**🔴 NO-GO.**

Exactement pourquoi : C2 n'est pas validé (aucune preuve du droit de
recevoir et conserver des fonds clients) ; l'environnement réel n'existe pas
(C4) ; aucun opérateur réel (C3) ; limites non signées (C1) ; `main` non
protégée (C7) ; réconciliation sans propriétaire (C6) ; conformité
opérationnelle absente (C8) ; DR non démontré sur la cible (C5). Aucune
vulnérabilité critique n'est réapparue ; aucun défaut technique ne bloque.

## 20. Liste exacte des actions restantes

Modifications apportées par cette gate (documentation uniquement) :
`docs/INCIDENT_RESPONSE.md` (section 7, couverture par type d'incident), ce
document, entrée de journal. **Aucun code de production modifié.**

Actions avant le premier XOF client, dans l'ordre :

1. **Juridique (C2)** — avis écrit sur le cadre du pilote (statut, juridiction, agrément ou convention avec un établissement autorisé), ouverture du compte de collecte, règle de cantonnement ; preuve : documents signés, RIB joint au runbook.
2. **Métier (C1)** — signature du tableau des limites et de l'exposition canary (par opération, seuil de seconde signature, par client/jour en montant et nombre, par opérateur/jour, plateforme/jour, plafond mensuel, float, nombre de clients, transactions/jour) ; preuve : décision signée, valeurs reportées dans l'environnement.
3. **Conformité (C8)** — sanctions/PPE intégrés ou décision écrite de pilote fermé ; politique AML, CGU, tarification, politique de confidentialité, procédure de plaintes publiées ; délai de réponse client et forme du signalement réglementaire décidés.
4. **Hébergement (C4)** — API sur un hébergeur à tâches de fond, PostgreSQL avec PITR, rôle applicatif ≠ propriétaire, TLS, secrets générés (`KYC_ENCRYPTION_KEY` sous escrow à deux détenteurs), `LAUNCH_MODULES=none`, `CASH_IN_*` signées, `ALERT_WEBHOOK_URL` réel ; `ADMIN_API_KEY` et `VITE_ADMIN_API_KEY` absents ; preuve : journal de démarrage sans `[secrets] ERROR`, `GET /api/health/launch-scope`, `POST /api/admin/alerts/test` reçu sur le canal réel.
5. **Opérateurs (C3)** — ≥ 2 `operations`, ≥ 2 `compliance`, 1 `super_admin` de garde, tous enrôlés MFA ; preuve : `GET /api/admin/auth/users` en production avec `mfaEnrolled = true`, matrice nominative.
6. **Dépôt (C7)** — protection de `main` (PR, CI, revue obligatoires, push direct interdit), fusion de la PR #17, `main` = commit déployé.
7. **Réconciliation (C6)** — propriétaire et suppléant nommés dans `docs/RECONCILIATION_RUNBOOK.md`, première réconciliation signée à blanc en production, rapprochement bancaire testé sur un cash-in de faible montant appartenant à l'équipe.
8. **DR (C5)** — rejeu de `test-disaster-recovery.mjs` et de `scripts/db-restore.sh` sur une copie de production, PITR vérifié par une restauration à un instant, RTO mesuré et inscrit dans `docs/DISASTER_RECOVERY.md`.
9. **Rejeu de ce gate** — `test-launch-gate.mjs` et `test-canary-adversarial.mjs` contre la production vide, rapport de réconciliation `ok`, matrice §18 rejouée, signature.

Après le point 9, et seulement alors : premier cash-in réel de faible
montant appartenant à l'équipe, réconcilié et signé, avant tout client.
