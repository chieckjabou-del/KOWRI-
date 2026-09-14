# AKWÊ — P0 Financial Control Gate

Base de départ : commit `37df703` (audit adversarial d'infrastructure financière, verdict **BLOCKED**). Ce gate ne refait pas l'audit : il ferme les quatre bloqueurs qu'il avait laissés ouverts, prouve chaque fermeture par une suite exécutable en CI, rejoue une seconde passe adversariale contre ses propres correctifs, et rend un verdict.

Date : 13 septembre 2026. Périmètre : `artifacts/api-server`, `lib/db`, `scripts/`, `artifacts/kowri-dashboard`, `docs/`. Toutes les preuves tournent contre un PostgreSQL 16 construit uniquement par les migrations versionnées `0000`–`0004`.

---

## 1. Verdict exécutif

**CONDITIONALLY READY** pour une mise en service **contrôlée** : cash-in manuel sous maker-checker sur preuve bancaire, sans fournisseur de paiement automatisé, avec les conditions de la section 16 remplies avant le premier XOF réel.

**BLOCKED** pour tout lancement qui inclurait, en l'état : un rail fournisseur automatisé (cash-in/cash-out par webhook), le float agent à l'échelle, ou le crédit sans politique écrite.

Ce qui a changé depuis `37df703` :

| Bloqueur | Avant | Après | Preuve |
|---|---|---|---|
| Création d'argent par un seul opérateur (`POST /wallets/:id/deposit`) | une clé, un appel, de l'argent | demande initiée par un opérateur nommé, approuvée par un autre (troisième au-delà du seuil), exécution atomique, autorité vérifiée par la base ; route directe retirée (410) ; création par `creator/earnings` fermée | `test-cashin.mjs` — 120 vérifications |
| Sauvegarde / restauration jamais exercées | scripts absents | dump vérifié, restauration isolée, seconde instance API, états `PENDING` et idempotence survivants, clés testées et rotatables | `test-disaster-recovery.mjs` — 65 vérifications |
| Réconciliation non éprouvée | 9 invariants, jamais attaqués | 16 invariants + conservation monétaire ; 13 corruptions refusées, 6 détectées, 1 nommée non détectable | section CR de la même suite |
| Contrôles opérateurs non matricés | rôles définis, non prouvés | 20 actions × 8 appelants, cycle de vie des sessions, MFA en mode production, balayage de toutes les routes d'écriture | `test-operators.mjs` — 226 vérifications |

Trouvé et corrigé pendant le gate (aucun P0 laissé ouvert) : `TRUNCATE audit_logs` passait (row triggers inertes sur TRUNCATE) ; `POST /creator/communities/:id/earnings` permettait à tout utilisateur authentifié de créer de l'argent dans le wallet d'un créateur ; erreurs de base enveloppées par drizzle non reconnues par le gestionnaire d'erreurs (doublon → 500 au lieu de 409) ; refus de float agent → 500 ; nom de kill switch inconnu → 500 ; référence de cash-in sensible à la casse (deux demandes pour une même preuve).

---

## 2. État initial constaté (37df703)

Vérifié sur le dépôt, pas supposé :

- 8 suites, 1 155 vérifications, 0 échec ; 345 routes sondées sans credential (353 aujourd'hui avec les routes cash-in) ; CI verte (run #3) ; arrêt gracieux ; 3 fronts Vercel Ready ; PR #17 ouverte.
- Création d'argent : `processDeposit` appelé par `routes/wallets.ts` (deposit direct, permission `ledger.write`, clé partagée acceptée), `lib/savingsEngine.ts` (rendement), `lib/treasury.ts` (amorçage hors production), `lib/seed.ts` (démo), **et `lib/creatorEconomy.ts`** (`distributeCreatorEarnings`, route ouverte à tout utilisateur authentifié) — ce dernier point n'était pas dans l'audit précédent : c'est un P0 supplémentaire, fermé ici.
- Aucune route de cash-out : `processWithdrawal` n'est appelé par aucune route. L'argent ne sort pas de la plateforme aujourd'hui.
- Aucun script de sauvegarde ; `audit_logs` sans protection ; `TRUNCATE` non bloqué sur aucune table.
- Rôles : `ledger.write` donnait à lui seul la création d'argent ; pas de notion d'approbation.

---

## 3. Bloqueurs traités

| # | Bloqueur | Cause racine | Fermeture |
|---|---|---|---|
| P0-A | Cash-in à contrôle unique | l'autorité de créer de l'argent était une permission, pas une décision à deux | maker-checker + autorité de dépôt vérifiée par la base |
| P0-B | Backup/restore non prouvés | rien n'existait | scripts + suite de restauration isolée + tests de clés |
| P0-C | Réconciliation non éprouvée | invariants jamais confrontés à une corruption | injection de 20 corruptions, 16 invariants, modèle de conservation |
| P0-D | Contrôles opérateurs non prouvés | matrice implicite dans le code | matrice exécutée, MFA en mode production, balayage exhaustif |

---

## 4. Architecture de contrôle

### 4.1 Création d'argent

```
opérateur A (ledger.write, session nommée, MFA en prod)
   POST /admin/cash-in  ──► cash_in_requests: PENDING_APPROVAL   (rien n'est crédité)
                              │ limites : par opération, par opérateur/jour, par bénéficiaire/jour,
                              │ plateforme/jour, seuil de seconde signature, expiration
opérateur B ≠ A (ledger.approve, session nommée, MFA en prod)
   POST /admin/cash-in/:id/approve
        montant < seuil ─► une transaction SQL : dépôt ledger + EXECUTED + décision   (ou rien)
        montant ≥ seuil ─► APPROVED, puis opérateur C ≠ A ≠ B ─► même transaction atomique
```

Ce que PostgreSQL impose, quel que soit l'appelant (application, worker, script, session SQL) — migration `0004` :

- `cash_in_requests_protect` : faits financiers figés à l'insertion ; naissance obligatoire en `PENDING_APPROVAL` sans approbation ; initiateur ≠ approbateur ≠ second approbateur ; transitions d'état limitées ; `EXECUTED` exige les approbations, une transaction **existante** qui est bien le dépôt de cette demande, et une expiration non atteinte ; état terminal figé ; jamais de `DELETE`.
- `transactions_deposit_authority` (contrainte différée, à `COMMIT`) : tout dépôt nomme une autorité ; `cash_in_request` → la demande est `EXECUTED` et pointe vers cette transaction, même wallet/montant/devise ; `reversal` → miroir d'un dépôt renversé ; `savings_yield` / `treasury_seed` / `demo_seed` acceptées (les deux dernières refusées en production par le code et signalées par la réconciliation) ; toute autre valeur ou son absence → refus.
- `ledger_float_debit_authority` : `platform_float` ne peut être débité (argent créé) que par un dépôt portant une autorité créatrice. Un « transfert » qui puise dans le float est refusé.
- `append_only_guard` sur `cash_in_decisions` et `audit_logs` ; `no_truncate` sur journal, transactions, demandes, décisions, audit.

Côté application : `processDeposit` exige un paramètre `authority` typé (le compilateur refuse un appel sans) ; la clé partagée `ADMIN_API_KEY` est refusée pour initier, approuver, rejeter, annuler (`403 SESSION_REQUIRED`) ; l'idempotence d'initiation est liée à l'identité de l'opérateur et au corps de la requête.

### 4.2 Modèle monétaire (par devise, lu dans `ledger_entries`)

```
créé     = Σ débits de platform_float          (cash-in, rendement, amorçages hors prod)
détruit  = Σ crédits de platform_float         (cash-out, renversements de dépôt)
créé − détruit = passifs utilisateurs + trésorerie + platform_fees + platform_fx   (I13)
créé sous autorité cash_in_request = Σ demandes EXECUTED                          (I11)
```

Invariants du rapport `GET /api/admin/reconciliation/report` : I1 équilibre par transaction, I2 écritures bien formées, I3 aucun wallet à découvert, I4 solde matérialisé = ledger, I5 transactions bloquées, I6 float agent bloqué, I7 transaction complétée sans écriture, I8 arbitrage FX, I9 idempotence bloquée, **I10** autorité de dépôt, **I11** cash-in = ledger, **I12** expiration en panne, **I13** conservation, **I14** réserve de solidarité couverte, **I15** pool = positions = wallet, **I16** réponse idempotente orpheline. Non assertable : float agent (§13).

### 4.3 Opérateurs

Rôles à permissions fixes ; `ledger.approve` ajouté (super_admin, compliance) ; `ledger.write` (super_admin, operations) initie. Un `super_admin` détient les deux mais reste soumis à la séparation par demande. Sous `ADMIN_MFA_REQUIRED` (défaut en production), toute session sans second facteur et la clé partagée sont en lecture seule ; les deux signatures d'un cash-in exigent donc un second facteur.

---

## 5. Corrections apportées

| Fichier | Changement |
|---|---|
| `lib/db/src/schema/cashIn.ts`, `lib/db/migrations/0004_*.sql` | tables `cash_in_requests`, `cash_in_decisions` ; fonctions/triggers §4.1 ; étiquetage `legacy_pre_gate` des dépôts historiques |
| `artifacts/api-server/src/lib/cashIn.ts` | initiation (limites sous verrou consultatif, doublon de référence, avertissement de demande similaire), approbation (1 ou 2 signatures, exécution atomique via `attach`), rejet, annulation, expiration, lectures |
| `src/routes/cashIn.ts`, `src/routes/index.ts` | `/api/admin/cash-in` (list, limits, initiate, approve, reject, cancel, expire, detail) |
| `src/lib/walletService.ts` | `DepositAuthority` obligatoire, métadonnées d'autorité, `attach` reçoit l'identifiant de transaction, renversement de dépôt marqué `reversal` |
| `src/routes/wallets.ts` | `POST /:walletId/deposit` → 410 `CASH_IN_MAKER_CHECKER_REQUIRED` |
| `src/lib/creatorEconomy.ts`, `src/routes/creatorEconomy.ts`, `kowri-app/src/pages/CreatorDetail.tsx` | déclaration de gains sans crédit, réservée au créateur ; texte du mobile corrigé |
| `src/lib/adminAuth.ts`, `src/middleware/auth.ts`, `src/middleware/idempotency.ts` | permission `ledger.approve`, `requireOperatorSession`, idempotence scopée par identité opérateur |
| `src/lib/financialReconciliation.ts` | I10–I16, `created`/`destroyed`/`createdByAuthority`/`conservationGap`, bloc `cashIn` |
| `src/middleware/errorHandler.ts`, `src/lib/walletService.ts`, `src/routes/cashIn.ts` | erreurs drizzle déballées (`cause`) ; `INSUFFICIENT_FLOAT` 409 ; `DEPOSIT_AUTHORITY_REQUIRED` 403 |
| `src/lib/liquidityEngine.ts`, `src/lib/killSwitch.ts`, `src/routes/admin.ts` | `InsufficientFloatError`, `isKillSwitchName`, 404 sur nom inconnu |
| `src/lib/fieldCrypto.ts`, `src/tools/rotateKycKey.ts` | chiffrement/déchiffrement par clé explicite, outil de rotation transactionnel multi-clés |
| `src/index.ts` | balayage d'expiration des demandes toutes les 5 min sous verrou d'instance |
| `scripts/db-backup.sh`, `scripts/db-restore.sh` | sauvegarde (checksum, manifeste) et restauration (refus si checksum faux ou cible non vide, comparaison au manifeste) |
| `kowri-dashboard/src/pages/AdminCashIn.tsx`, `layout.tsx`, `App.tsx` | écran Cash-in (initier, approuver, rejeter, annuler, limites, avertissements) |
| `test-lib.mjs` | `fund()` passe par le maker-checker avec trois comptes nommés, rotation de maker au plafond journalier |
| `test-cashin.mjs`, `test-disaster-recovery.mjs`, `test-operators.mjs`, `test-concurrency.mjs` | nouvelles suites, en CI |
| `docs/DISASTER_RECOVERY.md`, `docs/EXTERNAL_RAIL_ARCHITECTURE.md`, `docs/SECURITY_SECRETS.md`, `docs/DEPLOYMENT.md`, `.env.example`, `.github/workflows/ci.yml` | documentation et CI |

---

## 6. Preuves d'exécution

Toutes les suites tournent contre un serveur réel et une base réelle ; les vérifications SQL passent par `psql` ; deux instances API supplémentaires sont lancées par les suites (base restaurée ; `ADMIN_MFA_REQUIRED=true`).

| Suite | Vérifications | Ce qu'elle prouve |
|---|---|---|
| `test-gating.mjs` | 353 routes | aucune route hors liste publique ne répond sans credential |
| `test-integrity.mjs` | 198 | flux d'argent, KYC, rôles, documents chiffrés |
| `test-phase3/4/5/7.mjs`, `test-phase6.mjs` | 80 / 106 / 116 / 152 / 75 | suites héritées adaptées au maker-checker |
| `test-adversarial.mjs` | 85 | double dépense, plafonds, crédit, FX, idempotence, reprise, invariants DB, MFA |
| `test-cashin.mjs` | 120 | §12 |
| `test-operators.mjs` | 226 | §11 |
| `test-concurrency.mjs` | 95 | §8 |
| `test-disaster-recovery.mjs` | 65 | §9 et §10 |
| **Total** | **1 671 vérifications, 0 échec** | |

Typecheck API, libs, dashboard et app mobile : 0 erreur ; builds des deux fronts : OK.

---

## 7. Attaques exécutées

### 7.1 Cash-in (24 attaques exigées, toutes exécutées)

| Attaque | Résultat |
|---|---|
| Sans authentification | 403 (initier, approuver, rejeter, annuler, lister) |
| Utilisateur produit (bearer) vers son propre wallet | 403 |
| Opérateur sous-privilégié (support, auditor, compliance pour initier ; operations, support pour approuver) | 403 `PERMISSION_DENIED` avec la permission manquante |
| Clé partagée | 403 `SESSION_REQUIRED` partout |
| Auto-approbation (API et SQL) | 403 / `CASH_IN_SELF_APPROVAL` ; seconde signature par le premier signataire ou l'initiateur refusée (API et SQL) |
| 5 approbations simultanées par 3 approbateurs | une exécution, quatre 409, crédit unique |
| 10 secondes signatures simultanées | une exécution |
| 20 demandes parallèles + 20 approbations parallèles | 20 exécutions, solde exact |
| Même opération, deux références | seconde acceptée mais marquée `SIMILAR_REQUEST` pour l'approbateur ; même référence (casse/espaces compris, deux makers, six en parallèle) → 409 |
| Même clé d'idempotence, corps différent | 422 `IDEMPOTENCY_PAYLOAD_MISMATCH` ; même corps → rejeu ; cinq en parallèle → une demande |
| Modifier montant / bénéficiaire / expiration après initiation (SQL) | `CASH_IN_IMMUTABLE` ; champs de statut/approbation dans le corps HTTP ignorés |
| Exécuter après expiration | 409 `CASH_IN_EXPIRED` (API) ; forçage SQL refusé ; balayage → `EXPIRED` ; puis 409 |
| Exécuter après rejet / annulation | 409 ; réouverture SQL refusée (`CASH_IN_CLOSED`) |
| Dépasser le plafond par opération (XOF et USD converti) | 409 `CASH_IN_LIMIT_OPERATION` |
| Dépasser le plafond journalier bénéficiaire (6 demandes parallèles à cap/4) | exactement 4 acceptées ; annulation libère le plafond |
| Wallet inexistant / mauvaise devise / gelé / propriétaire suspendu (à l'initiation et à l'exécution) | 404 / 400 / 409 |
| Wallet d'un autre utilisateur | un utilisateur ne peut rien initier ; l'opérateur choisit tout wallet **actif** sur preuve — c'est le rôle |
| Argent sans source (SQL : dépôt sans autorité, transfert puisant dans le float, autorité inventée, demande inconnue, demande non exécutée, exécution SQL sans approbation) | tous refusés à `COMMIT`, rien ne persiste |
| Crash avant/après ledger | exécution et `EXECUTED` dans une seule transaction ; échec en vol (kill switch) → demande intacte, aucune décision enregistrée ; rejeu → une exécution |
| Retry / double retry après succès | 409 / 409, crédit unique |
| Fonction interne directe (`processDeposit` sans autorité, avec demande inexistante) | `DepositAuthorityError` ; rollback par la base |
| Annulation contre approbation simultanées (6 tours) | toujours `EXECUTED`+1 transaction ou `CANCELLED`+0 |
| Trésorerie plateforme | passe par le même maker-checker |

### 7.2 Seconde passe contre les correctifs

Exécutée après les corrections (script d'attaque puis intégrée en section A10 de `test-cashin.mjs`) : smuggling de champs dans le corps, types invalides, injection, limites converties par devise, même preuve par deux makers (séquentiel et parallèle), course annulation/approbation, bénéficiaire suspendu après dépôt de la demande, restauration visant la base vivante, attribution complète de l'argent créé. Une faille trouvée et fermée : le bénéficiaire n'était re-vérifié qu'à l'initiation (désormais aussi à l'exécution, sous verrou).

---

## 8. Résultats de la passe de concurrence (2 / 5 / 10 / 20)

Pour chaque niveau : exactement le nombre « affordable » réussit, les refus sont typés (jamais 500), le ledger reste équilibré, sans découvert ni dérive.

| Opération | État affordable | Résultat |
|---|---|---|
| Approbation cash-in (une demande, N approbateurs) | 1 | 1 exécution, crédit unique |
| Transfert (solde pour 3) | 3 | 3 réussis, soldes exacts |
| Décaissement (ligne de crédit pour 1) | 1 | 1 prêt, exposition = ligne |
| Remboursement (N remboursements intégraux) | 1 | principal pris une fois |
| Pool invest (solde pour 3) / redeem (une position) | 3 / 1 | pool = positions = wallet ; un remboursement |
| FX XAF→USD (solde pour 3) | 3 | source et destination cohérentes |
| Float agent (float pour 3) | 3 | float = ledger, rien `PENDING`, refus 409 `INSUFFICIENT_FLOAT` |
| Collecte de tontine (N collectes d'un tour) | 3 membres × 1 | chacun débité une fois |
| Réclamation de solidarité (réserve 40 000 / 4) | 1 | part équitable, réserve décrémentée une fois |
| Épargne (solde pour 3 verrouillages) | 3 | verrouillé = débité |
| Liquidité trésorerie EUR (fonds pour 2 prêts, N emprunteurs) | 2 | trésorerie jamais négative, 503 `TREASURY_LIQUIDITY` pour les autres |

Non exercé : cash-out (aucune route), paiement de tontine (`tontine_payout`, couvert par la reprise par clé de l'audit précédent, pas par un burst), réserves d'assurance (pas de mouvement d'argent concurrent identifiable).

---

## 9. Sauvegarde / restauration

Voir `docs/DISASTER_RECOVERY.md` pour les procédures. Prouvé par `test-disaster-recovery.mjs` :

- dump `pg_dump` custom, instantané sérialisable, checksum SHA-256, manifeste (migrations, 13 compteurs, masse monétaire) ; dump altéré → refusé ; cible contenant un ledger → refusée ;
- restauration dans une base créée pour l'occasion : 17 agrégats identiques, 5 migrations, 14 triggers, 8 fonctions ; triggers **actifs** (trois écritures refusées) ; demande `PENDING`, réservation d'idempotence, ciphertext KYC présents ; invariants SQL vrais ;
- seconde instance API sur la restauration : sessions opérateur et utilisateur d'avant la sauvegarde valides, connexion PIN, réconciliation propre, masse monétaire cohérente, clé d'idempotence rejouée sans second débit, demande `PENDING` approuvée → `EXECUTED` (source intacte), documents lisibles ;
- clés : document lisible avec la clé, illisible avec toute autre (échec d'authentification, jamais de sortie corrompue) ; rotation transactionnelle vers une nouvelle clé (ancienne clé morte, mauvaise ancienne clé → arrêt sans écriture, `--dry-run` inerte) ; instance relancée avec un autre `SIGNING_SECRET` et la clé tournée : sessions, soldes, ledger, documents intacts.

RPO 15 min (PITR) / RTO 2 h / rétention 35 j + archivage mensuel long : **propositions** (§13).

---

## 10. Réconciliation : corruptions injectées

Dans la base restaurée (§9), par SQL direct :

| Corruption | Issue |
|---|---|
| Suppression d'une transaction / d'une écriture | **refusée** |
| Transaction dupliquée (référence ; clé d'idempotence) | **refusée** |
| Débit sans crédit | **refusée** `LEDGER_UNBALANCED` |
| Wallet négatif | **refusée** `LEDGER_OVERDRAWN` |
| Dépôt sans autorité | **refusée** |
| Écriture sans transaction | **refusée** (clé étrangère) |
| Montant réécrit / statut `completed → failed` / `created_at` modifié | **refusées** |
| Demande exécutée re-pointée | **refusée** `CASH_IN_CLOSED` |
| Audit / décisions modifiés ou supprimés ; `TRUNCATE` (avec `CASCADE`) sur journal, transactions, demandes, décisions, audit | **refusés** |
| Solde matérialisé altéré | **détectée** I4 |
| Transaction « complétée » sans écriture | **détectée** I7 |
| Transaction bloquée en `processing` | **détectée** I5 |
| Réserve de solidarité gonflée | **détectée** I14 |
| Montant de pool gonflé | **détectée** I15 |
| Réponse idempotente vers une transaction fantôme | **détectée** I16 |
| **Float agent gonflé** | **NON DÉTECTÉE** — `agent_wallets.float_balance` n'a pas de compte ledger ; nommé, classé P1 (§13) |

Aucune corruption silencieuse sur l'argent du ledger. La seule zone aveugle est le float agent, dont la source de vérité **n'est pas** le ledger aujourd'hui.

---

## 11. Contrôles opérateurs (ACTION × RÔLE × AUTH × 2FA × APPROBATION × AUDIT)

Matrice exécutée (`test-operators.mjs`, extrait ; « gate » = la permission passe, la route peut ensuite répondre 400/404 sur un identifiant factice) :

| Action | aucun | user | clé partagée | super_admin | compliance | operations | support | auditor |
|---|---|---|---|---|---|---|---|---|
| cash-in initier | 403 | 403 | 403 SESSION | gate | 403 | gate | 403 | 403 |
| cash-in approuver / rejeter / expirer | 403 | 403 | 403 SESSION | gate | gate | 403 | 403 | 403 |
| reprise float, accrual épargne | 403 | 403 | gate | gate | 403 | gate | 403 | 403 |
| revue KYC, revue AML, résolution d'alerte | 403 | 403 | gate | gate | gate | 403 | 403 | 403 |
| gel de wallet | 403 | 403 | gate | gate | gate | gate | 403 | 403 |
| statut marchand | 403 | 403 | gate | gate | 403 | gate | 403 | 403 |
| kill switch, frais, taux FX | 403 | 403 | gate | gate | 403 | 403 | 403 | 403 |
| comptes admin, rôle, reset MFA | 403 | 403 | gate | gate | 403 | 403 | 403 | 403 |
| lectures (réconciliation, cash-in, audit) | 403 | 403 | 200 | 200 | 200 | 200 | 200 | 200 |

Sous `ADMIN_MFA_REQUIRED=true` (instance dédiée) : session sans second facteur → lectures OK, initiation 403 `MFA_REQUIRED` ; clé partagée en lecture seule ; enrôlement par l'API ; la même session, vérifiée, initie ; connexion mot de passe seul refusée une fois enrôlé ; approbateur non vérifié → 403 `MFA_REQUIRED` (les **deux** signatures exigent le second facteur).

Sessions : changement de rôle, réinitialisation de mot de passe, reset MFA, désactivation, déconnexion → sessions mortes ; nouvelle session = nouveau rôle seulement ; jeton forgé refusé ; session expirée refusée avant purge ; dernier `super_admin` actif indémotable ; chaque événement en `audit_logs` avec l'opérateur.

Routes oubliées : toutes les routes d'écriture de `routes/index.ts` (statique) balayées avec un `auditor` et un `support` → aucune 2xx hors compte propre et famille du rôle.

Trail : `audit_logs`, `cash_in_decisions` non modifiables, non supprimables, non tronquables. Les actions de la clé partagée sont attribuées à `legacy-key` (aucune responsabilité individuelle) : à retirer (§16).

---

## 12. Contrôles du cash-in

Limites (XOF-équivalent, conversion au taux publié à l'initiation, variables `CASH_IN_*`) :

| Limite | Valeur proposée | Statut |
|---|---|---|
| Par opération | 10 000 000 | **décision produit** (égale au seuil de déclaration AML) |
| Seconde signature à partir de | 1 000 000 | décision produit |
| Par opérateur initiateur et par jour UTC | 50 000 000 | décision produit |
| Par bénéficiaire (tous wallets) et par jour | 20 000 000 | décision produit |
| Plateforme et par jour | 500 000 000 | décision produit |
| Expiration d'une demande | 24 h | décision produit |

Les plafonds journaliers sont lus et écrits sous un verrou consultatif : des initiations parallèles ne peuvent pas les franchir ensemble (prouvé). Les demandes annulées/rejetées/expirées ne comptent plus.

Trail complet : `cash_in_requests` (immuable), `cash_in_decisions` (append-only : initiate/approve/reject/cancel/expire, opérateur, IP), `audit_logs` (`cash_in.*` par email d'opérateur), événements `cash_in.initiated` / `cash_in.executed`.

---

## 13. Décisions produit restantes

| Décision | Impact si non prise | Catégorie |
|---|---|---|
| Valider ou modifier les six limites de cash-in | les valeurs actuelles sont des propositions du gate | PRODUIT / FINANCE |
| Politique de crédit : intérêts, défaut, pénalités, approbation humaine au-delà d'un montant, provisionnement | le crédit fonctionne techniquement (ligne = exposition, trésorerie, atomicité) mais sans règle économique écrite ; le score `maxLoanAmount` est un calcul technique, pas une politique | PRODUIT / FINANCE |
| Float agent : source de vérité | aujourd'hui `agent_wallets.float_balance` est un compteur **hors ledger** ; les transferts de float bougent le ledger des wallets d'agent ET le compteur, mais rien n'empêche le compteur de diverger, et la réconciliation ne le voit pas (§10). Décision : soit le float devient un solde ledger (compte par agent), soit le module agents reste hors périmètre de lancement | PRODUIT / TECHNIQUE |
| Commission créateur : par quoi est-elle payée ? | la déclaration ne crédite plus rien ; un vrai flux (transfert du membre payeur, ou cash-in) est à définir | PRODUIT |
| Cash-out : existe-t-il au lancement ? | aucune route aujourd'hui ; si oui, rail fournisseur (`docs/EXTERNAL_RAIL_ARCHITECTURE.md`) et politique de frais | PRODUIT |
| Sources de cash-in acceptées et pièces exigées | `bank_transfer`, `agent_cash`, `mobile_money`, `correction`, `other` sont des libellés ; la preuve exigée par source est à écrire | PRODUIT / CONFORMITÉ |
| RPO / RTO / rétention | propositions §9 ; le PITR dépend de l'hébergeur | FINANCE / TECHNIQUE |

---

## 14. Décisions réglementaires restantes

| Sujet | Où en est le code | À décider |
|---|---|---|
| Seuil de déclaration AML (10 M XOF) et structuring | screening synchrone, flags, pas de dépôt sans screening | validation du seuil, procédure de déclaration, conservation |
| KYC : niveaux, documents, revue | workflow, chiffrement, revue par `compliance` | politique par niveau, durée de conservation, droit d'accès |
| Conservation des journaux financiers | append-only, sauvegardes | durée légale (5–10 ans probables) → archivage long des dumps |
| Statut de la plateforme (EME, agent, partenariat bancaire) | hors code | conditionne le cash-in réel, le float agent, le crédit |
| Séparation des fonds clients | trésorerie plateforme et passifs utilisateurs distingués dans le modèle monétaire | compte bancaire de cantonnement et rapprochement quotidien (rail externe) |

---

## 15. Risques résiduels

| Risque | Gravité | Nature | Mitigation en place | Reste |
|---|---|---|---|---|
| Collusion de deux opérateurs (maker + checker) sur une fausse preuve | P1 | PRODUIT/CONFORMITÉ | quatre yeux, trail nominal, avertissement de demande similaire, limites journalières | contrôle a posteriori (rapprochement bancaire) — rail externe |
| Float agent hors ledger | P1 | TECHNIQUE | I6 sur les transferts, reprise après crash | source de vérité à décider (§13) |
| Rôle applicatif propriétaire des tables : peut supprimer les triggers | P1 | TECHNIQUE | aucune | séparer rôle propriétaire / rôle applicatif en production, `REVOKE` sur les fonctions de garde |
| Plafond plateforme non exercé en test (500 M) | P2 | TECHNIQUE | même code que les deux autres plafonds, prouvés | test dédié avec `CASH_IN_DAILY_LIMIT_PLATFORM` bas en CI |
| Limites évaluées au taux du jour d'initiation | P3 | FINANCE | approbation sous 24 h | ré-évaluer à l'exécution si le taux a bougé |
| Opérateur qui serait aussi utilisateur produit | P2 | CONFORMITÉ | identités distinctes (tables séparées) | politique RH ; croisement email/téléphone à la création d'un compte opérateur |
| Alerting externe absent | P1 | TECHNIQUE | incidents en base, réconciliation toutes les 6 h, journal | brancher `incidents` sur un canal d'astreinte ; alerte sur `ok:false` du rapport, sur `cash_in.overdueOpen > 0`, sur toute autorité non-production en prod |
| Verrou anti-force-brute en mémoire | P2 | TECHNIQUE | verrouillage 15 min par instance | store partagé avant scale-out |
| Protection de branche `main` / lockfile absent (instruction) | P1 | TECHNIQUE | CI verte requise par convention | protection de branche à activer ; lockfile à réévaluer |
| Le seed de démonstration hors production crée des dépôts `demo_seed` | P3 | TECHNIQUE | refusé en production par le code et signalé par I10 | — |

---

## 16. Gate final

### Matrice des contrôles

Catégories : TECH = technique, PROD = produit, FIN = finance, REG = réglementaire. État : ✅ en place et prouvé, ⚠️ en place, décision à valider, ❌ absent.

| Contrôle | État | Preuve | Test | Risque résiduel | Priorité |
|---|---|---|---|---|---|
| Création d'argent à deux opérateurs nommés | ✅ | triggers 0004 + service | `test-cashin` A1–A3, A10 | collusion (P1 PROD) | P0 clos |
| Autorité de dépôt imposée par la base | ✅ | `transactions_deposit_authority`, `ledger_float_debit_authority` | A8, CR | — | P0 clos |
| Route de dépôt direct retirée | ✅ | 410 | A8a–c, matrice | — | P0 clos |
| Création par creator/earnings fermée | ✅ | déclaration sans crédit | A8d–e, P7-6n' | flux réel à définir (PROD) | P0 clos |
| Limites cash-in | ⚠️ | env `CASH_IN_*` | A6, A10c–d | valeurs à valider (PROD/FIN) | P1 |
| Expiration des demandes | ✅ | balayage 5 min + refus à l'exécution | A5l–o, I12 | — | — |
| Trail immuable (audit, décisions, demandes) | ✅ | append-only + no-truncate | A9, opérateurs §5 | rôle propriétaire (P1 TECH) | P1 |
| Sauvegarde / restauration | ✅ | scripts + suite | DR 1–3 | PITR hébergeur (P1 TECH) | P1 |
| Escrow et rotation `KYC_ENCRYPTION_KEY` | ✅ outil / ⚠️ procédure | `rotateKycKey.ts` | DR 5 | escrow à réaliser (REG/TECH) | P0 avant prod |
| Réconciliation : 16 invariants + conservation | ✅ | rapport + planification 6 h | A9, CR, INV-14 | float agent non couvert (P1) | P1 |
| Alerting externe | ❌ | incidents en base seulement | — | silence en cas d'anomalie (P1 TECH) | P1 |
| RBAC + séparation des rôles | ✅ | matrice 20×8 | opérateurs §1 | — | — |
| MFA obligatoire en production | ✅ | instance dédiée | opérateurs §3 | enrôlement réel à faire (P0 avant prod) | P0 avant prod |
| Révocation des sessions | ✅ | cycle de vie | opérateurs §2 | — | — |
| Clé partagée | ⚠️ | refusée pour l'argent, lecture seule sous MFA | matrice | à retirer (P1 REG) | P1 |
| Routes d'écriture oubliées | ✅ | balayage statique + dynamique | opérateurs §4 | — | — |
| Concurrence sur toutes les opérations d'argent | ✅ | 2/5/10/20 | `test-concurrency` | tontine payout non exercé en burst (P2) | P2 |
| Rail fournisseur | ❌ | architecture documentée | — | tout cash-in/out automatisé (P0 pour ce périmètre) | P0 pour ce périmètre |
| Cash-out utilisateur | ❌ | aucune route | — | décision produit | PROD |
| Politique de crédit | ❌ | mécanique prouvée, politique absente | INV-3, concurrence 3–4, 11 | (PROD/FIN/REG) | P1 |
| Float agent | ⚠️ | transferts atomiques, reprise | concurrence 7, INV-11 | compteur hors ledger (P1) | P1 |

### Conditions pour passer de CONDITIONALLY READY à READY (périmètre contrôlé)

1. Valider (ou modifier) les six limites de cash-in et le seuil de seconde signature — décision produit/finance écrite.
2. Générer `KYC_ENCRYPTION_KEY`, la mettre sous escrow (deux détenteurs), et rejouer `test-disaster-recovery.mjs` contre une copie de la base de production.
3. Créer les comptes opérateurs nominatifs, enrôler leur second facteur, retirer `ADMIN_API_KEY` / `VITE_ADMIN_API_KEY`.
4. Séparer le rôle PostgreSQL propriétaire du rôle applicatif ; `REVOKE` des `DROP TRIGGER` implicites.
5. Brancher `incidents` et `reconciliation.ok=false` sur un canal d'astreinte.
6. Activer la protection de branche sur `main` avec les deux checks CI obligatoires.
7. Choisir un hébergeur PostgreSQL avec PITR et documenter le RPO/RTO retenu.
8. Tenir le float agent et le crédit hors du périmètre de lancement tant que §13 n'est pas tranché, ou les activer avec leurs décisions écrites.

Tant que 1–7 ne sont pas faits, aucun XOF réel ne doit entrer. Le rail fournisseur reste **BLOCKED** jusqu'à l'implémentation de `docs/EXTERNAL_RAIL_ARCHITECTURE.md` et sa propre passe adversariale.

---

## Annexe — Rejouer les preuves

```
# base : pnpm --filter @workspace/db migrate   (DATABASE_URL défini)
# serveur : DATABASE_URL=… PORT=8080 ADMIN_API_KEY=test-admin-key NODE_ENV=development SIGNING_SECRET=… npx tsx src/index.ts
cd artifacts/api-server
node test-gating.mjs && node test-integrity.mjs && node test-phase3.mjs && node test-phase4.mjs && node test-phase5.mjs && node test-phase7.mjs
(cd ../.. && node test-phase6.mjs)
node test-adversarial.mjs && node test-cashin.mjs && node test-operators.mjs && node test-concurrency.mjs && node test-disaster-recovery.mjs
```

`test-disaster-recovery.mjs` a besoin de `psql`, `pg_dump`, `pg_restore` et d'une connexion pouvant créer une base (`DR_ADMIN_URL`, par défaut `DATABASE_URL` sur la base `postgres`) ; `test-operators.mjs` et `test-disaster-recovery.mjs` lancent chacun une seconde instance API (ports 8091 et 8090).
