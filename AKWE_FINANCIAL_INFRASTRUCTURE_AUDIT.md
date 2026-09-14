# AKWÊ — Financial Infrastructure Hardening Audit

Dépôt `chieckjabou-del/KOWRI-`, branche `claude/akwe-cto-audit-l7ln2q`, 13 septembre 2026.
Périmètre : la totalité du dépôt (API Express, bibliothèque `lib/db`, migrations, deux front-ends, CI, déploiement), avec **sondes HTTP réelles** contre un serveur local et un PostgreSQL 16, puis vérification directe en SQL.

Méthode : PASS 1 (découverte) — script d'attaque à l'aveugle sur le serveur tel qu'il était en début de mission ; corrections structurelles ; PASS 2 (vérification adversariale) — les mêmes attaques rejouées, puis figées dans une suite permanente (`artifacts/api-server/test-adversarial.mjs`, 85 vérifications) exécutée par la CI. Les chiffres cités sont ceux observés, pas des estimations.

---

## 1. Executive Summary

**État réel du système au début de la mission** : le grand livre était correct dans son principe (double entrée, verrous de lignes, solde dérivé des écritures) mais **onze scénarios permettaient de perdre, créer ou détourner de l'argent**, tous reproduits par des requêtes HTTP ordinaires, sans exploit technique :

| Scénario prouvé (PASS 1) | Résultat observé |
|---|---|
| Base de production vide au premier démarrage | 20 comptes créés avec le PIN `1234`, wallets approvisionnés, grand livre incohérent (5 wallets à découvert) |
| 5 remboursements simultanés d'un prêt de 50 000 | l'emprunteur a payé **250 000**, le prêt n'en enregistre que 50 000 |
| 12 réclamations de solidarité simultanées par un membre | **110 000 XOF** versés contre une réserve de 40 000 : l'argent de rotation des autres membres est parti |
| 8 virements simultanés de 40 000 sous plafond KYC de 100 000 | **320 000** transférés |
| 4 demandes de prêt simultanées à la ligne de crédit maximale (50 000) | **200 000** décaissés de la trésorerie |
| Aller-retour XAF → USD → XAF avec les taux publiés | **+400 XAF par million**, répétable, sans frais |
| `GET /transactions` par n'importe quel utilisateur | les **1 356** transactions de la plateforme, toutes lisibles |
| Même clé d'idempotence, corps différent | la seconde requête est rejouée silencieusement |
| 5 investisseurs simultanés dans un pool | totaux du pool faux (mise à jour perdue), parts mal valorisées |
| Changement de PIN | les autres sessions restent valides |
| Transfert de float agent interrompu | reste `PENDING` à jamais, float et grand livre divergent |

Aucun de ces scénarios n'était visible par la CI, qui était verte (725 vérifications).

**État après la mission** : les onze scénarios sont **corrigés à la cause** (transactions, verrous de ligne, contraintes et déclencheurs PostgreSQL, arrondi, périmètre des requêtes) et **rejoués en échec contrôlé** par la suite adversariale (85/85). Le grand livre est désormais **immuable et auto-vérifié par la base** : aucune écriture ne peut être modifiée ni supprimée, une transaction déséquilibrée ou un découvert est refusé à `COMMIT` même par un accès SQL direct. Un rapport de réconciliation financière (`GET /api/admin/reconciliation/report`) donne la masse monétaire par devise et neuf invariants, et tourne toutes les six heures. Les opérateurs disposent d'un second facteur TOTP, obligatoire en production pour toute action d'écriture. Total : 1 155 vérifications automatisées, 0 échec ; 345 routes sondées sans credential, 0 ouverte.

**Verdict de production : BLOCKED.** Non pas à cause des failles trouvées (elles sont fermées) mais parce que cinq conditions structurelles ne sont pas remplies et ne relèvent pas d'un correctif de code : (1) le cash-in plateforme reste un pouvoir de création monétaire à contrôle unique ; (2) aucun fournisseur externe (mobile money, banque) n'est câblé, donc la machine d'état des opérations en attente et la réconciliation externe n'existent pas encore ; (3) la chaîne de build n'est pas reproductible (pas de lockfile) et la protection de branche n'a pas pu être vérifiée d'ici ; (4) la politique de crédit (intérêts, défaut, approbation) n'est pas définie ; (5) sauvegarde et restauration ne sont ni documentées ni éprouvées. Le détail est en section 15.

**Réponse à la question finale** (« si AKWÊ traite 100 millions puis 1 milliard FCFA ») : ce qui peut casser est listé en section 16 ; ce qui est détecté l'est par le rapport de réconciliation et les incidents ; l'hémorragie s'arrête par les kill switches (`outbound_transfers`, `all`) et le gel de wallet ; l'état financier se reconstruit intégralement depuis `ledger_entries` (append-only) — à condition que la sauvegarde de la base soit restaurable, ce qui n'a pas été prouvé.

---

## 2. Critical Findings

Classification : P0 BLOCKER, P1 CRITICAL, P2 HIGH, P3 MEDIUM, P4 LOW. Nature : BUG TECHNIQUE, RISQUE FINANCIER, RISQUE SÉCURITÉ, RISQUE OPÉRATIONNEL, DÉCISION PRODUIT, DÉCISION RÉGLEMENTAIRE.

### AKW-01 — Fixtures de démonstration créées en production (P0, RISQUE SÉCURITÉ + FINANCIER) — CORRIGÉ
- **Composant** : `app.ts`, `lib/seed.ts`.
- **Scénario** : premier démarrage sur une base vide, en production. `seedDatabase()` s'exécutait sans condition : 20 utilisateurs (`+2250700000000`…) avec `pin_hash = sha256("1234")`, KYC niveau 2, wallets crédités par des écritures aléatoires, wallets tontine et marchands avec des soldes matérialisés sans écriture (1,6 M, 1,25 M…). Quiconque connaît ces numéros se connecte et transfère.
- **Impact financier** : création d'argent non adossé ; **impact données** : comptes fantômes avec KYC vérifié.
- **Exploitabilité** : triviale (les numéros sont dans le code source).
- **Preuve** : `POST /users/login {phone:"+2250700000003", pin:"1234"}` → 200 ; SQL : 5 wallets à découvert, 9 soldes matérialisés ≠ grand livre.
- **Cause racine** : seed non conditionné à l'environnement ; générateur produisant des transferts depuis des wallets vides ; soldes écrits sans écritures.
- **Correction** : seed uniquement hors production (`ALLOW_DEMO_SEED=true` pour forcer, refusé par la revue des secrets en production) ; générateur avec soldes courants (jamais de découvert, devise unique) ; soldes matérialisés à zéro (le grand livre est la seule vérité) ; prêts de démo dans la ligne de crédit. La chaîne de démarrage exécute chaque étape indépendamment : un fixture cassé ne saute plus la trésorerie, le bootstrap admin ni la revue des secrets (constat AKW-20).
- **Test** : base recréée depuis les seules migrations, 0 wallet à découvert, 0 dérive ; `INV-14` (rapport propre).

### AKW-02 — Remboursements de prêt simultanés : l'emprunteur paie plusieurs fois (P0, BUG TECHNIQUE → RISQUE FINANCIER) — CORRIGÉ
- **Composant** : `routes/credit.ts`.
- **Scénario** : lecture de `amountRepaid`, transfert vers la trésorerie, puis mise à jour du prêt, en trois étapes sans verrou. Cinq requêtes parallèles lisent toutes « 0 remboursé », chacune transfère, chacune écrit `amountRepaid = 0 + 50 000`.
- **Impact** : l'utilisateur perd 4 × le montant (250 000 observés pour un prêt de 50 000) ; la trésorerie encaisse sans trace de dette ; irréversible sans intervention.
- **Preuve** : PASS 1 A4 : `201,201,201,201,201`, wallet débité de 250 000, `amountRepaid = 50 000`.
- **Cause racine** : écriture métier hors de la transaction du grand livre ; contrôle « reste dû » non atomique.
- **Correction** : nouveau mécanisme `attach` dans `walletService` (écriture métier exécutée **dans** la transaction du mouvement d'argent) ; la ligne du prêt est verrouillée `FOR UPDATE`, le reste dû re-vérifié sous verrou, la ligne `loan_repayments` et le nouveau solde écrits dans la même transaction. Le décaissement marque le prêt `disbursed` dans la même transaction que le transfert.
- **Test** : `INV-3e…3i` (1 accepté, 4 × 409, un seul enregistrement, prêt `repaid`).

### AKW-03 — Réclamations de solidarité : un membre vide le pot de la tontine (P0, BUG TECHNIQUE → RISQUE FINANCIER) — CORRIGÉ
- **Composant** : `routes/communityFinance.ts` (`/solidarity-claim`).
- **Scénario** : auto-approbation si `urgence = high` et `montant ≤ réserve / membres`, décidée sur une lecture non verrouillée, réserve décrémentée après coup. Douze réclamations parallèles passent toutes ; le transfert débite le wallet du pot, qui contient aussi l'argent de rotation des autres membres.
- **Impact** : 110 000 XOF versés contre 40 000 de réserve ; réserve décrémentée d'un seul montant (mises à jour perdues).
- **Preuve** : PASS 1 A10.
- **Cause racine** : contrôle et décrément hors transaction ; aucune borne cumulée par membre.
- **Correction** : l'admissibilité est évaluée et la réserve décrémentée **sous verrou de la ligne tontine, dans la transaction du paiement** ; garde technique de part équitable (`cumul auto-approuvé du membre + montant ≤ (réserve + cumul) / membres`) ; tout refus (part épuisée, pot insuffisant, vélocité) transforme la réclamation en `pending_admin` au lieu de payer.
- **Test** : `INV-8a…8d` (1 versé, 11 en attente admin, pot −10 000, réserve 30 000).

### AKW-04 — Opérateurs sans second facteur ; clé partagée à pouvoir total (P0 par règle de mission, RISQUE SÉCURITÉ) — CORRIGÉ (à activer en production)
- **Composant** : `lib/adminAuth.ts`, `routes/adminAuth.ts`, `middleware/auth.ts`, dashboard.
- **Scénario** : un mot de passe volé (ou `ADMIN_API_KEY` fuité depuis un poste) donne `ledger.write` : cash-in illimité depuis `platform_float`.
- **Correction** : TOTP RFC 6238 sans dépendance (secret chiffré AES-256-GCM en base, enrôlement `POST /admin/auth/mfa/setup` + `/mfa/confirm`, réinitialisation par `admins.manage` avec révocation de toutes les sessions). Quand `ADMIN_MFA_REQUIRED` est actif (défaut en production), une session sans code et la clé partagée sont **réduites à la lecture** (`users.read`) : 403 `MFA_REQUIRED` sur toute écriture. Écran de connexion et d'enrôlement dans le back-office. Revue des secrets : erreur bloquante si désactivé en production.
- **Test** : `INV-13a…13i` (enrôlement, code faux refusé, connexion sans code → 401 `MFA_REQUIRED`, session vérifiée).
- **Limite** : la CI tourne en `development` (MFA non exigée) pour conserver la clé de test ; l'exigence n'est éprouvée en réduction de permissions que par revue de code (`effectivePermissions`).

### AKW-05 — Plafond KYC contournable en concurrence (P1, BUG TECHNIQUE → DÉCISION RÉGLEMENTAIRE violée) — CORRIGÉ
- **Composant** : `lib/walletService.ts`, `lib/rateLimiter.ts`.
- **Scénario** : `enforceKycLimit` et `checkRateLimit` s'exécutaient avant la transaction ; huit requêtes parallèles voient toutes un volume mensuel nul.
- **Preuve** : 320 000 XOF déplacés sous un plafond de 100 000 (niveau 0).
- **Correction** : les deux contrôles sont exécutés **dans** la transaction, après le verrou `FOR UPDATE` du wallet source, avec le client transactionnel : les débits d'un même wallet sont sérialisés, chaque contrôle voit les précédents.
- **Test** : `INV-2a/2b` (≤ 100 000 déplacés, refus typés `KYC_LIMIT`).

### AKW-06 — Ligne de crédit appliquée par prêt et non par exposition (P1, BUG TECHNIQUE → RISQUE FINANCIER) — CORRIGÉ
- **Preuve** : 4 prêts parallèles de 50 000 accordés à un profil dont la ligne est 50 000 ; 200 000 sortis de la trésorerie.
- **Correction** : la création du prêt prend un verrou consultatif par emprunteur (`pg_advisory_xact_lock`), calcule l'encours (`amount − amount_repaid` des prêts `pending/approved/disbursed`) et refuse si `encours + montant > ligne` (409 `CREDIT_LINE_EXCEEDED`). La saga transporte l'erreur d'origine (`cause`) pour un statut HTTP correct.
- **Test** : `INV-3a…3d`.

### AKW-07 — Arbitrage de change : un aller-retour crée de l'argent (P1, BUG TECHNIQUE → RISQUE FINANCIER) — CORRIGÉ
- **Composant** : `lib/fxEngine.ts`, `lib/walletService.ts` (`processFxTransfer`), `lib/diasporaService.ts`, `routes/fx.ts`.
- **Scénario** : taux semés `USD→XOF 610` et `XOF→USD 0.00164` (produit 1,0004) ; paires sans corridor = frais nuls ; arrondi au plus proche sur 4 décimales. Un utilisateur avec deux wallets et un bénéficiaire = lui-même boucle.
- **Preuve** : 1 000 000 XAF → 1 640 USD → 1 000 400 XAF. Répétable ; borné par les plafonds KYC (10 M/mois au niveau 2 ⇒ 4 000 XAF/mois/compte, multipliable par le nombre de comptes) et **illimité si un opérateur publie un couple incohérent**.
- **Correction** : (a) invariant de non-arbitrage `rate(A→B) × rate(B→A) ≤ 1` imposé à l'écriture des taux (409 `FX_ARBITRAGE`) et vérifié avant chaque conversion (une paire incohérente déjà en base bloque la conversion au lieu de payer) ; (b) conversion **arrondie vers le bas** ; (c) taux semés corrigés (`1/610`, arrondis par défaut) ; (d) `GET /fx/rates/consistency` pour les opérateurs ; (e) migration corrige la valeur semée connue. Résultat : l'aller-retour rend 999 997,4 (la plateforme garde la poussière).
- **Test** : `INV-6a…6e`, `P4-6c-pre`.
- **Reste ouvert** : frais nuls hors corridor (AKW-27, décision produit).

### AKW-08 — Transactions de tous les utilisateurs lisibles (P1, RISQUE SÉCURITÉ / données) — CORRIGÉ
- **Preuve** : `GET /transactions` par un utilisateur fraîchement créé → 1 356 transactions ; `GET /transactions/:id` d'autrui → 200.
- **Correction** : liste restreinte aux wallets du demandeur (opérateurs exceptés) ; lecture unitaire → 404 si aucun wallet du demandeur n'est impliqué (pas de divulgation d'existence).
- **Test** : `INV-5a…5d`.

### AKW-09 — Transferts de float agent sans reprise après crash (P1, RISQUE OPÉRATIONNEL → FINANCIER) — CORRIGÉ
- **Scénario** : trois transactions successives (float, grand livre, clôture). Un arrêt entre deux laisse `PENDING` : float débité chez A, crédité chez B, grand livre non mouvementé (ou l'inverse). Rien ne le reprenait.
- **Correction** : `recoverStuckFloatTransfers()` au démarrage puis toutes les 5 minutes sous verrou inter-instances, et `POST /admin/reconciliation/recover-float`. Pour chaque `PENDING` de plus de 2 minutes : jambe grand livre trouvée par sa clé d'idempotence → `COMPLETED` ; absente → postée avec la même clé (doublon impossible) ; refusée → float restitué atomiquement, `FAILED`, incident. La clé du grand livre dérive désormais de la clé d'idempotence du client (un retry ne crée plus un second transfert).
- **Test** : `INV-11a…11f` (deux crashs simulés en SQL, un seul effet chacun, seconde passe sans effet).

### AKW-10 — Grand livre modifiable et non vérifié par la base (P1, RISQUE FINANCIER) — CORRIGÉ (migration `0003`)
- **Scénario** : `UPDATE/DELETE ledger_entries` possibles (le déclencheur de résumé les gérait même « proprement ») ; aucune contrainte de montant ; une écriture à 0/0 ou négative acceptée (jambe de frais à zéro écrite systématiquement, frais > montant ⇒ crédit négatif) ; l'équilibre débit/crédit et l'absence de découvert ne tenaient qu'à des `if` applicatifs.
- **Correction** (PostgreSQL, indépendant de l'application) : déclencheur `ledger_entries_immutable` (aucune modification ni suppression) ; `transactions_protect` (montant, devise, wallets, type, référence, clé figés ; transitions d'état limitées à la machine d'états ; suppression interdite) ; déclencheur de contrainte **différé à `COMMIT`** `ledger_assert_balanced` (Σ débits = Σ crédits par transaction et devise ; aucun débit ne laisse un wallet négatif) ; `CHECK` montants ≥ 0, une seule face par écriture, `transactions.amount > 0`, `loans` cohérents, `float_balance ≥ 0`. Contraintes posées `NOT VALID` pour migrer une base existante. Côté code : `InvalidFeeError` si frais invalide, jambes de frais nulles omises.
- **Test** : `INV-12a…12g` (édition, suppression, transaction déséquilibrée, découvert et montant négatif refusés en SQL direct).

### AKW-11 — Pools d'investissement : mise à jour perdue et position hors transaction (P1, BUG TECHNIQUE → RISQUE FINANCIER) — CORRIGÉ
- **Preuve** : 5 investisseurs simultanés ⇒ `currentAmount/totalShares` faux ⇒ parts mal valorisées, rendements sur-distribués.
- **Correction** : ligne du pool verrouillée `FOR UPDATE`, totaux incrémentés et position insérée **dans** la transaction du transfert (`attach`).
- **Test** : `INV-7a…7d`.

### AKW-12 — Plan d'épargne et police d'assurance écrits après le transfert (P1, RISQUE OPÉRATIONNEL) — CORRIGÉ
- **Scénario** : crash entre le transfert et l'insertion ⇒ argent bloqué dans un wallet d'épargne sans plan pour le libérer, prime encaissée sans police.
- **Correction** : `attach` (plan/police dans la transaction du mouvement) ; re-vérification de la capacité du pool sous verrou.

### AKW-13 — Idempotence : même clé, corps différent rejoué (P2, RISQUE FINANCIER) — CORRIGÉ
- **Correction** : empreinte SHA-256 du corps canonique stockée avec la réservation (`idempotency_keys.request_hash`) ; réutilisation avec un corps différent → 422 `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- **Test** : `INV-4c`.

### AKW-14 — Retry après 5xx survenu après validation : ré-exécution possible (P2, RISQUE FINANCIER) — CORRIGÉ
- **Scénario** : le middleware libère la clé sur 5xx ; si l'erreur survient après le `COMMIT` (audit, événement), le retry ré-exécute. Les routes pools/épargne/assurance/float ne transmettaient pas la clé au grand livre.
- **Correction** : toute route argent transmet une clé dérivée de l'en-tête au grand livre (unique en base) ; un doublon devient 409 `ALREADY_PROCESSED` (jamais un second mouvement).
- **Test** : `INV-4e` (20 requêtes simultanées, 1 exécution).

### AKW-15 — Changement de PIN sans révocation des sessions (P2, RISQUE SÉCURITÉ) — CORRIGÉ
- **Test** : `INV-9a…9d`.

### AKW-16 — Montants hors échelle (P2, BUG TECHNIQUE) — CORRIGÉ
- **Scénario** : `0.00001` acceptait et créait des écritures 0/0 (6 observées) ; `1e17` provoquait une erreur SQL (500).
- **Correction** : `normalizeAmount` (arrondi à 4 décimales, refus si nul ou > 10¹⁵) sur toutes les entrées du grand livre.
- **Test** : `INV-10`.

### AKW-17 — Paiement de tontine : doublon de clé après crash ⇒ round bloqué ; reprise par `LIKE` sur la description (P2, RISQUE OPÉRATIONNEL) — CORRIGÉ
- **Correction** : un doublon de clé au paiement est traité comme « déjà payé » et l'état avance ; `recoverStuckPayouts` cherche la transaction par sa clé (`tontine-payout:…`, `tontine-hybrid:…:rotation`) et non plus par une chaîne de description sensible à la casse (les tontines hybrides n'étaient jamais reconnues).

### AKW-18 — Compteur de cotisations mis à jour hors transaction (P2) — CORRIGÉ via `attach`.

### AKW-19 — Règle de frais pouvant dépasser le montant (P2) — CORRIGÉ (`InvalidFeeError`, `CHECK` en base).

### AKW-20 — Chaîne de démarrage interrompue au premier échec (P2, RISQUE OPÉRATIONNEL) — CORRIGÉ (voir AKW-01). Observé pendant la mission : un taux semé incohérent a fait sauter la trésorerie, le bootstrap admin et la revue des secrets.

### AKW-21 — Refus métier de la saga renvoyés en 500 (P3) — CORRIGÉ (`cause`).

### Constats laissés ouverts (avec justification)

| ID | Constat | Nature | Priorité | Pourquoi ouvert |
|---|---|---|---|---|
| AKW-22 | **Cash-in plateforme à contrôle unique** : `POST /wallets/:id/deposit` (permission `ledger.write`) crédite n'importe quel wallet depuis `platform_float`, sans plafond, sans second signataire, sans pièce externe | DÉCISION PRODUIT / OPÉRATIONNEL | **P0 pour une production réelle** | Le MFA (AKW-04) durcit l'accès mais ne remplace pas un maker-checker ; le seuil, le circuit d'approbation et le rapprochement avec la pièce bancaire/mobile money sont à décider. Mitigation livrée : `platformFloat` par devise dans le rapport de réconciliation |
| AKW-23 | **Aucun fournisseur externe** : pas de webhook entrant, pas de cash-out réel (`processWithdrawal` n'est appelé nulle part ; les connecteurs sont expérimentaux) | ARCHITECTURE | P1 | La machine d'état `pending → settled/failed` avec confirmation externe, le rejeu/signature des webhooks et la réconciliation provider ↔ grand livre restent à concevoir quand un fournisseur sera choisi ; les sections 12 et 15 disent ce qu'elle doit garantir |
| AKW-24 | **Float agent = solde fantôme** : jamais alimenté depuis le grand livre (somme toujours 0 sauf transferts), cash déclaré par l'agent lui-même, rapprochement tautologique (attendu = déclaré précédent) | DÉCISION PRODUIT / OPÉRATIONNEL | P1 | Le réseau d'agents n'a pas encore de flux cash-in/cash-out réel ; le modèle (float acheté contre virement, cash compté par un superviseur) est à définir |
| AKW-25 | **Politique de crédit** : intérêts jamais perçus (champ 6–12 % sans effet), approbation automatique sur un score que l'utilisateur calcule lui-même, ni échéance, ni pénalité, ni défaut | DÉCISION PRODUIT + RÉGLEMENTAIRE | P1 | Déjà signalé à l'audit v2 ; la mécanique technique (exposition, atomicité) est corrigée, la politique ne se devine pas |
| AKW-26 | Assurance : le gestionnaire du pool adjuge seul les sinistres (collusion possible) | DÉCISION PRODUIT | P2 | Second contrôle ou seuil à définir |
| AKW-27 | Change sans corridor = frais nuls | DÉCISION PRODUIT | P2 | Défaut permissif ; l'arbitrage est fermé, la gratuité est un choix |
| AKW-28 | Jeton mobile en `localStorage`, session opérateur en `sessionStorage`, pas de CSP, pas de cookie `httpOnly`/CSRF | RISQUE SÉCURITÉ | P2 | Migration cookie `httpOnly` + jeton CSRF + CSP proposée en section 13 ; touche les deux front-ends et l'API |
| AKW-29 | Pas de lockfile | RISQUE OPÉRATIONNEL / SUPPLY CHAIN | P2 | Instruction explicite de ne pas le committer ; conséquences en section 12 |
| AKW-30 | Protection de branche `main` non vérifiable depuis cette session | RISQUE OPÉRATIONNEL | P2 | Vérifier côté GitHub ; la CI a désormais `permissions: contents: read` |
| AKW-31 | `POST /merchant/:id/payment` : chiffre d'affaires auto-déclaré qui alimente les scores de stratégie | BUG TECHNIQUE | P3 | Pas de mouvement d'argent ; à rattacher à des transactions réelles |
| AKW-32 | Limiteur de vélocité par minute en mémoire (par instance) ; le compteur base couvre le reste | RISQUE OPÉRATIONNEL | P3 | Passer le compteur minute en base ou Redis en multi-instances |
| AKW-33 | Sauvegarde / restauration ni documentées ni testées | RISQUE OPÉRATIONNEL | P1 | Section 12 |
| AKW-34 | Pas d'alerte externe (les anomalies vont dans `incidents` et les logs) | RISQUE OPÉRATIONNEL | P2 | Brancher `incidents` sur un canal d'astreinte |

---

## 3. Money Flow Map

```
USER ──(PIN/OTP)──> SESSION (24 h, hachée) ──> PERMISSIONS (propriété du wallet | rôle opérateur + MFA)
   │
   ▼
WALLET (ligne `wallets`, solde matérialisé = cache)
   │
   ▼
LEDGER  ledger_entries (append-only, Σdébit = Σcrédit par transaction/devise, aucun wallet < 0 — imposé par PostgreSQL à COMMIT)
   │
   ▼
TRANSACTION  transactions (montant/devise/wallets figés ; pending → processing → completed → reversed | failed)
   │
   ├─ IDEMPOTENCY  idempotency_keys (clé + endpoint + utilisateur + empreinte du corps) + transactions.idempotency_key UNIQUE
   ├─ LIMITS       KYC mensuel (XOF équivalent), vélocité h/24h, tx/min — évalués SOUS le verrou du wallet source
   ├─ KYC          niveau utilisateur (0/1/2/3), documents chiffrés
   ├─ RISK/FRAUD   screening synchrone avant tout verrou (rafales, montants, structuration)
   ├─ FX           exchange_rates (non-arbitrage imposé), conversion arrondie vers le bas, compte platform_fx par devise
   ├─ TREASURY     wallets de kowri_treasury (un par devise) : source des prêts, destination des remboursements
   ├─ AGENT        agents/agent_wallets (float fantôme) ↔ wallet lié (grand livre) ; liquidity_transfers avec reprise
   ├─ TONTINE      wallet de pot par tontine ; cotisations/paiements = transferts keyed par round
   ├─ CREDIT       loans (encours ≤ ligne, sous verrou emprunteur) ; loan_repayments dans la transaction du transfert
   ├─ PARTNER      (absent) — corridors/connecteurs sont des tables de configuration, aucun appel sortant réel
   ├─ WEBHOOK      sortants signés HMAC (webhookDispatcher) ; aucun webhook ENTRANT n'existe
   ├─ OUTBOX       outbox_events + processed_events (fence), reprise au démarrage
   ├─ RECONCILIATION  reconcileAllWallets (6 h) + runFinancialReconciliation (6 h, 9 invariants, masse monétaire)
   └─ REPORTING    /admin/reconciliation/report, incidents, audit_logs
```

**Où l'argent (ou sa représentation) change** — et les vingt réponses pour chaque flux :

| Flux | Déclencheur | Autorise | Débit | Crédit | Écritures | Irréversible | Crash après débit / avant crédit | Répétition | Concurrence | Réconciliation / annulation | Voit / modifie / annule |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Cash-in plateforme | opérateur `ledger.write` (+MFA en prod) | lui-même (**contrôle unique**, AKW-22) | `platform_float` | wallet | 2 | au `COMMIT` | impossible : une transaction SQL | clé d'idempotence + empreinte ; doublon → 409 | verrou wallet | rapport : `platformFloat` par devise ; annulation = `reverseTransaction` (écriture miroir, jamais suppression) | propriétaire + opérateurs / personne / opérateur via reversal |
| Virement P2P | propriétaire du wallet source | KYC, vélocité, screening | wallet A | wallet B | 2 | `COMMIT` | idem | idem | verrous A et B ordonnés, limites sous verrou | idem | parties + opérateurs |
| Remise diaspora (FX) | propriétaire | corridor, non-arbitrage | wallet A (montant+frais) | `platform_fees`, `platform_fx`, wallet B | 4–5 | `COMMIT` | idem | idem | idem | `platformFx` par devise dans le rapport | parties + opérateurs |
| Cash-out | **aucune route** (`processWithdrawal` inutilisé) | — | — | — | — | — | — | — | — | — | — |
| Prêt | emprunteur (auto-approbation, AKW-25) | ligne de crédit sous verrou | trésorerie | wallet | 2 (+ prêt `disbursed` dans la même tx) | `COMMIT` | saga : compensation = reversal keyed | clé `loan-disburse:<id>` | verrou emprunteur | encours vs trésorerie dans le rapport | emprunteur + opérateurs |
| Remboursement | emprunteur | reste dû sous verrou | wallet | trésorerie | 2 (+ `loan_repayments` + solde dans la même tx) | `COMMIT` | impossible | clé + unique | verrou ligne prêt | idem | idem |
| Cotisation tontine | scheduler (mandat) / collecte manuelle | — | wallet membre | pot | 2 (+ compteur membre) | `COMMIT` | impossible | clé par round/membre | verrous | pot = Σ cotisations − paiements | membres |
| Paiement tontine | scheduler / admin tontine | — | pot | wallet bénéficiaire | 2 | `COMMIT` ; état tontine dans une 2ᵉ tx | reprise par clé au démarrage ; doublon = « déjà payé » | clé par round | sentinelle `hasReceivedPayout = 2` | idem | membres |
| Solidarité | membre | part équitable sous verrou | pot | wallet membre | 2 (+ réserve + réclamation) | `COMMIT` | impossible | clé par réclamation | verrou tontine | réserve ≤ pot | membres, admin |
| Pool invest./rachat | investisseur | statut pool sous verrou | wallet | pot du pool | 2 (+ position + totaux) | `COMMIT` | impossible | clé | verrou pool | `Σ positions ≤ pot` (à ajouter au rapport) | investisseur, gestionnaire |
| Épargne / assurance | titulaire | — | wallet | wallet d'épargne / pot | 2 (+ plan/police) | `COMMIT` | impossible | clé | verrous | — | titulaire |
| Float agent | agent / opérateur | propriété de l'agent | float A (fantôme) puis wallet A | float B puis wallet B | 2 | 3 étapes ; reprise automatique | reprise idempotente | clé client | débit conditionnel | `agentFloat` vs wallets liés (rapport) | agents, opérateurs |
| Rendement épargne | opérateur `ledger.write` | — | `platform_float` | wallet d'épargne | 2 | `COMMIT` | — | clé jour/plan | — | passif plateforme | — |

**Qui peut créer une transaction sans passer par le chemin prévu** : personne via l'API (toutes les écritures passent par les cinq fonctions de `walletService`) ; un accès SQL direct est désormais contraint par la base (équilibre, découvert, immuabilité), mais peut encore créer une transaction *équilibrée* depuis `platform_float` — c'est le sens d'AKW-22 et de la surveillance de `platformFloat`.

---

## 4. Ledger Integrity Assessment

- **Modèle** : double entrée par transaction et par devise, comptes `wallet` (id du wallet) et `platform` (`platform_float`, `platform_fees`, `platform_fx`). Solde d'un wallet = Σ crédits − Σ débits dans sa devise ; le champ `wallets.balance` est un cache re-synchronisé dans la même transaction.
- **Vérifié mathématiquement (SQL, après les attaques)** : 0 transaction déséquilibrée ; 0 écriture négative, double face ou vide (les 6 écritures 0/0 de la PASS 1 ne peuvent plus se produire) ; 0 wallet à découvert ; 0 dérive cache/grand livre ; 0 transaction `completed` sans écriture ; identité par devise `passif utilisateurs + trésorerie + frais + FX = −platform_float` (INV-14k).
- **Garanties désormais portées par PostgreSQL** (migration `0003`) : journal append-only ; transaction figée ; équilibre et non-découvert vérifiés à `COMMIT` (déclencheur de contrainte différé) ; montants positifs. Une correction financière est une **nouvelle écriture** (`reverseTransaction`), jamais une édition : l'histoire est conservée.
- **Précision** : `numeric(20,4)` ; amounts normalisés avant comparaison ; conversions FX arrondies vers le bas (la plateforme ne paie jamais plus que l'exact). Devises XOF/XAF sans sous-unité : un montant `12.3457` est accepté aujourd'hui — l'arrondi à l'unité pour ces devises est une décision produit (P4).
- **Références** : `transactions.reference` et `idempotency_key` uniques ; clés dérivées de l'identifiant métier (`loan-disburse:<id>`, `tontine-payout:<id>:r<n>`, `float:<clé client>`).
- **Reste** : pas de partitionnement ; `ledger_balance_summary` (résumé global par déclencheur) n'est plus nécessaire à la correction mais alimente l'autopilote ; index `(account_id, currency)` et `(idempotency_key)` ajoutés pour les chemins critiques.

## 5. Treasury Assessment

- Trésorerie = wallets ordinaires de l'utilisateur système `kowri_treasury` (un par devise, créés à la demande). Toute sortie est un transfert soumis aux mêmes verrous et au même contrôle de solde : **une trésorerie négative est impossible** (verrou + déclencheur de découvert) ; un prêt sans liquidité répond 503 `TREASURY_LIQUIDITY` et la saga compense.
- Qui alimente : un opérateur `ledger.write` via cash-in (AKW-22) ; hors production, 100 M XOF/XAF semés. Qui décaisse : les emprunteurs (prêts) ; qui rembourse : les emprunteurs. Personne ne peut « créer » de la liquidité sans une écriture `platform_float` traçable.
- Rapport : `treasury` par devise et `loans.outstandingPrincipal` par devise, à comparer.
- Manque : un plafond d'exposition global (Σ encours ≤ x % de la trésorerie) — décision produit.

## 6. Agent Risk Assessment

- Accès : session du user lié ou opérateur ; création/zones/rebalance réservées à `wallets.manage`. Un agent ne peut pas agir sur un autre agent (404/403).
- Float : `executeFloatTransfer` = débit conditionnel (jamais négatif, `CHECK` ajouté), crédit, jambe grand livre keyed sur la clé client, clôture ; **reprise automatique** des `PENDING` (AKW-09). Le float n'est cependant **jamais alimenté** : c'est un compteur parallèle au wallet lié (AKW-24).
- Cash : `POST /agents/:id/cash-update` laisse l'agent fixer son propre solde cash, et le rapprochement quotidien compare une déclaration à la déclaration précédente : **le rapprochement ne prouve rien**. Un agent corrompu ne peut pas toucher le grand livre (aucune route agent ne crédite un client), mais le module n'a pas encore de flux client réel.
- Suspension : score de confiance → `SUSPENDED` ; les routes vérifient la propriété mais pas le statut `SUSPENDED` pour les transferts de float (P3, à ajouter avec le modèle cash-in/cash-out).

## 7. FX Assessment

- Écriture des taux : `system.control` (+MFA), historisée, refusée si elle crée un arbitrage. Lecture publique.
- Conversion : `getRate` exact (pas de repli 1:1), non-arbitrage vérifié avant conversion, arrondi vers le bas, jambe FX par devise dans le grand livre. Montants extrêmes testés : petits (refus sous l'unité), grands (refus au-delà de 10¹⁵), décimaux (arrondis), aller-retour (≤ départ).
- Taux figés (pas de source de marché, pas de date de péremption) : un taux « stale » reste utilisable — décision produit/opérationnelle (fixer une durée de validité, P3).
- Pools de liquidité FX (`/fx/liquidity`) : module expérimental, réservé aux opérateurs.

## 8. Credit Assessment

- **Technique** (corrigé) : exposition ≤ ligne sous verrou ; décaissement et remboursement atomiques avec le grand livre ; références uniques ; état `disbursed` cohérent.
- **Financier** (ouvert) : intérêts jamais perçus ; pas de plan de remboursement ; `dueDate` sans effet ; aucun défaut, pénalité, restructuration, write-off.
- **Produit** (ouvert) : le score est calculable par l'utilisateur lui-même (`POST /credit/scores/:id/compute`) et l'approbation est automatique ; la ligne maximale (2 M XOF) sort d'un barème codé en dur.
- **Réglementaire** (à décider) : taux d'usure, information précontractuelle, reporting.

## 9. Tontine Assessment

- Paiement = min(théorique, solde réel du pot − réserves) : jamais plus que disponible ; `shortfall` journalisé. Doublon de clé = « déjà payé ». Reprise au démarrage par clé.
- Cotisations : une clé par round et par membre ; compteur mis à jour dans la transaction.
- Solidarité : part équitable sous verrou ; le reste passe à l'admin.
- Départ / annulation : remboursement proportionnel keyed ; un membre ayant reçu son paiement ne peut pas partir.
- Ouvert : membre décédé/inactif (procédure), changement de montant en cours de route, frais de tontine via le moteur de frais (P3).

## 10. Authentication & Authorization

- Utilisateurs : PIN scrypt, sessions opaques hachées 24 h, verrouillage anti-force-brute, OTP à l'inscription (prod), révocation à la déconnexion et au changement de PIN (nouveau). Pas de liaison d'appareil (P3).
- Opérateurs : comptes nominatifs, rôles à permissions fixes, sessions 12 h, **TOTP** (nouveau) avec sessions réduites sans facteur, clé partagée réduite à la lecture quand le MFA est exigé.
- Frontières testées : USER A → données USER B (transactions 404, wallets 404, prêts 403, KYC 403) ; AGENT A → AGENT B (403) ; utilisateur → routes opérateur (345 routes sondées, 0 ouverte) ; opérateur sans permission (403 `PERMISSION_DENIED` / `MFA_REQUIRED`).
- Ouvert : rotation/expiration des clés API développeurs, liaison IP/appareil des sessions opérateur (P3).

## 11. Database Integrity

- Ajouté : contraintes `CHECK` (montants), déclencheurs d'immuabilité et d'équilibre, index critiques, colonnes MFA et empreinte d'idempotence.
- Toujours absent : clés étrangères sur les tables de phase 7 (`agents.user_id`, `loan_repayments.loan_id`, `pool_positions.pool_id`, …) — plan inchangé (détection d'orphelins puis migration dédiée, M9) ; `currency` en texte libre (contrainte de domaine possible une fois la liste arrêtée).
- Migrations : `0000`–`0003`, rejouées sur base vierge en CI et en local (l'application a tourné et passé 1 155 vérifications sur un schéma construit uniquement par les migrations). `0003` est idempotente (`DROP TRIGGER IF EXISTS`, `NOT VALID`), non destructive, réversible (suppression des déclencheurs/contraintes).

## 12. External Provider / Webhook

- **Entrant** : aucun. Il n'existe aucune route recevant un callback de fournisseur ; par conséquent aucun replay, forge, duplicat, retard ou incohérence de montant n'est encore possible — ni géré. Quand un fournisseur sera branché, le contrat minimal est : signature HMAC + horodatage ± 5 min + table de nonces ; corrélation par `reference` interne ; montant et devise comparés au grand livre avant toute écriture ; état `pending` → `settled`/`failed` en une transaction ; jamais de crédit sans transaction interne préexistante ; réconciliation quotidienne fichier fournisseur ↔ `transactions`.
- **Sortant** : webhooks signés (`X-Kowri-Signature`), 3 tentatives, cloisonnés par propriétaire ; livraison **best effort** (pas de file persistante ni de journal de livraison) — P3.
- **Outbox** : `SKIP LOCKED`, fence `processed_events`, reprise au démarrage, DLQ ; les événements morts remontent dans le rapport.

## 13. Operational Resilience

- Crash : toute opération argent est une transaction SQL unique (y compris désormais les écritures métier) ; sagas compensées par reversal keyed ; paiements de tontine et transferts de float repris automatiquement ; outbox reprise. Testé : arrêt SIGTERM propre (CI), crashs simulés de float (INV-11), doublons de clé (INV-4e).
- Multi-instances : jobs sous verrou consultatif ; limites évaluées sous verrou de ligne (donc valides entre instances) ; le compteur tx/min en mémoire est par instance (AKW-32).
- Kill switches persistants (`outbound_transfers`, `all`, …) : arrêt de l'hémorragie en une requête opérateur.
- **Backup / recovery (AKW-33)** : rien n'est documenté. Le grand livre append-only rend une restauration à un instant T cohérente par construction, mais il faut : sauvegardes PITR (WAL) sur la base managée, exercice de restauration trimestriel avec rejeu de `runFinancialReconciliation()` sur la copie, conservation hors site de `KYC_ENCRYPTION_KEY` et `SIGNING_SECRET` (sans la clé, les documents KYC et les secrets TOTP sont définitivement illisibles).
- Observabilité : rapport de réconciliation (masse monétaire par devise, PENDING, FAILED, DLQ, sagas, prêts) ; incidents ; audit. Pas d'alerte externe (AKW-34).

## 14. CI/CD & Supply Chain

- CI : typecheck + builds ; PostgreSQL 16 de service, migrations, huit suites dont l'adversariale, arrêt gracieux. `permissions: contents: read` ajouté (le jeton de job ne peut plus écrire). Node 24, pnpm 10.33.
- **Lockfile absent (AKW-29)** : chaque installation (CI, Vercel, Railway) résout à nouveau les versions ; un correctif ou une compromission publié entre deux builds entre sans revue ; `pnpm audit` inutilisable ; rollback non reproductible. Pour une infrastructure financière c'est un risque supply chain P1 ; la décision de ne pas committer le fichier est maintenue sur instruction. Stratégie recommandée : committer `pnpm-lock.yaml`, `--frozen-lockfile` partout, `pnpm audit --prod` en CI, Dependabot/Renovate avec revue.
- Scripts : `preinstall` racine impose pnpm ; aucun `postinstall` tiers observé dans les manifestes du dépôt.
- Branche `main` : la protection (CI obligatoire, revue, pas de push direct) n'a pas pu être vérifiée depuis cette session (AKW-30) — à contrôler dans les réglages GitHub.
- Vercel : projets et variables documentés (`docs/DEPLOYMENT.md`) ; `VITE_ADMIN_API_KEY` ne doit **jamais** être défini sur un projet front (la clé finirait dans le bundle public) — à vérifier dans les variables Vercel.

## 15. Data Protection

- KYC : documents chiffrés AES-256-GCM, déchiffrés uniquement pour le réviseur avec trace `kyc.documents_viewed` ; la fiche utilisateur ne donne jamais les documents (vérifié `16m`). Rotation de clé : pas d'outil de re-chiffrement (P3).
- Secrets TOTP : chiffrés avec la même clé.
- Journaux : aucun PIN, jeton ou document journalisé (revue des `console.*` des chemins argent) ; les `audit_logs` contiennent montants et identifiants, pas de données de document.
- Front-ends : jeton mobile en `localStorage` (AKW-28). Migration proposée : cookie `httpOnly; Secure; SameSite=Strict` posé par `/wallet/login`, jeton CSRF double-soumission sur les écritures, `Content-Security-Policy` stricte (`default-src 'self'`) servie par l'API pour les bundles.

## 16. Production Readiness

**BLOCKED.**

Conditions à remplir avant toute production avec argent réel, dans l'ordre :

1. **Maker-checker sur le cash-in** (AKW-22) : seuil, double signature, pièce justificative obligatoire, rapprochement bancaire. Décision produit/opérations ; implémentation ~2 jours une fois décidée.
2. **Intégration d'un fournisseur réel** avec la machine d'état décrite en section 12, et **réconciliation externe quotidienne**. Rien de cela n'existe.
3. **Reproductibilité et protection** : lockfile committé et gelé, `pnpm audit` en CI, protection de `main` vérifiée, `VITE_ADMIN_API_KEY` absent des projets front.
4. **Politique de crédit** (AKW-25) et **modèle agent** (AKW-24) décidés et implémentés — ou modules désactivés en production (`EXPERIMENTAL_MODULES` existe pour cela ; le crédit et les agents n'y sont pas encore).
5. **Sauvegarde restaurable prouvée** (AKW-33) et gestion des clés de chiffrement.
6. MFA activé en production (`ADMIN_MFA_REQUIRED` par défaut), clé partagée retirée, opérateurs enrôlés.

Une fois 1, 3, 5 et 6 faits et le crédit/agents désactivés, le noyau wallets + P2P + tontines + épargne peut passer en **CONDITIONALLY READY** pour un pilote fermé ; 2 et 4 conditionnent toute ouverture commerciale.

**Les cinq choses les plus dangereuses qui restent** :

1. Un opérateur `ledger.write` (avec son code TOTP) peut créditer n'importe quel wallet de n'importe quel montant depuis `platform_float`, seul, sans pièce : c'est la seule voie de création monétaire, et elle n'a qu'un contrôle.
2. Il n'y a aucun rail externe : l'argent n'entre et ne sort que par cet opérateur. Le jour où un fournisseur est branché, chaque défaut de conception du webhook entrant (replay, montant, retard) devient une faille de création d'argent.
3. La chaîne de build n'est pas reproductible et la protection de branche n'est pas prouvée : une dépendance compromise ou un push direct atteint la production.
4. Le crédit prête la trésorerie sur un score auto-calculé, sans intérêt, sans échéance, sans défaut : à volume, la trésorerie s'érode sans qu'aucun invariant ne le signale (le rapport montre l'encours, pas la perte attendue).
5. Sans sauvegarde restaurable et sans conservation des clés (`KYC_ENCRYPTION_KEY`, `SIGNING_SECRET`), un incident base de données détruit l'état financier et les documents d'identité de façon irrécupérable.

---

## Annexes

### A. Corrections livrées (fichiers)

`lib/walletService.ts` (normalisation, `attach`, limites sous verrou, frais, jambes nulles), `lib/rateLimiter.ts`, `routes/transactions.ts`, `routes/credit.ts`, `routes/communityFinance.ts`, `lib/communityFinance.ts`, `lib/savingsEngine.ts`, `routes/savings.ts`, `routes/investmentPools.ts`, `routes/insurancePools.ts`, `lib/fxEngine.ts`, `routes/fx.ts`, `lib/diasporaService.ts`, `lib/liquidityEngine.ts`, `routes/agents.ts`, `lib/tontineScheduler.ts`, `lib/seed.ts`, `app.ts`, `index.ts`, `lib/productAuth.ts`, `routes/users.ts`, `middleware/idempotency.ts`, `middleware/errorHandler.ts`, `lib/sagaOrchestrator.ts`, `lib/adminAuth.ts`, `routes/adminAuth.ts`, `middleware/auth.ts`, `lib/secretsCheck.ts`, `lib/financialReconciliation.ts` (nouveau), `routes/admin.ts`, `lib/auditLogger.ts`, `lib/db/src/schema/{admin,phase2}.ts`, migration `0003_sad_the_liberteens.sql`, `test-adversarial.mjs` (nouveau), `test-lib.mjs`, `test-phase4.mjs`, `.github/workflows/ci.yml`, `kowri-dashboard` (connexion avec code, enrôlement), `.env.example`, `docs/DEPLOYMENT.md`, `docs/SECURITY_SECRETS.md`.

### B. Résultats des suites (13 septembre 2026, base construite par les migrations seules)

| Suite | Résultat |
|---|---|
| `test-gating` | 345 routes, 0 ouverte |
| `test-integrity` | 197 / 197 |
| `test-phase3` | 80 / 80 |
| `test-phase4` | 106 / 106 (dont refus d'arbitrage) |
| `test-phase5` | 116 / 116 |
| `test-phase6` | 75 / 75 |
| `test-phase7` | 151 / 151 |
| `test-adversarial` | 85 / 85 |
| **Total** | **1 155 vérifications, 0 échec** |

### C. Invariants codés dans la suite adversariale

I1 aucune transaction avec Σdébit ≠ Σcrédit ; I2 un wallet ne dépense jamais plus que son solde (30 requêtes simultanées → 1 succès ; découvert refusé en SQL) ; I3 une opération idempotente exécutée N fois a l'effet d'une seule (20 simultanées → 1) ; I4 un doublon de clé n'a aucun effet financier (409) ; I5 une transaction échouée ne laisse aucun débit orphelin (transaction SQL unique) ; I6 une opération PENDING reprise n'a qu'un effet final (float) ; I7 la somme des soldes réconciliés égale le grand livre par devise ; I8 aucun utilisateur n'accède aux données financières d'un autre ; I9 aucun aller-retour de change ne rend plus que le départ ; I10 la ligne de crédit borne l'exposition totale ; I11 un remboursement ne peut être accepté qu'une fois ; I12 le journal est immuable ; I13 les opérateurs enrôlés ne se connectent pas sans second facteur.
