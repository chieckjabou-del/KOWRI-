# AKWÊ — FINAL GO / NO-GO GATE

Décision finale de mise en production contrôlée (financial canary), fondée
sur les preuves disponibles le 14 septembre 2026. Ce document ne rouvre
aucun chantier : il constate ce qui est prouvé, ce qui ne l'est pas, et
tranche.

---

## 1. Executive decision

**🔴 NO-GO — AKWÊ ne peut pas accepter ses premiers vrais fonds clients
aujourd'hui.**

La technologie du périmètre canary est prouvée : sur le commit de référence,
1 763 vérifications en CI plus 18 attaques ciblées sur le périmètre ON
n'ont trouvé aucun moyen de créer, voler ou perdre de l'argent sans trace,
les modules non prouvés sont fermés à la route et dans les services, les
kill switches arrêtent réellement les opérations et se propagent, la
sauvegarde et la restauration sont rejouées et chronométrées.

Mais quatre conditions rendent le NO-GO obligatoire selon les règles de
cette gate, et aucune ne se corrige par du code :

1. **C2 — capacité réglementaire à détenir et manipuler des fonds clients :
   aucune preuve.** Le dépôt ne contient ni avis juridique, ni agrément, ni
   convention avec un établissement agréé, ni compte de cantonnement
   identifié. Sans cela, le premier XOF client est illégal ou, au mieux,
   non couvert.
2. **C1 — limites financières non signées.** Les plafonds existent dans le
   code et sont imposés techniquement, mais aucune décision métier écrite ne
   les valide. Une limite non décidée est une limite supposée.
3. **C3 — opérateurs non provisionnés.** Il n'existe aucun environnement
   cible dans lequel des comptes `operations`, `compliance` et `super_admin`
   nommés, enrôlés MFA, existent. Seuls des comptes de test locaux existent.
4. **C4 — aucun environnement de production n'existe ni n'a pu être
   inspecté.** L'API n'est déployée nulle part (Vercel ignore son build par
   conception, la cible Railway n'est pas configurée) ; les fronts Vercel
   sont des prévisualisations de branche. Aucun secret, aucun canal
   d'alerte, aucune base de production n'a pu être vérifié.

S'y ajoutent deux constats vérifiés qui seraient à eux seuls bloquants :
**C7 — la branche `main` n'est pas protégée** (vérifié par l'API GitHub :
`protected: false`), et **C6 — la réconciliation quotidienne n'a pas de
propriétaire nommé**.

Le verdict n'est pas CONDITIONALLY READY parce que la règle de cette gate
l'interdit quand la capacité réglementaire n'est pas validée. La liste des
conditions de fermeture est néanmoins fermée et précise (§18) : quand elles
sont toutes fournies, la décision peut être rejouée sans nouveau
développement.

---

## 2. Exact commit tested

- Dépôt : `chieckjabou-del/KOWRI-`, branche `claude/akwe-cto-audit-l7ln2q`.
- Commit : **`e268bc3500585a83257b26ac2c3b066bd2d665e8`** — identique à
  l'arbre de travail et à `origin/claude/akwe-cto-audit-l7ln2q` au moment de
  la gate (`git diff e268bc3` vide avant les modifications documentaires de
  cette gate, listées en §6).
- `main` : `afee47ac` — la PR #17 n'est pas fusionnée ; `main` ne contient
  **aucun** des contrôles décrits ici.

## 3. Exact deployment tested

| Composant | Déploiement inspecté | Constat |
|---|---|---|
| API (`artifacts/api-server`) | **Aucun déploiement de production n'existe.** Vercel `kowri-api-server` : dernier déploiement `CANCELED` (build ignoré par conception, serveur à tâches de fond inadapté au serverless). Railway : script `railway-build` présent, aucune configuration ni accès vérifiable. | Ce qui a été testé est une **instance locale** de `e268bc3` en mode développement, plus, à l'intérieur de `test-launch-gate.mjs`, une **instance locale en configuration production** (`NODE_ENV=production`, `LAUNCH_MODULES=none`, MFA imposé, sans clé partagée, limites explicites, alerting signé vers un récepteur local). |
| App mobile (`kowri-app`) | Vercel prévisualisation de branche, Ready | Front seulement ; n'a de sens qu'avec une API de production, qui n'existe pas |
| Back-office (`kowri-dashboard`, `kowri-kowri-dashboard`) | Vercel prévisualisations, Ready | Idem ; la variable `VITE_ADMIN_API_KEY` sur ces projets **n'a pas pu être lue** (NOT VERIFIED) |
| Base de données | PostgreSQL 16 local, 88 tables, 13 triggers de migration + 1 trigger installé au démarrage | Aucune base de production connue |

Conclusion : **il n'y a pas de « déploiement testé » au sens de la
production.** Toute affirmation sur la production dans ce document est
marquée NOT VERIFIED.

## 4. Launch scope

Sémantique de `LAUNCH_MODULES`, désormais explicite dans
`.env.launch.example` et `docs/DEPLOYMENT.md` : la variable ne liste que les
modules **optionnels** ; `none` = **cœur seulement**, jamais « toute activité
financière désactivée ». Le cœur n'est arrêté que par les kill switches.

| Capacité | Canary | Mécanisme |
|---|---|---|
| Inscription + OTP | ON (cœur) | `PHONE_VERIFICATION=required`, SMS obligatoire en production |
| KYC | ON (cœur) | niveaux, documents chiffrés ; **listes de sanctions : absentes** (§8) |
| Wallet, solde, historique | ON (cœur) | statut de chaque transaction affiché |
| Transferts internes | ON (cœur) | kill switch `outbound_transfers`, limiteur de vélocité, plafonds KYC |
| Cash-in manuel maker-checker | ON (cœur) | MFA, deux opérateurs distincts, troisième au-delà du seuil, limites `CASH_IN_*`, kill switch `cash_in` |
| Trésorerie | ON (cœur) | alimentée uniquement par cash-in ; seed inerte en production |
| Réconciliation, alerting, incident response | ON (cœur) | rapport + worker 6 h + alertes signées ; runbooks |
| Crédit, agents/float, cash-out, rails automatisés, FX, diaspora, tontines, épargne, pools, assurance, commissions créateurs | **OFF** | refusés à la route (503) et dans le service, schedulers inertes, kill switches dédiés |

## 5. C1–C9 matrix

### 5.1 État précédent → preuve actuelle → verdict

| Gate | État précédent (LRG) | Preuve actuelle | Verdict |
|---|---|---|---|
| C1 — Limits | DECISION REQUIRED | Limites imposées et testées (test-launch-gate 3q–3s, test-cashin) ; aucune décision signée dans le dépôt ni fournie | **BLOCKED** |
| C2 — Regulatory | PENDING | Aucun document juridique/réglementaire dans le dépôt (grep : seuls les rapports d'audit mentionnent le sujet) | **BLOCKED → NO-GO** |
| C3 — Operators | À créer | Aucun environnement cible ; base locale : 48 `operations`, 13 `compliance`, 2 `super_admin` de **test** | **BLOCKED** |
| C4 — Production env | À inspecter | Aucun déploiement API ; `.env` de production inexistant ; alerte de test reçue **uniquement** par le récepteur local du gate | **NOT VERIFIED** (bloquant) |
| C5 — Backup/Restore | Prouvé localement | Rejoué et chronométré sur cette gate (§11) ; PITR et copie de production non disponibles | PASS (local) / **NOT VERIFIED** (production) |
| C6 — Reconciliation | Runbook écrit | Réconciliation locale MATCH (§12) ; propriétaire « à nommer » | **BLOCKED** (pas de propriétaire) |
| C7 — Branch protection | À faire | GitHub API : `main` `protected: false` | **FAIL** |
| C8 — Legal/KYC/AML/Data | PENDING | KYC technique prouvé ; **aucune liste de sanctions/PPE branchée** ; CGU, tarification, politique de confidentialité, procédure de plainte absentes du dépôt | **BLOCKED** |
| C9 — Unproven modules OFF | Prouvé | Rejoué sur ce commit : test-launch-gate 88/88 (routes, services, schedulers, `LAUNCH_MODULES`, kill switches) | **PASS** |

### 5.2 Matrice GO / NO-GO

| Domaine | PASS | FAIL | NOT VERIFIED | Blocker |
|---|---|---|---|---|
| C1 Limits | technique | | décision métier | **Oui** |
| C2 Regulatory | | | capacité juridique | **Oui — NO-GO** |
| C3 Operators | modèle RBAC/MFA | | comptes réels | **Oui** |
| C4 Production | gate de boot | | environnement réel | **Oui** |
| C5 DR | local, chronométré | | PITR, copie de production | Oui (avant premier client) |
| C6 Reconciliation | rapport, runbook | | propriétaire, compte de collecte | **Oui** |
| C7 Release control | CI verte | `main` non protégé | | Oui |
| C8 Legal/KYC/AML | KYC technique | sanctions absentes | CGU, données, plaintes | **Oui** |
| C9 Modules OFF | ✔ | | | Non |

NOT VERIFIED ≠ PASS. Cinq domaines critiques sont NOT VERIFIED ou BLOCKED :
le verdict READY est impossible.

## 6. Evidence

Tout ce qui suit a été exécuté pendant cette gate sur `e268bc3`, base
PostgreSQL 16 locale.

| Preuve | Résultat |
|---|---|
| `test-gating.mjs` | 357 routes sondées sans credential, 0 ouverte |
| `test-integrity.mjs` | 198 / 198 |
| `test-cashin.mjs` | 120 / 120 |
| `test-concurrency.mjs` | 95 / 95 |
| `test-launch-gate.mjs` | 88 / 88 (instance production locale, modules OFF, MFA, kill switches inter-instances, conservation, cash-out OFF, commissions créateurs, seconde passe) |
| `test-disaster-recovery.mjs` | 65 / 65 |
| `test-canary-adversarial.mjs` (nouveau, preuve de cette gate, §13) | 18 / 18 |
| CI run #5 sur `e268bc3` | verte (typecheck + builds, suites) |
| Réconciliation locale | `ok = true`, 0 anomalie, écart de conservation 0 sur XOF/XAF/EUR/USD |
| Sauvegarde / restauration | chronométrées (§11) |
| `main` | `protected: false` (GitHub API) |
| Fichiers `.env` réels | aucun dans le dépôt ni sur le disque ; `.env*` ignorés par git |

Modifications apportées par cette gate (documentation et preuve uniquement,
aucun code de production) : `.env.launch.example` (sémantique de
`LAUNCH_MODULES`), `docs/DEPLOYMENT.md` (même clarification),
`artifacts/api-server/test-canary-adversarial.mjs`, ce document, journal.

## 7. Unresolved items

| # | Élément | Nature |
|---|---|---|
| U1 | Capacité juridique de détenir des fonds clients dans le périmètre géographique du pilote | Externe, bloquant |
| U2 | Décision métier signée sur les limites et l'exposition canary | Externe, bloquant |
| U3 | Provisionnement des opérateurs nommés, MFA enrôlé, dans l'environnement cible | Externe, bloquant |
| U4 | Environnement de production (hébergement API, base, secrets, TLS, canal d'alerte) | Externe, bloquant |
| U5 | Protection de `main` | Externe (réglage GitHub), bloquant |
| U6 | Propriétaire et suppléant de la réconciliation, compte de collecte | Externe, bloquant |
| U7 | Listes de sanctions/PPE, CGU, tarification, politique de confidentialité, procédure de plaintes | Externe, bloquant pour un public non fermé |
| U8 | PITR et rejeu de la restauration sur copie de production, RTO mesuré | Externe, avant premier client |
| U9 | `VITE_ADMIN_API_KEY` absent des projets Vercel back-office | Externe, à vérifier |
| P1 (hors gate) | Outil de contre-passation à deux signatures, endpoint de suspension client, compte ledger float agent, compteurs globaux clients/cash-in, verrou anti-force-brute partagé, rapprochement bancaire outillé | Post-launch, non bloquant pour le canary |

## 8. Regulatory status

| Exigence | Statut | Preuve |
|---|---|---|
| Statut réglementaire du pilote (EME / agent / partenariat avec un établissement agréé, juridiction du pilote) | **NOT VERIFIED — BLOCKER** | Aucun document |
| Structure juridique porteuse | NOT VERIFIED | Aucun document |
| Partenaire financier / compte de collecte / cantonnement des fonds | NOT VERIFIED | Runbook de réconciliation le prévoit ; aucun compte identifié |
| Obligations KYC (niveaux exigés) | Technique : CONFIRMED ; réglementaire : NOT VERIFIED | Niveaux KYC, documents chiffrés, workflow d'approbation |
| AML/CFT : screening | Vélocité et schémas : CONFIRMED ; **sanctions/PPE : ABSENT** | `riskScreening.ts` ne consulte aucune liste |
| Reporting réglementaire (déclarations de soupçon, incidents) | DOCUMENTED (runbook) / NOT VERIFIED (forme et délais) | — |
| Protection des données, consentements, politique de confidentialité | NOT VERIFIED | Absents du dépôt |
| Conditions générales, tarification affichée | NOT VERIFIED | Absents du dépôt ; frais calculés localement dans l'écran « Envoyer » (P2) |
| Gestion des plaintes, remboursements, litiges | DOCUMENTED (`docs/INCIDENT_RESPONSE.md`) / NOT VERIFIED (validation juridique) | — |
| Conservation des données | DOCUMENTED (10 ans dans les runbooks) / NOT VERIFIED | — |

Aucune ligne n'est CONFIRMED sur le plan réglementaire. **C2 = NO-GO.**

## 9. Operator readiness

| Attendu | Constat |
|---|---|
| ≥ 2 `operations` | Aucun compte réel ; le modèle et la matrice sont prouvés (test-operators 226/226) |
| ≥ 2 `compliance` | Aucun compte réel |
| ≥ 1 `super_admin` de garde | Aucun compte réel |
| MFA pour tous | Imposé par défaut en production (`ADMIN_MFA_REQUIRED`), prouvé (test-launch-gate 3i–3m) ; personne d'enrôlé |
| Séparation des fonctions | Imposée (initiateur ≠ approbateur ≠ second approbateur, base de données) |
| Aucun compte partagé, aucune clé de contournement | `ADMIN_API_KEY` n'est pas un credential en production quand elle est absente (prouvé) ; sa **non-définition** dans l'environnement réel : NOT VERIFIED ; `VITE_ADMIN_API_KEY` : NOT VERIFIED |

**C3 = BLOCKED.**

## 10. Production readiness

Comparaison de `.env.launch.example` avec l'environnement réel : **impossible,
il n'existe pas.** Ce que la gate garantit : un processus production
**refuse de démarrer** si l'un des éléments suivants manque ou est
incohérent (prouvé, test-launch-gate §2).

| Variable / élément | Statut réel |
|---|---|
| `DATABASE_URL`, `DATABASE_SSL` | NOT VERIFIED |
| `KYC_ENCRYPTION_KEY` (escrow) | NOT VERIFIED |
| `SIGNING_SECRET` | NOT VERIFIED |
| `SMS_PROVIDER` / `SMS_WEBHOOK_URL` | NOT VERIFIED |
| `ALERT_WEBHOOK_URL` + réception réelle de `POST /admin/alerts/test` | NOT VERIFIED (reçu et signature vérifiée **seulement** par le récepteur local du gate) |
| `CORS_ORIGINS` | NOT VERIFIED |
| `NODE_ENV=production`, `LAUNCH_MODULES=none`, `CASH_IN_*` | NOT VERIFIED (valeurs proposées dans `.env.launch.example`) |
| Kill switches | Prouvés ; état réel NOT VERIFIED |
| TLS, trusted proxy, body limits, logging, monitoring | Code présent (`app.ts`, `docs/DEPLOYMENT.md`) ; NOT VERIFIED |
| Schedulers, rails externes | Inertes hors périmètre (prouvé) ; NOT VERIFIED en réel |

Aucun secret n'a été affiché ni n'existe dans le dépôt. **C4 = NOT VERIFIED,
bloquant.**

## 11. Backup / restore result

Mesuré pendant cette gate sur la base locale (48 Mo, 4 844 écritures ledger,
2 336 transactions, 2 065 wallets, 1 037 demandes de cash-in) :

| Étape | Résultat |
|---|---|
| `scripts/db-backup.sh` (pg_dump custom + SHA-256 + manifeste) | 0,82 s, dump 4,8 Mo |
| `scripts/db-restore.sh` vers une base isolée | 1,01 s ; checksum ok ; « manifest verified: counts, migrations and money supply match » |
| Comptages après restauration | 5 196 / 2 501 / 2 247 / 1 099 (base vivante ayant continué à recevoir les suites entre les deux mesures) ; 14 triggers |
| `test-disaster-recovery.mjs` (restauration, seconde instance API, sessions, PIN, PENDING approuvé, idempotence rejouée, KYC illisible sans clé, rotation de clé, corruptions injectées) | 65 / 65 en 13 s |

| Indicateur | Valeur réelle | Valeur documentée | Statut |
|---|---|---|---|
| RPO | = intervalle entre deux dumps (24 h si dump quotidien seul) ; **aucun PITR configuré** | 15 min avec PITR | **Théorique** |
| RTO | restauration + démarrage < 1 min sur 48 Mo de test ; **non mesuré sur volume et hébergeur de production** ; le temps humain (décision, secrets, bascule) domine | 2 h | **Théorique** |

**C5 = PASS (mécanisme) / NOT VERIFIED (production).**

## 12. Reconciliation result

Réconciliation exécutée sur la base locale pendant la gate :
`ok = true`, 0 anomalie, écart de conservation 0 sur XOF, XAF, EUR, USD ;
`cashIn.ledgerMismatch = []`, `overdueOpen = 0`, `depositsWithoutAuthority = 0`.
Résultat : **MATCH** (données de test ; 216 dépôts sous autorité
non-production — `legacy_pre_gate`, `demo_seed`, `treasury_seed` — attendus
en développement et refusés en production, prouvé).

Le runbook est exploitable (sources, seuils, escalade, blocage, résolution,
rétention) mais **le propriétaire et le suppléant sont « à nommer » et le
compte de collecte n'est pas identifié**. Une réconciliation sans
propriétaire n'est pas opérationnelle. **C6 = BLOCKED.**

## 13. Final adversarial check

`test-canary-adversarial.mjs`, strictement sur le périmètre ON, contre
l'instance locale de `e268bc3` : **18 / 18**.

| Question | Résultat |
|---|---|
| Money creation | Six chemins de crédit direct × trois appelants (client, clé partagée, super_admin) : aucun 2xx ; `INSERT` SQL d'un dépôt sans autorité refusé (`DEPOSIT_WITHOUT_AUTHORITY`) ; écriture ledger non équilibrée refusée ; solde et journal inchangés |
| Money destruction | Aucune écriture ledger supprimable ou modifiable (triggers) ; conservation à 0 après tous les mouvements |
| Double spend | 10 transferts parallèles de 30 000 sur un solde de 50 000 : exactement un réussit |
| Race conditions | Deux approbations simultanées d'une même demande : une exécution, un crédit |
| Authorization | Un client ne peut ni déplacer, ni lire, ni lister le wallet d'un autre (403/404, sans fuite) ; auto-transfert refusé ; wallet gelé ne peut ni envoyer ni recevoir |
| Operator separation | L'initiateur ne peut pas approuver ; la clé partagée ne peut pas approuver ; SQL ne peut pas marquer `EXECUTED` |
| Idempotency | Même clé cinq fois en parallèle : un seul mouvement ; même clé, corps différent : 422, rien ne bouge ; montants négatifs / non finis refusés |
| Kill switch | `outbound_transfers` et `cash_in` verrouillés : 503 sur transferts et cash-in, lectures intactes, levée effective |
| Reconciliation | Tous les mouvements de la passe réconciliés (créé = exactement les trois cash-in, écart 0) ; chaque transaction visible par le client avec référence et statut |
| Recovery | Aucune transaction laissée `pending`/`processing` ; panne pendant exécution couverte par test-cashin, test-concurrency, test-disaster-recovery, rejoués sur ce commit |

Observation utile, non bloquante : le limiteur de vélocité (10 transferts /
minute / wallet) est actif et a masqué une première version de la sonde ; il
fait partie des contrôles du cœur.

## 14. Canary limits

**Aucune limite n'est signée. Les valeurs ci-dessous sont les propositions
techniques du LRG ; elles ne deviennent des limites de lancement qu'avec une
décision écrite.**

| Paramètre | Proposition | Appliqué par |
|---|---|---|
| Par cash-in | 2 000 000 XOF | `CASH_IN_MAX_PER_OPERATION` |
| Seconde signature | ≥ 500 000 XOF | `CASH_IN_SECOND_APPROVAL_THRESHOLD` |
| Par client et par jour | 5 000 000 XOF, 5 opérations | `CASH_IN_DAILY_LIMIT_PER_BENEFICIARY`, `CASH_IN_DAILY_COUNT_PER_BENEFICIARY` |
| Par opérateur et par jour | 10 000 000 XOF | `CASH_IN_DAILY_LIMIT_PER_OPERATOR` |
| Exposition quotidienne (création monétaire) | 50 000 000 XOF | `CASH_IN_DAILY_LIMIT_PLATFORM` |
| Plafond mensuel | non défini | aucun mécanisme (procédure) — DECISION REQUIRED |
| Float / trésorerie maximale | non défini | alimentée par cash-in seulement ; plafond = plafond plateforme cumulé — DECISION REQUIRED |
| Nombre maximal de clients | non défini (recommandation ≤ 500) | aucun mécanisme (contrôle à l'inscription) — DECISION REQUIRED |
| Transactions / jour | non défini | vélocité 10/min/wallet, 5 M/h, 20 M/j par wallet (`rateLimiter`) ; pas de plafond global — DECISION REQUIRED |
| Seuil d'arrêt automatique | anomalie de réconciliation → alerte critical ; autopilot | worker 6 h, autopilot |
| Suspension manuelle | `POST /admin/kill-switches/<cash_in|outbound_transfers|all>/force` par un super_admin MFA | prouvé |

**C1 = BLOCKED** tant que ce tableau n'est pas signé.

## 15. Kill-switch status

| Switch | Effet prouvé | Propagation | Alerte | Audit |
|---|---|---|---|---|
| `cash_in` | initiation et approbation refusées (503), PENDING intact | ≤ 5 s vers les autres instances (prouvé) | oui | oui |
| `outbound_transfers` | transferts refusés (503), lectures intactes | idem | oui | oui |
| `all` | tout mouvement refusé | idem | oui | oui |
| `credit`, `agent_operations`, `creator_earnings`, `cash_out`, `external_rails`, `fx` | modules déjà OFF ; switch en plus | idem | oui | oui |

État sur l'instance testée : tous `ENABLED`. Seul un `super_admin` avec
session MFA vérifiée peut tirer, verrouiller ou lever ; la levée est alertée.
État réel en production : NOT VERIFIED (pas de production).

## 16. Rollback procedure

1. **Arrêt** : `POST /api/admin/kill-switches/all/force` (super_admin MFA)
   — ou `cash_in` / `outbound_transfers` selon le doute. Effet immédiat sur
   toutes les instances (≤ 5 s). Les demandes de cash-in `PENDING` restent
   en attente, rien ne s'exécute seul.
2. **Constat** : `GET /api/admin/reconciliation/report` ; ouverture
   d'incident (`docs/INCIDENT_RESPONSE.md`).
3. **Retour de version** : redéployer le commit précédent ; les migrations
   `0000`–`0004` sont additives (tables, triggers, contraintes) — aucune
   migration inverse n'est nécessaire pour revenir à `a823b5d` ; revenir
   avant `0003`/`0004` n'est pas prévu et n'est pas souhaitable (les
   protections du ledger tomberaient).
4. **Retour de données** : `scripts/db-restore.sh` vers une base isolée,
   vérification du manifeste, bascule décidée à deux, perte bornée par le
   RPO réel (§11).
5. **Reprise** : `lift` par un super_admin **différent** de celui qui a
   résolu, après un rapport `ok = true`.

## 17. Final decision

**🔴 NO-GO.**

Obligatoire selon les règles de cette gate : capacité réglementaire non
validée (C2) ; limites financières non signées (C1) ; opérateurs critiques
absents (C3) ; secrets et configuration de production non maîtrisés parce
qu'inexistants (C4) ; réconciliation sans propriétaire (C6) ; `main` non
protégé (C7).

Ce que le NO-GO ne dit pas : il ne constate aucun défaut technique bloquant.
Sur le périmètre canary, le code de `e268bc3` fait ce qu'il prétend, et le
prouve. Le blocage est entièrement en dehors du dépôt.

## 18. Exact conditions required before first real customer money

Liste fermée. Chaque ligne se ferme par une preuve, pas par une promesse.

| # | Condition | Propriétaire | Preuve attendue | Ferme |
|---|---|---|---|---|
| 1 | Avis juridique écrit établissant le cadre du pilote (statut, juridiction, partenaire agréé ou agrément) et le cantonnement des fonds ; compte de collecte ouvert | Direction + conseil juridique | Avis signé, convention ou agrément, RIB du compte de collecte joint au runbook | C2, C6 (compte) |
| 2 | Décision métier signée sur le tableau §14 (toutes les lignes, y compris plafond mensuel, float, clients, transactions/jour) | Direction + Finance | Document signé ; valeurs reportées dans l'environnement de production | C1 |
| 3 | Environnement de production de l'API : hébergement avec tâches de fond, PostgreSQL avec PITR, rôle applicatif ≠ propriétaire, TLS, secrets générés (`KYC_ENCRYPTION_KEY` sous escrow à deux détenteurs), `LAUNCH_MODULES=none`, `CASH_IN_*` signées, `ALERT_WEBHOOK_URL` vers un canal d'astreinte réel ; `ADMIN_API_KEY` et `VITE_ADMIN_API_KEY` absents | CTO + Ops | Journal de démarrage sans `[secrets] ERROR` ; `GET /api/health/launch-scope` en production ; `POST /api/admin/alerts/test` reçu sur le canal réel (capture) | C4 |
| 4 | Comptes opérateurs nommés : ≥ 2 `operations`, ≥ 2 `compliance`, 1 `super_admin` de garde, tous MFA | CTO + Direction | `GET /api/admin/auth/users` en production : `mfaEnrolled = true` pour chacun ; matrice des personnes | C3 |
| 5 | Protection de `main` : PR obligatoire, CI obligatoire, revue obligatoire, push direct interdit ; fusion de la PR #17 | CTO | Réglage GitHub visible ; `main` = commit déployé | C7 |
| 6 | Propriétaire et suppléant de la réconciliation nommés dans le runbook ; première réconciliation signée à blanc en production ; rapprochement bancaire testé sur un cash-in réel de faible montant appartenant à l'équipe | Finance | Registre J0 signé | C6 |
| 7 | Rejeu de `test-disaster-recovery.mjs` et de `scripts/db-restore.sh` sur une copie de la base de production ; RTO mesuré ; PITR vérifié par une restauration à un instant | Ops | Rapport daté, chiffres dans `docs/DISASTER_RECOVERY.md` | C5 |
| 8 | Listes de sanctions/PPE : intégration réelle **ou** décision écrite de pilote fermé (clients nominativement connus) l'acceptant ; CGU, tarification, politique de confidentialité, procédure de plaintes publiées | Conformité + juridique | Documents publiés ; décision signée | C8 |
| 9 | Aucun module optionnel ouvert (`LAUNCH_MODULES=none`) jusqu'à une gate dédiée par module | Direction | `GET /api/health/launch-scope` | C9 (maintien) |

Quand ces neuf lignes sont fermées, la décision se rejoue en une séance,
sans développement : relancer `test-launch-gate.mjs` et
`test-canary-adversarial.mjs` contre l'environnement de production vide
(avant tout client), lire le rapport de réconciliation, et signer.
