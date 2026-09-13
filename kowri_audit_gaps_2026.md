# KOWRI V5.0 — Audit Approfondi : Bugs, Failles, Incohérences et Manquements

**Date de l'audit :** 12 septembre 2026
**Portée :** Backend complet (`artifacts/api-server/src` — 35 modules de routes, ~50 fichiers `lib/`, ~21 000 lignes) + schéma DB (`lib/db/src`, ~80 tables)
**Méthode :** 6 audits indépendants approfondis (lecture ligne par ligne, vérification croisée code/schéma, pas de spéculation) sur : tontines/finance communautaire, ledger/wallets/paiements/FX, fraude/AML/compliance, auth/sécurité/API développeur, infrastructure/résilience, cohérence schéma DB.
**Ce document remplace/complète** `kowri_platform_audit.md` et `kowri_tontines_audit.md` : plusieurs affirmations de ces rapports précédents ("AML en temps réel", "moteur de fraude en parallèle", "multi-région", "message queue distribuée à 8 topics", "saga avec compensation") se révèlent **fausses ou trompeuses** à la lecture du code réel — voir Partie 0 et les sections dédiées.

---

## RÉSUMÉ EXÉCUTIF

L'audit précédent avait identifié 4 manques dans les tontines (pas de route pour quitter/annuler, event bus sans abonnés, enchères non résolues). En creusant beaucoup plus profondément, on trouve un tableau bien plus grave :

1. **Faille d'authentification totale sur les mouvements d'argent.** `/wallet/login` ne vérifie jamais le PIN. `/wallet/transfer` et `/wallet/qr/pay` n'ont **aucune authentification**. N'importe qui peut vider n'importe quel wallet avec juste un numéro de téléphone connu (lui-même récupérable via `/users`, non protégé). **C'est exploitable dès maintenant si l'API est exposée publiquement.**
2. **Plusieurs vecteurs de vol de fonds indépendants** dans les tontines/épargne/assurance/investissement (IDOR sur achat de position, rupture d'épargne, adjudication de sinistre ; création de monnaie illimitée sur les pools d'investissement).
3. **Les moteurs de fraude et d'AML ne s'exécutent quasiment jamais** sur les vraies transactions (dépôts, retraits, tontines, épargne, crédit passent tous en `skipFraudCheck:true` ou ne sont simplement pas branchés).
4. **Les virements internationaux (diaspora) créditent le mauvais montant dans la mauvaise devise** et ne prélèvent jamais les frais calculés.
5. **Les règlements et la compensation (settlements/clearing) ne touchent jamais le grand livre** — "réglé" ne veut rien dire comptablement.
6. **Le solde des wallets ignore la devise** — un dépôt en USD sur un wallet XOF pollue silencieusement le solde.
7. **Quatre machines à états complètes existent dans le schéma mais n'ont jamais été câblées côté API** : un marchand ne peut jamais devenir `active` (donc ne peut jamais recevoir de paiement), le KYC n'est jamais validé/rejeté (mais un chemin parallèle permet de s'auto-élever de tier sans aucune vérification), un wallet ne peut jamais être gelé/fermé, un utilisateur reste `pending_kyc` à vie.
8. **La résilience "entreprise" est en grande partie du décor** : la compensation de saga ne rembourse jamais l'argent déplacé, les kill switches ne couvrent qu'1 mécanisme sur 7, le "multi-région" est un modèle de données statique, le simulateur de panne et les connecteurs bancaires renvoient toujours un succès fabriqué — et tout cela est accessible **sans authentification**.

**Verdict :** l'architecture (schéma, séparation des modules, patterns de idempotence/lock/transaction *quand ils sont appliqués*) est de bonne qualité et montre un vrai savoir-faire — mais une bonne partie des fonctionnalités "annoncées" dans le premier audit sont soit non câblées de bout en bout, soit actives mais non sécurisées. La priorité absolue est la sécurité (Partie 0), avant même de discuter produit.

---

# PARTIE 0 — URGENCES SÉCURITÉ (à corriger avant tout le reste)

Ces failles permettent, dès aujourd'hui, à un attaquant non authentifié de voler de l'argent ou des données sur n'importe quel compte.

| # | Faille | Fichier:ligne | Impact |
|---|---|---|---|
| S1 | `POST /wallet/login` ne vérifie jamais le PIN | `routes/walletProduct.ts:17-33` | Bypass total : `{phone, pin:"n'importe quoi"}` renvoie un token valide pour n'importe quel compte |
| S2 | `POST /wallet/transfer` n'a **aucune** authentification | `routes/walletProduct.ts:94-113` | N'importe qui vire l'argent de n'importe quel wallet vers le sien |
| S3 | `GET /wallet/balance` et `/wallet/transactions` non authentifiés | `routes/walletProduct.ts:71-81, 115-127` | Lecture du solde et historique de n'importe quel wallet (IDOR) |
| S4 | `POST /wallet/qr/pay` non authentifié | `routes/walletProduct.ts:140-150` | Paiement QR déclenché sans identité |
| S5 | `GET /users` et `/users/:userId` non authentifiés | `routes/users.ts:32-73, 159-196` | Fuite de tous les téléphones/emails/soldes — alimente S1 |
| S6 | `admin.ts` entièrement sans auth (kill switches, config des frais) | `routes/admin.ts` (tout le fichier) | N'importe qui coupe les paiements ou modifie les frais globaux |
| S7 | `webhooks.ts` sans auth, webhooks non cloisonnés par tenant | `routes/webhooks.ts` (tout le fichier) | Exfiltration de toutes les transactions en s'abonnant anonymement |
| S8 | `securityRoute.ts` (coffre-fort de secrets) sans auth, renvoie des secrets en clair | `routes/securityRoute.ts` (tout le fichier) | `GET /security/secrets/:keyId` livre un secret déchiffré à quiconque |
| S9 | `POST /developer/login` authentifie par téléphone seul, sans PIN | `routes/developer.ts:47-58` | Combiné à S5 : usurpation d'identité complète, y compris pour voir le KYC d'un autre (`requireAuth` sans filtre de type sur plusieurs routes) |
| S10 | PIN stocké **en clair** (pas même hashé) sur 2 parcours de création de compte | `routes/developer.ts:28`, `routes/walletProduct.ts:53` | Compromission triviale des PIN en cas de fuite DB |
| S11 | Hash du PIN : SHA-256 non salé sur un espace de 4 chiffres, comparaison non "constant-time" | `routes/auth.ts:23-24`, `routes/users.ts:86,137-138,312-313` | PIN précalculable/bruteforçable, aucun rate-limit sur le login (finding S12) |
| S12 | Aucun rate-limit/verrouillage sur les endpoints de login | `auth.ts`, `users.ts:129-157`, `walletProduct.ts:17-33`, `developer.ts:47-58` | Bruteforce illimité du PIN (10 000 valeurs possibles) |
| S13 | `merchantProduct.ts` (paiements, règlements, factures) non authentifié | `routes/merchantProduct.ts:110-207` | Fuite des règlements bancaires et données clients de n'importe quel marchand |
| S14 | `support.ts` non authentifié, `userId` fourni par le client | `routes/support.ts` (tout le fichier) | N'importe qui lit/résout/referme un ticket de support (y compris signalement de fraude) |
| S15 | Idempotency-Key non scopée par utilisateur, ne périme jamais | `middleware/idempotency.ts:46-47`, schéma `phase2.ts:5-14` | Un attaquant devinant une clé commune reçoit la réponse mise en cache d'un autre utilisateur |
| S16 | Webhooks : URL non validée → SSRF | `routes/webhooks.ts:41-61`, `lib/webhookDispatcher.ts:45-56` | Le serveur peut être forcé de POSTer vers une adresse interne (ex. métadonnées cloud) |
| S17 | Tokens de session stockés en clair en DB (helper de hash jamais appelé) | `lib/productAuth.ts:14-16,28-37` | Une fuite DB donne des tokens de session directement utilisables |
| S18 | IDOR : `POST /merchants`, KYC (`GET/POST /users/:userId/kyc`), avatar — aucune vérification que l'appelant est bien le propriétaire | `routes/merchants.ts:10-16,45-80`, `routes/users.ts:199-283` | Créer un marchand pour un tiers, lire/écraser le KYC ou l'avatar de n'importe qui |
| S19 | Endpoints admin/chaos/MQ/multi-région sans auth ni garde-fou d'environnement | `routes/admin.ts`, `routes/failureSim.ts`, `routes/mq.ts`, `routes/multiRegion.ts`, `routes/sagas.ts` | N'importe qui déclenche un chaos-test ou un faux failover en "production" |

**Recommandation :** ceci doit être corrigé avant tout déploiement public, indépendamment du reste du plan. C'est un chantier à part entière (ajout systématique de `requireAuth` + vérification de propriété + hashing correct des PIN/tokens), pas une série de petits patchs.

---

# PARTIE 1 — Tontines / Finance communautaire

## Critique

1. **La rotation automatique des tontines s'arrête après le round 1** — `runPayoutCycle`/`runHybridCycle` ne recréent jamais le job `"tontine_contribution"` (`communityFinance.ts:63` le crée une seule fois ; `tontineScheduler.ts:168,231-349,496-692` ne le recrée jamais). Toute tontine à plusieurs rounds se fige après le premier cycle — seul un admin qui déclenche `/collect` manuellement pour chaque round peut la faire avancer. **MISSING**.

2. **Aucune vérification d'autorisation sur les mutations de tontines/pools** — `userId`/`buyerId`/`sellerId`/`adminUserId`/`managerId`/`adjudicatorId` viennent du corps de la requête sans être comparés à la session. Conséquences concrètes :
   - N'importe qui peut inscrire une victime dans une tontine (`communityFinance.ts:74-105`), qui sera ensuite auto-débitée à chaque cycle.
   - N'importe qui peut activer/collecter/payer une tontine dont il n'est pas admin.
   - **Vol direct** : lister sa propre position à la vente puis acheter avec `buyerId = victime` — l'argent sort du wallet de la victime sans son accord (`communityFinance.ts:279-289`, `tontineScheduler.ts:416-478`).
   - **Vol direct** : `POST /savings/plans/:planId/break` transfère le capital+rendement vers un `targetWalletId` arbitraire, sans vérifier le propriétaire du plan (`routes/savings.ts:118-137`, `savingsEngine.ts:88-136`).

3. **Adjudication de sinistre assurance sans plafond** — `payoutAmount` n'est jamais comparé à `claim.claimAmount` ni au `pool.claimLimit` ; combiné à l'absence de vérification d'`adjudicatorId` (finding 2), n'importe qui peut vider un pool d'assurance en s'auto-approuvant un remboursement égal au solde du pool (`lib/communityFinance.ts:278-327`, `routes/insurancePools.ts:172-186`).

4. **Les "rendements" des pools d'investissement sont créés à partir de rien** — `distributePoolReturns` (`lib/communityFinance.ts:89-132`, `routes/investmentPools.ts:141-150`) n'a aucune vérification que l'appelant est `pool.managerId`, aucune borne sur `totalReturn`, et utilise `processDeposit` (qui crédite depuis `platform_float`, donc **crée de la monnaie**) au lieu de débiter le wallet du pool. N'importe quel détenteur de position peut déclencher une distribution d'un montant arbitraire.

5. **Course concurrente sur la collecte de cotisations** — contrairement à `runPayoutCycle` (verrou atomique correct), `runContributionCycle` lit `contributionsCount` en mémoire sans lock métier ni clé d'idempotence dédiée par round. Le scheduler automatique et un appel manuel `/collect` peuvent tous deux débiter le même membre deux fois pour le même round et désynchroniser durablement le compteur de rounds (`tontineScheduler.ts:18-229`).

6. **Le middleware d'idempotence n'est pas atomique** (fenêtre TOCTOU) — la réservation de la clé se fait *après* l'exécution du handler, pas avant ; en multi-instance ou en cas de requêtes quasi-simultanées, le même `Idempotency-Key` peut déclencher deux exécutions (`middleware/idempotency.ts:44-90`).

7. **Les réclamations de solidarité (`solidarity claims`) reposent sur `req.auth`, qui n'est jamais défini nulle part dans le code** (`communityFinance.ts:794`) : n'importe qui peut déposer une réclamation contre n'importe quelle tontine, toutes les réclamations sont attribuées à `"anonymous"`, et l'auto-approbation "haute urgence" ne débloque en réalité **jamais** l'argent (le wallet recherché ne correspond à personne).

## Élevé

8. **Le montant des tontines "growth" recompose à chaque appel de `runContributionCycle`**, pas une fois par round — sans garde-fou par round (finding 5), une même échéance peut voir le taux de croissance appliqué plusieurs fois, corrompant durablement l'économie de la tontine (`tontineScheduler.ts:32-48`).

9. **Les deux événements les plus importants sont publiés avec un contrat de données différent de celui attendu par leurs abonnés** — `tontine.payout.completed` publie `{recipientUserId, payoutAmount}` mais l'abonné lit `{recipientId, amount}` ; `tontine.contributions.collected` publie `{collected, failed}` mais l'abonné lit `{members, amount}`. Résultat : **aucune notification de paiement ou de collecte n'est jamais envoyée**, alors que le code a l'air câblé (`tontineScheduler.ts:166,337-340` vs `services/index.ts:97-114`). C'est pire que "pas d'abonné" — ça semble fonctionner et ne fonctionne pas.

10. **Les enchères du marché secondaire (`tontine_bids`) ne sont toujours pas résolues**, et c'est plus grave que prévu : le champ `desiredPosition` n'est jamais lu (write-only), l'auction résout *toutes* les enchères en attente au moment de l'activation quel que soit leur round visé, et **gagner une enchère ne coûte jamais d'argent** au gagnant (`communityFinance.ts:219-247`, `tontineScheduler.ts:370-389`).

11. **Il n'existe toujours aucune route pour quitter une tontine active** — une route DELETE existe bien (correction du premier audit) mais uniquement pour un membre `pending` sans aucune cotisation versée. Une fois active (l'état où une tontine passe l'essentiel de sa vie), impossible de sortir (`communityFinance.ts:107-153`).

12. **Aucune route pour annuler une tontine** — confirmé, `"cancelled"` n'existe que dans l'enum, jamais écrit nulle part. Une tontine bloquée reste `pending`/`active` indéfiniment avec les fonds immobilisés.

13. **`apply-ai-order` peut désynchroniser `payoutOrder`** si la liste des membres a changé depuis le dernier calcul d'assessment IA, bloquant potentiellement un round entier ("No recipient found").

## Moyen / Faible

- 9+ types d'événements tontine sans aucun abonné (`tontine.rotation.assigned`, `.position.listed/sold`, `.goal.released`, `.hybrid.*`, `.solidarity.claim_created`, `.strategy.*`, `.ai.order_applied`).
- Les job types `"tontine_strategy_distribute"` et `"tontine_hybrid_rebalance"` sont gérés par le scheduler mais jamais créés par personne (code mort).
- Calculs monétaires en flottant JS partout (répartition de rendement, compounding growth, part des pools) — dérive d'arrondi réelle sur plusieurs cycles.
- Tie-break de l'enchère "auction" arbitraire (ordre d'insertion), non documenté.
- `routes/tontines.ts` duplique la création de tontine sans exposer les champs hybrid/strategy/growth — deux chemins de création incohérents.
- Récupération après crash (`recoverStuckPayouts`) matche par texte libre dans la description de transaction plutôt que par référence structurée — fragile.

---

# PARTIE 2 — Ledger / Wallets / Paiements / FX

**Point positif à noter :** `walletService.ts` (les 3 fonctions `processDeposit`/`processTransfer`/`processWithdrawal`) applique correctement transaction DB + verrous `FOR UPDATE` + ordre de verrouillage anti-deadlock. La partie "grand livre en partie double" tient la route **à l'intérieur** de ce fichier. Les problèmes sont presque tous à la périphérie.

## Critique

1. **Les envois diaspora créditent le mauvais montant, dans la mauvaise devise, et ne prélèvent jamais les frais** — `sendRemittance` calcule `totalDebit` (montant + frais) mais ne débite que `params.amount` ; il calcule aussi `amountReceived` via conversion de devise mais crédite en réalité le montant **non converti**, taggé avec la devise source. Un envoi de 100 EUR vers un wallet XOF crédite "+100" avec `currency:"EUR"` au lieu de ~65 000 XOF (`diasporaService.ts:87-121`). Le taux de change manquant est aussi silencieusement remplacé par un taux 1:1 (`catch` vide).

2. **L'idempotence n'est persistée que sur une minorité des routes qui bougent de l'argent** — `checkIdempotency` est appelé mais `saveIdempotentResponse` ne l'est jamais sur : `/wallet/transfer`, `/wallet/qr/pay`, paiements marchands, envoi diaspora, accroissement/rupture d'épargne, libération d'objectif tontine. Un simple retry client ré-exécute intégralement ces opérations.

3. **Settlements et clearing ne touchent jamais le grand livre** — `processSettlement`/`submitBatch`/`settleBatch` ne font que changer un statut ; aucune écriture dans `ledgerEntriesTable`. "Réglé" ne correspond à aucun mouvement d'argent traçable. Ces routes n'ont en plus aucune protection d'idempotence.

4. **Le calcul du solde ignore complètement la devise** — `getWalletBalance`/`syncWalletBalance` somment tous les mouvements du wallet sans filtrer par devise, et aucun code ne vérifie que la devise d'un dépôt/virement correspond à la devise réelle du wallet. Un dépôt USD sur un wallet XOF contamine silencieusement le solde.

5. **Transfert de float agent : l'argent bouge, puis un échec de mise à jour comptable marque le transfert "FAILED" sans le rembourser** — invite à un rejeu qui double le mouvement réel (pas de clé d'idempotence sur cet appel). Course concurrente possible en plus (lecture du solde flottant sans verrou avant décrément).

6. **Libération d'objectif d'achat tontine : transfert et mise à jour de statut non atomiques, sans idempotence** — un crash entre les deux paiements deux fois le même prestataire. Le champ `transferId` enregistré est en plus systématiquement `null` (mauvais nom de champ lu), cassant la traçabilité pour l'auditeur.

## Élevé

7. Les frais configurés pour paiements marchands, diaspora et payout tontine sont **du code mort** — `computeFee()` n'est jamais appelé que pour les retraits (`cashout`). Le revenu de frais documenté n'est techniquement pas atteignable.
8. `processWithdrawal` (retrait cash) est **entièrement implémenté et correct** dans `walletService.ts` mais **jamais appelé par aucune route** — fonctionnalité invisible côté API.
9. `savingsEngine.accrueYield` n'a aucune protection contre le rejeu — chaque retry paie un rendement supplémentaire.
10. `fxLiquidity.reserveLiquidity` : vérification puis action non atomiques (race), le pool peut passer en dessous de zéro.
11. Le trigger de synthèse globale du ledger (`ledger_balance_summary`) sérialise **tous** les mouvements d'argent du système sur une seule ligne DB — et le helper de retry sur deadlock déjà écrit (`withDeadlockRetry`) n'est jamais utilisé.

## Moyen / Faible

- `matureSavingsPlan` peut rester bloqué en "maturing" à vie après un crash.
- La limite mensuelle KYC ne compte que les transactions de type `"transfer"` — contournable via retraits/paiements marchands.
- Le QR de paiement consomme son usage unique avant même que l'argent ait bougé.
- Les totaux de facture sont acceptés du client sans validation `qty × prix`.
- Le verrou en mémoire de l'idempotence ne fonctionne pas en multi-instance.
- Sélection du barème de frais fragile (dépend d'un tri alphabétique accidentel).
- Pas de fallback taux inverse dans `fxEngine.getRate`.
- Codes d'approbation de retrait générés via `Math.random()` (non cryptographique).
- Arithmétique flottante sur les taxes/rendements/commissions un peu partout.

---

# PARTIE 3 — Fraude / AML / Compliance / Risk

**Conclusion principale :** les "moteurs" sont du code de requête compétent, mais quasiment déconnectés du chemin réel de l'argent. Le rapport initial affirme que l'AML "tourne en parallèle après chaque transaction" (`kowri_platform_audit.md:1632`) — **c'est faux**.

## Critique

1. **Le moteur AML n'est jamais invoqué automatiquement** — appelé uniquement depuis un endpoint admin manuel (`POST /aml/check`). Zéro appel depuis `processTransfer`/`processDeposit`/`processWithdrawal`.
2. **Le contrôle de fraude s'exécute après que l'argent a déjà bougé**, en fire-and-forget (`setImmediate`, erreurs avalées), et son résultat `passed` est hardcodé à `true` quels que soient les alertes — champ mort, aucun appelant ne le lit.
3. **Dépôts et retraits n'ont aucun filtrage fraude/AML** — seul le chemin `processTransfer` appelle `runFraudCheck`, jamais dépôt/retrait.
4. **Toutes les opérations produit internes désactivent explicitement le contrôle fraude** (`skipFraudCheck:true`) : tontines, finance communautaire, épargne, liquidité interne, crédit. Combiné au point 1, ces flux n'ont **aucun filtrage automatisé**.
5. **Les seuils AML ignorent la devise** — comparaison brute du montant numérique à un seuil fixe en XOF ; un virement de 50 000 EUR ne peut jamais déclencher une alerte "haute valeur".

## Élevé

6. La limite KYC mensuelle ne couvre pas les retraits et ne compte pas leur volume.
7. Le "graphe de fraude" ne grandit que via un endpoint admin manuel — jamais alimenté par les vraies transactions.
8. Pas de vrai algorithme de graphe (BFS/DFS/cycles) — la "détection de ring" est une heuristique plate (`walletIds.length >= 3 && txCount > 5`), et il n'existe aucune colonne device/IP dans le schéma.
9. Les fichiers censés être le "moteur de règles" (`rulesEngine.ts`, `strategyEngine.ts`, `globalEvaluator.ts`, `suppressionRegistry.ts`) implémentent en réalité un système d'**autopilot infrastructure** sans aucun rapport avec la fraude/AML — donc aucun moteur de règles configurable n'existe réellement pour la fraude.
10. Aucune déduplication d'alerte — une même situation peut générer des dizaines d'alertes/dossiers quasi identiques en quelques minutes.

## Moyen / Faible

- Le dashboard AML affiche des champs qui n'existent pas dans le schéma (montant/raison toujours vides).
- Un flag AML ne peut jamais être marqué "revu" (aucune route ne le permet).
- Une alerte de risque ne peut jamais être résolue/acquittée.
- Les rapports SAR sont générés manuellement uniquement, probablement vides en pratique (puisque l'AML ne tourne jamais), et ne sont jamais transmis à un régulateur — juste écrits en base.
- Taux de change fraude hardcodé (609.76) au lieu du moteur FX réel — sous-évalue les remises EUR d'environ 7%.
- `riskScore`/`flaggedCount` du graphe de fraude initialisés une fois et jamais mis à jour — 30% du score composite est mort.

---

# PARTIE 4 — Auth / Sécurité / Plateforme développeur

Voir Partie 0 pour les urgences exploitables. Constats complémentaires (non critiques immédiats mais à traiter) :

## Moyen

- Les mutations de kill switch et de configuration des frais ne sont jamais auditées (`audit()` jamais appelé), contrairement à d'autres actions du même fichier.
- Les écritures d'audit sur les mouvements réels sont attribuées à `"system"`, jamais à l'utilisateur agissant réellement.
- Aucun log d'audit sur changement de PIN, soumission KYC, changement d'avatar.
- Les endpoints d'usage/webhook de la plateforme développeur font confiance à des `developerId`/`apiKeyId` fournis par le client sans vérifier la propriété.
- Les vérifications de volume/rate-limit lisent l'état *avant* que le virement soit committé (TOCTOU) — possibilité de dépasser les plafonds en envoyant plusieurs requêtes concurrentes.

## Faible

- `stickyPrimary` dérive l'identité de routage DB depuis des champs non authentifiés du client (abus de coût possible, pas une faille d'autorisation).
- Le filtre anti-XSS/SQLi est un blocklist regex faible (mais Drizzle paramètre déjà toutes les requêtes observées, donc pas de faille avérée).
- La liste des marchands expose un extrait de clé API et le revenu à tout utilisateur authentifié, pas seulement au propriétaire.
- Les retries de webhook sont uniquement en mémoire — perdus si le process crashe entre deux tentatives.

---

# PARTIE 5 — Infrastructure / Résilience

**Conclusion principale :** plusieurs affirmations du premier audit sont surévaluées. Ce qui fonctionne réellement bien : circuit breaker, healing engine, self-optimizer, learning engine, autopilot (transitions d'état réelles, verrou avisé anti double-déclenchement). Ce qui est très en dessous de ce qui est annoncé :

## Critique

1. **La compensation de saga ne rembourse jamais l'argent déplacé** — le seul saga du code (`credit.ts`, décaissement de prêt) exécute un vrai dépôt à l'étape `execute`, mais sa `compensate` se contente de marquer le prêt `"defaulted"`, sans jamais effectuer le retrait compensatoire pourtant disponible (`processWithdrawal`).
2. **Les kill switches ne couvrent qu'1 mécanisme sur 7 annoncés** — `guard()` n'est appelé que pour `"outbound_transfers"`. Déclencher `"settlements"`, `"saga_creation"`, `"batch_writes"`, ou même `"all"`, ne bloque quasiment rien d'autre que les virements P2P/retraits. Les settlements et le décaissement de crédit continuent en marche pendant un incident "arrêté".
3. **Endpoints admin/chaos/MQ/multi-région sans authentification ni garde-fou d'environnement** (recoupe Partie 0, S19) — le simulateur de panne, le "failover" région, et le contrôle de la queue de messages sont accessibles à quiconque, y compris en ce qui devrait être la production.
4. **Le chemin de durabilité des événements par défaut est un simple buffer mémoire** — le vrai mécanisme d'outbox transactionnel existe et est bien construit, mais désactivé par défaut (variable d'env jamais définie nulle part dans le repo) ; un crash entre deux vidages de buffer perd silencieusement l'événement.

## Élevé

5. La file de messages n'a aucune reprise au démarrage ni redrive périodique (contrairement à l'outbox) — un crash pendant le dispatch perd le message définitivement sauf rejoue manuel.
6. La moitié des 8 "topics" annoncés ne sont jamais réellement publiés en code — juste définis dans le type union.
7. La "machine à états de transaction" ne vérifie jamais l'état réel persisté — elle valide des paires littérales hardcodées, donc ne peut jamais rejeter une transition invalide.
8. Le "multi-région" est un modèle de données statique (4 régions, statuts figés au chargement) — aucun routage ni failover réel.
9. Le simulateur de panne renvoie un succès fabriqué (`recovered:true` hardcodé) pour 2 scénarios sur 4, sans jamais vérifier quoi que ce soit.
10. Les connecteurs bancaires/mobile money sont des stubs `setTimeout` qui renvoient toujours `success:true` — le "ping" de santé n'appelle même jamais l'implémentation réelle.

## Moyen / Faible

- Fuite mémoire sur le graphe d'appels du tracer (aucune limite).
- Les statistiques de profondeur de la queue deviennent silencieusement fausses au-delà de 5000 lignes (pas de `ORDER BY`/agrégation SQL).
- Plusieurs endpoints de reporting système se contredisent entre eux (6 vs 8 topics, 7 vs 9 réplicas, "monolithe" vs "7 microservices" dans la même réponse).
- Le décaissement de crédit échappe totalement à la couverture des kill switches.
- Un "verdict" marketing hardcodé ("prêt pour des millions d'opérations/jour") est mêlé aux métriques réellement mesurées dans la même réponse API, sans aucun test de charge pour l'étayer.
- La persistance de l'état des kill switches est fire-and-forget sans retry — un redémarrage juste après un déclenchement peut silencieusement annuler l'arrêt d'urgence.

---

# PARTIE 6 — Cohérence Schéma DB

**Constat général :** le schéma définit des machines à états complètes et réfléchies pour les entités centrales (utilisateurs, marchands, wallets, KYC) — mais pour quatre d'entre elles, la transition "étape suivante" n'a jamais été câblée côté API. On dirait un gap systémique : les endpoints d'approbation/modération ont été pensés dans le schéma mais jamais construits, alors que les endpoints de lecture/reporting adjacents (analytics, listing compliance) ont été construits comme si l'approbation existait.

## Critique

1. **Un marchand ne peut jamais devenir `"active"`** — créé en `"pending_approval"`, aucun code ne le fait jamais passer à `"active"`. Conséquence : `POST /merchant/payment` renvoie systématiquement 403 "Merchant not active". **Le paiement marchand est fonctionnellement mort en l'état.**
2. **Le KYC n'est jamais validé/rejeté** — aucune route ne permet de passer un `kyc_records` de `"pending"` à `"verified"`/`"rejected"`. En parallèle, `/wallet/verify/identity` élève le `kycLevel` de l'utilisateur **immédiatement à la soumission**, sans aucune vérification humaine ni enregistrement KYC — un vrai contournement du contrôle réglementaire.
3. **Le gel/fermeture de wallet n'est jamais écrit ni vérifié** — même si un wallet était marqué `"frozen"` par un processus externe, `processTransfer`/`processDeposit`/`processWithdrawal` ne consultent jamais ce statut. Un wallet "gelé" continue de fonctionner normalement.
4. **Un utilisateur ne quitte jamais `"pending_kyc"`** — aucune mise à jour de `usersTable.status` nulle part après l'inscription (dormant pour l'instant car rien ne teste ce champ, mais deviendra un blocage silencieux le jour où un contrôle d'accès s'appuiera dessus).

## Élevé

5. Plusieurs filtres de requête sur colonnes enum ne sont pas validés (marchands, agents, KYC compliance, support) — un mauvais paramètre provoque une erreur Postgres brute renvoyée en 500 (fuite d'info). Un helper de validation (`VALID_KYC_STATUSES`) existe déjà mais n'est utilisé nulle part.
6. `POST /wallets` ne valide jamais `walletType` (contrairement à `currency` sur le même endpoint).
7. Le type de tontine `"hybrid"` — pourtant une vraie fonctionnalité câblée dans le scheduler — est absent de la liste blanche de la route principale de création, rendant les tontines hybrid injoignables via la voie normale.
8. Le set de validation `VALID_WALLET_STATUSES` dans le code a lui-même divergé du schéma (valeur en trop, valeur manquante).

## Moyen / Faible

- Deux états de `tontine_purchase_goals` (`funded`, `cancelled`) sont inatteignables — vérifiés dans le code mais jamais écrits.
- Arrondi de taxe de facture en centimes, incohérent avec la convention XOF entier utilisée partout ailleurs.
- `merchantId`/`investmentPoolId` sur les tontines sans contrainte de clé étrangère ni vérification d'existence.
- **Aucun répertoire de migrations n'existe** — le seul mécanisme de déploiement du schéma est `drizzle-kit push [--force]`, sans historique versionné ni possibilité de revue — risque réel pour un schéma fintech de 80 tables.
- Table `agent_rankings` importée mais jamais utilisée nulle part.
- `ledger_balance_summary`/`system_state` uniquement manipulées en SQL brut, jamais via les objets Drizzle typés (aucune protection de typage en cas de renommage futur).
- Deux tables qui semblent modéliser le même concept différemment (`tontine_bids` vs `tontine_position_listings`) — à clarifier en revue produit.

---

# PLAN D'ACTION PROPOSÉ

## Phase 1 — Sécurité critique (avant tout déploiement public)
- Ajouter `requireAuth` + vérification de propriété sur toutes les routes de la Partie 0 (S1-S19).
- Hasher correctement les PIN (salé, `timingSafeEqual`) et les tokens de session.
- Rate-limiting sur les endpoints de login.
- Valider/restreindre les URLs de webhook (anti-SSRF) et cloisonner les webhooks par marchand/développeur.

## Phase 2 — Intégrité financière (vol de fonds)
- Corriger les 4 vecteurs de vol identifiés en Partie 1 (achat de position, rupture d'épargne, adjudication de sinistre, distribution de pool d'investissement).
- Corriger le calcul diaspora (conversion de devise réelle + prélèvement des frais).
- Filtrer le solde de wallet par devise.
- Rendre l'idempotence réellement persistée sur toutes les routes qui bougent de l'argent, et corriger la fenêtre TOCTOU du middleware.

## Phase 3 — Câblage des machines à états manquantes
- Activation marchand (route d'approbation admin).
- Workflow KYC réel (approbation/rejet) + suppression ou sécurisation du chemin de contournement `/wallet/verify/identity`.
- Gel/fermeture de wallet effectifs (écriture + vérification dans `walletService`).
- Recréer le job `"tontine_contribution"` à chaque round pour débloquer la rotation automatique.

## Phase 4 — Fraude / AML réels
- Brancher `runFraudCheck`/`runAmlChecks` de manière synchrone et bloquante sur dépôts/retraits/virements, y compris les flux internes (retirer `skipFraudCheck:true` ou le remplacer par un contrôle adapté).
- Seuils AML sensibles à la devise.
- Dédoublonnage des alertes, routes pour les résoudre/marquer comme revues.

## Phase 5 — Fonctionnalités tontine manquantes + fiabilisation infra
- Route pour quitter une tontine active (avec logique de remboursement/pénalité) et pour l'annuler.
- Résolution réelle des enchères du marché secondaire (paiement effectif, respect de `desiredPosition`, résolution round par round).
- Corriger le contrat de données `eventBus` pour que les notifications de paiement/collecte fonctionnent réellement.
- Vraie compensation de saga (remboursement effectif), couverture des kill switches sur settlements/sagas/décaissement de crédit.
- Mettre en place un répertoire de migrations versionnées pour le schéma.

---

---

# JOURNAL DES CORRECTIONS

## Phase 1 — Sécurité critique (implémentée le 12 septembre 2026)

**Socle d'authentification**
- `middleware/auth.ts` : `authenticate(types?)` (pose `req.auth`), `requireAdmin` / `isAdminRequest` (clé partagée `ADMIN_API_KEY` via header `X-Admin-Key`, comparaison constant-time, refus si non configurée), `requireSelfOrAdmin`, `walletBelongsToUser`, `merchantBelongsToUser`.
- `lib/pin.ts` : hashage scrypt salé pour tout nouveau PIN, vérification constant-time, compatibilité transparente avec les anciens hashs SHA-256 (rehash automatique au premier login réussi).
- `lib/loginRateLimit.ts` : 5 échecs / 15 min par (IP, téléphone) → verrouillage 15 min, appliqué à tous les logins (`/auth/login`, `/users/login`, `/wallet/login`, `/merchant/login`, `/developer/login`).
- `lib/productAuth.ts` : les tokens de session sont désormais stockés hashés (SHA-256) en base ; **les sessions existantes sont invalidées**.
- `middleware/idempotency.ts` : clé scopée par utilisateur + chemin complet (`baseUrl`), expiration à 24 h.

**Failles fermées (Partie 0)**
- S1, S9 + login marchand : vérification effective du PIN sur `/wallet/login`, `/developer/login`, `/merchant/login`.
- S2, S3, S4 : `/wallet/transfer`, `/wallet/qr/pay`, `/wallet/qr/generate`, `/wallet/balance`, `/wallet/transactions` exigent une session `wallet` **et** la propriété du wallet source.
- S5 : `GET /users` réservé admin ; `GET /users/:id`, KYC, avatar réservés au propriétaire ou admin (S18).
- S6, S8, S19 : `admin.ts`, `securityRoute.ts`, `failureSim.ts`, `mq.ts`, `multiRegion.ts`, `sagas.ts` derrière `requireAdmin`.
- S7, S16 : `webhooks.ts` réservé admin (webhooks « système ») ; colonne `webhooks.owner_id` ajoutée ; `dispatchWebhooks` ne livre un événement qu'aux hooks système ou dont le propriétaire est concerné par l'événement ; validation anti-SSRF (`lib/webhookUrl.ts` : https obligatoire en prod, IP privées/loopback/link-local/metadata refusées, redirections non suivies). Nouveaux endpoints propriétaires : `GET/DELETE /developer/webhooks`, `GET /merchant/webhooks`.
- S10 : plus aucun PIN stocké en clair (`/wallet/create`, `/merchant/create`, `/developer/register` hashent, PIN 4-6 chiffres obligatoire, plus de PIN par défaut `000000`).
- S11, S12 : hash salé + comparaison constant-time + rate-limit.
- S13 : `merchantProduct.ts` — profil, paiements, règlements, stats, liens, factures, QR réservés au marchand propriétaire ; `/merchant/payment` initié par le client (session `wallet` + propriété du wallet source).
- S14 : `support.ts` — session requise, `userId` dérivé de la session, un utilisateur ne voit que ses tickets, résolution/statut réservés admin.
- S15 : idempotence scopée par utilisateur avec expiration.
- Bonus : `/wallet/verify/identity` ne s'auto-élève plus en `kycLevel=1` sans revue — crée un `kyc_records` en `pending` (contournement C2 fermé côté wallet) ; `POST /merchants` utilise l'identité de session ; `req.auth` est maintenant réellement posé sur tous les routeurs (débloque la logique morte des réclamations de solidarité) ; `package.json` de l'api-server réparé (JSON invalide qui empêchait tout build).

**Prérequis opérationnels**
- Définir `ADMIN_API_KEY` (secret fort) dans l'environnement du backend ; sans lui, toutes les routes admin renvoient 403.
- Appliquer le schéma (`pnpm --filter @workspace/db push`) pour créer `webhooks.owner_id`.
- Dashboard admin : la clé est injectée automatiquement sur les appels `/api/*` via `VITE_ADMIN_API_KEY` ou `sessionStorage.kowri_admin_key` (un écran de connexion admin reste à construire en Phase 3 avec le modèle de rôles).
- Les utilisateurs déjà connectés devront se reconnecter (tokens hashés).

**Reste ouvert pour les phases suivantes**
- Pas encore de modèle de rôles en base (la clé admin partagée est une mesure transitoire).
- Rate-limit des logins en mémoire : à déplacer vers un store partagé avant de scaler horizontalement.

## Phase 2 — Intégrité financière (implémentée le 12 septembre 2026)

**Grand livre (`lib/walletService.ts`)**
- Le solde d'un wallet n'additionne plus que les écritures **dans sa propre devise** (`getWalletBalance`, `syncWalletBalance`, `reconcileAllWallets`, et le contrôle de solde interne des transferts).
- `processDeposit` / `processTransfer` / `processWithdrawal` verrouillent le wallet **et** vérifient que la devise demandée est celle du wallet (`CurrencyMismatchError`) ; montant strictement positif obligatoire (`InvalidAmountError`) ; transfert vers soi-même refusé.
- Nouveau `processFxTransfer` (multi-devises, avec frais) : chaque devise est équilibrée séparément — débit expéditeur (montant + frais) → `platform_fees` (frais) + `platform_fx` (montant) en devise source ; `platform_fx` → bénéficiaire (montant converti) en devise cible. Le taux et le montant converti sont conservés dans `transactions.metadata`.
- Helper `isDuplicateIdempotencyKey` pour distinguer « déjà exécuté » d'un vrai échec.

**Diaspora (`lib/diasporaService.ts`, `routes/diaspora.ts`)**
- Le bénéficiaire reçoit désormais le **montant converti dans sa devise** et les **frais du corridor sont réellement prélevés** ; un taux de change absent fait échouer l'envoi (plus de repli 1:1 silencieux) ; bornes min/max du corridor appliquées ; devise du wallet source et du wallet destinataire vérifiées.
- Toutes les routes diaspora sont scopées à la session (bénéficiaires, envois, virements récurrents) ; `/recurring/run` réservé admin ; clé d'idempotence propagée jusqu'au ledger.

**Vecteurs de vol fermés**
- Achat de position tontine : l'acheteur est **toujours** la session ; le vendeur doit encore détenir le slot ; l'acheteur ne peut pas déjà être membre ; wallets choisis dans la devise du listing ; clé `tontine-position:{listingId}`.
- Rupture d'épargne : le plan doit appartenir à la session et le `targetWalletId` aussi (même devise) ; en cas d'échec du transfert le plan revient à `active` au lieu de rester bloqué en `maturing`.
- Adjudication de sinistre : réservée au **manager du pool** (ou admin plateforme) ; `payoutAmount` plafonné au montant réclamé **et** à `claimLimit` ; wallet du réclamant choisi dans la devise du sinistre ; clé `insurance-claim:{claimId}`.
- Pools d'investissement : `distributePoolReturns` ne crée plus de monnaie — il **alloue** les rendements aux positions et exige que le wallet du pool couvre principal + rendements ; réservé au manager ; le double paiement (distribution puis rachat) est supprimé, le rachat reste la seule sortie d'argent (clé `pool-redeem:{positionId}`). `managerId`/`userId`/`buyerId`/`sellerId`/`adjudicatorId` ne sont plus jamais lus depuis le corps de la requête.

**Autorisations tontines (`routes/communityFinance.ts`)**
- Helpers `requireTontineAdmin` / `isTontineMember` : activation, collecte, payout, config hybride, objectifs d'achat (création + libération), cibles/distribution stratégie, évaluation IA et application de l'ordre IA sont réservés à l'**admin de la tontine** ; enchères, votes et réclamations de solidarité aux **membres** ; un utilisateur ne peut inscrire/retirer que lui-même (sauf admin) ; on ne rejoint qu'une tontine `pending` ; `adminUserId` d'une nouvelle tontine = session.
- Réclamations de solidarité : `req.auth` est réel — plus d'attribution `"anonymous"`, et le décaissement auto-approuvé fonctionne enfin.

**Idempotence (`middleware/idempotency.ts`)**
- Index unique `(key, endpoint)` ; la clé est **réservée en base avant** l'exécution du handler (plus de fenêtre TOCTOU, valable multi-instances) ; la réponse 2xx est **capturée automatiquement** (statut + corps) et rejouée à l'identique ; un échec libère la réservation ; expiration 24 h.
- Clés dérivées poussées jusqu'au ledger (`transactions.idempotency_key`, unique) : cotisation tontine par membre et par round (`tontine:{id}:r{n}:m{member}` — un doublon concurrent n'est plus compté comme cotisation manquée), libération d'objectif (`tontine-goal:{id}`, réclamé atomiquement **avant** le transfert, statut restauré en cas d'échec, `transferId` enfin renseigné), rendement d'épargne quotidien (`savings-yield:{plan}:{jour}`), maturité (`savings-mature:{plan}`), décaissement de prêt (`loan-disburse:{loan}`), remboursement (plafonné au restant dû), transfert de float agent (`float:{id}` + **réservation atomique du float** et **reversal automatique** si l'étape comptable échoue au lieu d'un « FAILED » avec l'argent déjà parti).

**Wallets / crédit**
- `GET /wallets` scopé à l'utilisateur (admin peut filtrer par `userId`), `GET /wallets/:id` propriétaire ou admin, `POST /wallets` sur la session, `walletType` validé.
- `POST /wallets/:id/deposit` (cash-in depuis le float plateforme, donc création de monnaie) réservé à la plateforme (`X-Admin-Key`) — aucun client ne l'appelait.
- `POST /wallets/:id/transfer` vérifie la propriété du wallet source ; erreurs de devise renvoyées en 400.
- Crédit : `userId` et propriété du wallet dérivés de la session pour l'emprunt et le remboursement.

**Prérequis opérationnels**
- Appliquer le schéma : nouvel index unique `idem_key_endpoint_uidx` sur `idempotency_keys`.
- Les taux de change doivent être renseignés dans `exchange_rates` pour chaque corridor diaspora, sinon l'envoi est refusé (comportement voulu).

**Reste ouvert**
- Compensation réelle du saga de prêt (reversal du dépôt) → Phase 5.
- Settlements/clearing toujours sans écriture ledger → Phase 5.
- Frais marchand/tontine (`computeFee`) toujours non appliqués → à décider produit.

## Phase 3 — Machines à états câblées (implémentée le 12 septembre 2026)

**Marchands** — `PATCH /admin/merchants/:id/status` (`active` | `suspended` | `pending_approval`, audité, événement `merchant.status.changed`). Un marchand peut enfin devenir `active` : `POST /merchant/payment` ne renvoie plus systématiquement 403.

**KYC** — `routes/compliance.ts` est réservé aux officiers de conformité (`X-Admin-Key`, les dossiers contiennent des pièces d'identité) ; filtre `status` validé contre l'enum. Nouveau `PATCH /compliance/kyc/:recordId` `{ decision: "approve" | "reject", rejectionReason? }` : transition atomique `pending → verified | rejected` ; l'approbation est **le seul chemin** qui élève `users.kycLevel` (jamais abaissé) et fait passer un compte `pending_kyc` à `active` (audits `kyc.reviewed`, `user.status_changed`, événements `kyc.verified` / `kyc.rejected`). Le dashboard admin utilise ce nouvel endpoint (il appelait une route qui n'existait pas).

**Wallets** — `PATCH /admin/wallets/:id/status` (`active` | `frozen` | `closed`, fermeture refusée tant que le solde n'est pas nul, réouverture d'un wallet fermé impossible, audité). Surtout, **le grand livre respecte enfin le statut** : `walletService` verrouille `status` avec la devise et refuse tout débit d'un wallet `frozen` et tout mouvement sur un wallet `closed` (`WalletUnavailableError`) — dépôt, transfert, transfert FX et retrait inclus.

**Tontines** — après chaque payout (classique ou hybride), `scheduleNextRound` recrée le job `tontine_contribution` pour le round suivant (sans doublon si un job est déjà en attente) ; au dernier round la tontine passe en `completed` avec audit et événement `tontine.completed`. **La rotation automatique ne se fige plus après le round 1.** Clés d'idempotence sur les payouts (`tontine-payout:{id}:r{n}`, `tontine-hybrid:{id}:r{n}:rotation|investment|yield:{membre}`), wallets destinataires choisis dans la devise de la tontine, `hybrid` accepté par la route de création.

**Reste ouvert**
- Modèle de rôles en base (la clé admin partagée reste transitoire) et écran de connexion admin dans le dashboard.
- Quitter/annuler une tontine active, résolution des enchères du marché secondaire, contrat d'événements des notifications → Phase 5.

## Phase 4 — Fraude / AML réels (implémentée le 12 septembre 2026)

**Un seul point de contrôle, avant l'argent** — nouveau `lib/riskScreening.ts` (`screenTransaction` / `assertTransactionAllowed`) appelé par `processDeposit`, `processTransfer`, `processFxTransfer` et `processWithdrawal` **avant tout verrou et toute écriture** : une opération bloquée ne touche jamais le grand livre (`TransactionBlockedError` → HTTP 403 `TRANSACTION_BLOCKED`, audit `transaction.blocked`). Le contrôle post-commit en `setImmediate` (qui ne pouvait rien bloquer) est supprimé ; `fraudEngine.ts` et `amlEngine.ts` deviennent de simples façades vers le screening pour l'outillage admin (`POST /aml/check`).

**Couverture** — dépôts et retraits sont désormais screenés (ils ne l'étaient jamais). Les flux internes (cotisations/payouts tontine, épargne, pools, assurance, float agent, décaissement de prêt, rendement) ne sont plus exemptés : `skipFraudCheck` / `internal` signifie « surveillance AML sans règles de vélocité » (celles-ci déclencheraient sur les lots du scheduler), pas « aucun contrôle ».

**Règles et politique de blocage** (seuils en XOF, surchargeables par variables d'environnement `FRAUD_*` / `AML_*`) :
- Fraude (sorties client) : rafale de transactions (alerte ≥ 5 / 30 s, **blocage ≥ 10**), haute valeur (≥ 1 M alerte ; ≥ 5 M **bloqué si KYC < 2**), vidage de wallet (≥ 80 % du solde, alerte).
- AML (tous flux, entrées et sorties) : haute valeur ≥ 10 M → flag + dossier `high_value_reporting` ; **structuration** (≥ 9,5 M avec ≥ 3 opérations sous le seuil en 24 h) → flag + dossier **et blocage** ; vélocité ≥ 30 op./h → flag `transaction_monitoring`.
- **Devise** : tout montant est normalisé en XOF via `exchange_rates` (taux direct ou inverse) — un virement de 50 000 EUR déclenche enfin les seuils ; le multiplicateur hardcodé 609.76 disparaît.

**Dédoublonnage** — pas de nouvelle alerte de risque ni de nouveau flag AML si une occurrence non traitée du même type existe sur le wallet dans les 24 h ; **un seul dossier de conformité ouvert par wallet et par type** (les nouveaux flags s'y rattachent). Les découvertes dédupliquées comptent toujours pour la décision.

**Workflow opérateur** — `routes/risk.ts` et `routes/aml.ts` réservés admin (données clients). Nouveaux `PATCH /risk/alerts/:id/resolve` (audit `risk.alert.resolved`) et `PATCH /aml/flags/:id/review` (audit `aml.flag.reviewed`) ; filtres `?resolved=` / `?reviewed=` / `?status=` ; `stats` exposent les compteurs ouverts ; résolution de dossier idempotente (409 si déjà résolu). `GET /aml/flags` renvoie `flagReason`, `amount`, `currency`, `normalizedXof`, `blocking` à plat — le dashboard AML n'affiche plus des colonnes vides.

**KYC** — le plafond mensuel s'applique aussi aux **retraits**, et le volume mensuel compte transferts, retraits et paiements marchands (statuts `processing`/`completed`).

**Reste ouvert**
- Alimentation automatique du graphe de fraude (`fraud_network_*`) par les transactions réelles et vrais algorithmes de graphe.
- Génération planifiée / transmission des rapports SAR à un régulateur.

## Phase 5 — Tontines complètes + fiabilisation infra (implémentée le 12 septembre 2026)

**Cycle de vie tontine** (`lib/tontineLifecycle.ts`)
- **Quitter une tontine active** : `DELETE /community/tontines/:id/members/:userId` fonctionne désormais aussi sur une tontine `active` — uniquement avant d'avoir reçu son payout (sinon la cagnotte serait lésée). Les cotisations versées sont remboursées depuis le wallet du pool moins une pénalité qui reste au groupe (`TONTINE_LEAVE_PENALTY_PCT`, défaut 10 %) ; refus si le pool ne peut pas honorer le remboursement ; `memberCount`/`totalRounds` ajustés et `payoutOrder` recompacté ; clé `tontine-leave:{tontine}:{membre}` ; audit `tontine.member.left` + notification.
- **Annuler une tontine** : `POST /community/tontines/:id/cancel` (admin de la tontine) — transition atomique `pending|active → cancelled`, jobs scheduler en attente annulés, listings/enchères ouverts fermés, puis remboursement du pool **au prorata de ce que chaque membre est encore en droit de réclamer** (cotisations − payout déjà reçu, donc un membre déjà payé ne reçoit rien) ; clé `tontine-cancel:{tontine}:{membre}` ; audit `tontine.cancelled` + notification par membre.

**Marché secondaire et enchères**
- Colonne `tontine_bids.listing_id` (+ `transaction_id`) : une enchère peut maintenant viser un listing précis. `POST /community/tontines/positions/:listingId/bids` (offre d'un non-membre), `GET …/bids` (le vendeur voit tout, un enchérisseur ne voit que la sienne), `POST …/bids/:bidId/accept` (vendeur) → `buyTontinePosition` au **prix de l'enchère**, enchère marquée `accepted` avec l'id de transaction, les autres `rejected`. `desiredPosition` = `payoutOrder` du listing, donc enfin porteur de sens.
- Enchères de rotation (`POST /tontines/:id/bids`) : refusées après activation ; lors d'une activation en mode `auction`, **chaque enchère gagnante est réellement payée** dans le pool (`tontine-bid:{id}`, audit `tontine.bid.charged`) — une enchère non payée ne classe plus ; tri par montant payé puis ancienneté ; les offres de marché secondaire ne sont plus résolues par erreur à l'activation.

**Notifications** — le contrat d'événements est aligné sur les payloads réels : `tontine.payout.completed` (`recipientUserId`/`payoutAmount`, + devise et nom) et `tontine.contributions.collected` (nouveau `collectedUserIds`, + notification d'échec de prélèvement aux membres `failed`) déclenchent enfin des notifications ; le cycle hybride publie aussi son payout. Nouveaux abonnés : `tontine.completed`, `tontine.cancelled`, `tontine.member.left`, `kyc.verified/rejected`, `merchant.status.changed`, `wallet.status.changed`.

**Résilience**
- **Compensation réelle du saga de prêt** : nouveau `reverseTransaction()` dans `walletService` (écriture miroir d'un dépôt ou d'un transfert, original marqué `reversed`, clé d'idempotence, verrous et contrôle de solde) ; la compensation de `disburse_funds` **rembourse l'argent décaissé** puis supprime le prêt, au lieu de le marquer `defaulted` en laissant les fonds chez l'emprunteur.
- **Kill switches enfin effectifs** : `guard("settlements")` sur création/traitement des règlements et sur soumission/règlement des lots de clearing ; `guard("saga_creation")` à l'entrée de tout saga ; `guard("all")` sur les dépôts (donc sur le décaissement de crédit). Le switch `all` arrête maintenant réellement tout mouvement.

**Schéma** — `drizzle.config.ts` a un dossier `out: ./migrations` ; scripts `generate` / `migrate` ajoutés ; **migration initiale versionnée générée** (`lib/db/migrations`) — le schéma n'est plus déployé uniquement via `push --force`.

**Prérequis opérationnels**
- Appliquer les migrations (`pnpm --filter @workspace/db migrate`) ou `push` : colonnes `tontine_bids.listing_id` et `tontine_bids.transaction_id`.
- Sur une base existante déjà en production, marquer la migration initiale comme appliquée (`__drizzle_migrations`) avant d'utiliser `migrate`, ou continuer avec `push` pour cette base uniquement.

**Reste ouvert (hors périmètre des 5 phases)**
- Modèle de rôles/permissions en base et écran de connexion admin.
- Settlements/clearing toujours sans écritures ledger (le statut « réglé » ne correspond à aucun mouvement comptable) — décision produit/partenaires nécessaire.
- Frais marchand/tontine/diaspora via `feeEngine` (seul le corridor diaspora facture aujourd'hui).
- File de messages sans reprise au redémarrage, outbox désactivée par défaut (`OUTBOX_ENABLED`), multi-région et simulateur de panne restent des maquettes.

## Vérification — exécution réelle des suites (12 septembre 2026)

Toute la branche a été rejouée contre un PostgreSQL 16 local (schéma poussé par Drizzle, données de seed de l'application) avec le serveur démarré en `NODE_ENV=development` et une `ADMIN_API_KEY` de test.

**Résultats finaux (6 suites, 624 vérifications, 0 échec)**

| Suite | Périmètre | Résultat |
|---|---|---|
| `artifacts/api-server/test-integrity.mjs` (nouvelle) | flux d'argent : auth, propriété, devise, idempotence, plafond KYC, screening AML, gel/fermeture, marchand, cycle de vie tontine, marché des positions, épargne | 97 / 97 |
| `test-phase3.mjs` | neobank (ledger, FX, limites, fraude) | 80 / 80 |
| `test-phase4.mjs` | infra hyper-scale (sagas, shards, MQ) | 105 / 105 |
| `test-phase5.mjs` | plateforme globale (multi-région, simulateur, connecteurs) | 116 / 116 |
| `test-phase6.mjs` (racine) | produits wallet / marchand / développeur | 75 / 75 |
| `test-phase7.mjs` | finance communautaire (tontines, pools, assurance, diaspora) | 151 / 151 |

**Harnais** — `test-lib.mjs` centralise login, création d'utilisateurs, montée de KYC (soumission + approbation), dépôt d'amorçage et en-têtes admin. Les suites héritées, écrites avant l'authentification, ont été adaptées au nouveau modèle sans en diluer les assertions : session opérateur (utilisateur seed n°1, wallet XOF, KYC 2), `Idempotency-Key` sur toute écriture, appels « sans auth → 401 » réellement sans en-tête, actions au nom de l'utilisateur concerné (payeur, vendeur, enchérisseur) plutôt que de l'opérateur.

**Ce que les suites ont révélé et qui a été corrigé dans le code**
- **Prélèvement tontine sur le mauvais wallet** : le collecteur prenait le *premier* wallet « personnel » du membre sans regarder la devise ni le solde. Un membre avec deux wallets (ou un wallet XAF en tête) était marqué « cotisation manquée » alors qu'il était solvable. Nouveau `pickDebitWallet()` (`lib/walletSelection.ts`) : wallets actifs dans la devise de la tontine, hors pool, le premier qui couvre le montant (personnel d'abord) ; utilisé pour les cotisations et le paiement des enchères gagnantes.
- **Taux de change absents au démarrage** : `seedExchangeRates()` amorce 24 paires de référence (EUR/USD/GBP ↔ XOF/XAF, GHS, NGN, KES…) sans écraser les taux déjà présents ; auparavant le corridor diaspora et la normalisation XOF du screening échouaient sur une base neuve.
- **Erreurs métier du transfert renvoyées en 500** : `CurrencyMismatchError`, `WalletUnavailableError`, `InvalidAmountError` répondent maintenant 400 avec un `code` exploitable.
- **Marchand inconnu = 403** : les routes produit marchand distinguent désormais 404 (marchand inexistant) et 403 (marchand d'un autre utilisateur).

**Comportements confirmés comme corrects (et non des régressions)** — le plafond mensuel KYC 0 (100 000 XOF) qui bloque un utilisateur trop actif ; la limite horaire de volume qui se déclenche avant la règle AML de structuration (le transfert est refusé dans les deux cas, 429 ou 403) ; la révocation effective d'une session après `logout`.

**Prérequis pour rejouer** — `DATABASE_URL` vers une base vide ou de test, serveur sur le port 8080, `ADMIN_API_KEY=test-admin-key` ; lancer les suites depuis `artifacts/api-server` (sauf `test-phase6.mjs` depuis la racine).

## Dette de sécurité résiduelle — comptes opérateurs et rotation des secrets (12 septembre 2026)

Point 2 du plan de direction : la clé admin partagée (`X-Admin-Key`) était le seul accès au back-office, sans identité, sans révocation individuelle, sans distinction de rôle.

**Modèle de rôles** (`lib/adminAuth.ts`, tables `admin_users` / `admin_sessions`, migration `0001`)
- Comptes nominatifs (email + mot de passe scrypt salé, ≥ 12 caractères avec lettres et chiffres), sessions de 12 h par jeton `kadm_…` haché en base, transmis dans `X-Admin-Token` ou `Authorization: Bearer`.
- Cinq rôles à permissions fixes : `super_admin` (tout), `compliance` (KYC, AML, gel de wallets, statut utilisateur), `operations` (cash-in, wallets, marchands, support), `support` (tickets), `auditor` (lecture seule). Les lectures du back-office restent ouvertes à tous les rôles ; chaque famille d'écriture exige sa permission (`requirePermission` / `gateWrites`), refus `403 PERMISSION_DENIED` avec la permission manquante.
- Permissions appliquées : KYC (`kyc.review`), AML et alertes de risque (`aml.review`), dépôt plateforme / accrual épargne / envois récurrents (`ledger.write`), statut marchand (`merchants.manage`), statut wallet (`wallets.manage`), tickets (`support.manage`), kill switches, sagas, MQ, régions, simulateur, webhooks, frais, sécurité (`system.control`), gestion des comptes (`admins.manage`).
- Routes `/api/admin/auth` : `login` (verrouillage 15 min après 5 échecs), `logout`, `me`, `change-password` (révoque les autres sessions), `sessions` + révocation, `bootstrap` (premier `super_admin`, uniquement table vide + clé legacy), `users` (création avec mot de passe provisoire, changement de rôle/statut, réinitialisation), `roles`, `introspect`. Impossible de rétrograder ou désactiver le dernier `super_admin` actif ; désactivation, changement de rôle et réinitialisation révoquent les sessions. Toutes les actions sont journalisées (`admin.*`).
- `authenticate()` reconnaît une session admin : un opérateur atteint les routes « self ou admin » sans session produit, avec un pseudo-utilisateur qui ne correspond jamais à un propriétaire de wallet.
- **Clé partagée en mode legacy** : toujours acceptée tant que `ADMIN_API_KEY` est définie (équivaut à un `super_admin` anonyme), avec avertissement au démarrage dès qu'un compte existe. La retirer termine la migration.

**Rotation des secrets**
- `docs/SECURITY_SECRETS.md` : inventaire des secrets, modèle d'accès, bootstrap, procédure de rotation par secret (retrait de la clé partagée, `SIGNING_SECRET`, compte opérateur compromis, `DATABASE_URL`, clés développeurs/webhooks) et calendrier.
- `lib/secretsCheck.ts` au démarrage : `SIGNING_SECRET` absent ou court (jusqu'ici une clé aléatoire par processus, donc signatures invalides entre instances), `ADMIN_API_KEY` court ou encore actif après création de comptes, absence totale de credential admin, variables de bootstrap oubliées. En production, une erreur **bloque le démarrage** (`SECRETS_STRICT=false` pour contourner temporairement).
- `artifacts/api-server/.env.example` documente chaque variable ; `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` créent le premier `super_admin` au premier boot.

**Dashboard** — écran de connexion opérateur (`pages/AdminLogin.tsx`) devant tout le back-office (le portail développeur garde son propre modèle), changement de mot de passe provisoire imposé à la première connexion, identité et rôle réels dans l'en-tête, déconnexion effective, jeton attaché automatiquement aux appels `/api` et session purgée si le serveur la révoque. La clé `VITE_ADMIN_API_KEY` reste acceptée comme repli le temps de la migration.

**Vérification** — bloc 11 de `test-integrity.mjs` (27 vérifications : bootstrap, login, permissions par rôle, mot de passe provisoire, dernier super_admin, désactivation, journal d'audit, logout, clé legacy). Suite complète : 651 vérifications, 0 échec.

**Reste ouvert** — MFA sur les comptes opérateurs ; verrouillage anti-force-brute partagé entre instances ; écran de gestion des comptes dans le dashboard (aujourd'hui via l'API).

## Modules maquettes gelés derrière un flag (12 septembre 2026)

Point 3 du plan de direction. Cinq modules démontrent une capacité sans système réel derrière : **règlements partenaires** (statuts sans écriture ledger), **clearing** (netting calculé, rien comptabilisé), **connecteurs de paiement** (réponses simulées), **multi-région** (topologie en mémoire), **simulateur de panne** (injection de fautes dans le processus). Décision : **conserver le code, le garder actif en développement et en test, l'éteindre en production** tant qu'aucun n'est câblé à un système réel.

- `middleware/experimental.ts` : les routeurs `/settlements`, `/clearing`, `/connectors`, `/regions`, `/failure-sim` répondent `503 MODULE_DISABLED` (avec le nom du module et la raison) quand le module est éteint.
- Variable `EXPERIMENTAL_MODULES` : `all`, `none`, ou liste (`settlements,regions`). Non définie : tout est actif hors production, rien en production.
- `GET /api/system/health` expose l'état de chaque module pour que le dashboard et l'exploitation voient ce qui est réel.
- Réactiver un module en production doit s'accompagner d'un câblage réel : écritures ledger pour règlements/clearing, adaptateur fournisseur pour les connecteurs, réplication effective pour les régions ; le simulateur de panne n'a pas vocation à tourner en production.

## Audit v2, chantier A — fermeture des routes ouvertes (13 septembre 2026)

Constats C1, C2, C3, E1 et F5 de `kowri_audit_v2_2026.md`. Des sondes HTTP sans credential avaient prouvé la création d'un agent et la fixation de son solde cash par n'importe qui.

- **Réseau d'agents** (`routes/agents.ts`) : `authenticate()` sur tout le routeur ; `requireAgentAccess` sur chaque route `/:id/…` (l'utilisateur lié à l'agent ou un opérateur, sinon 403 ; 404 si l'agent n'existe pas) ; création d'agent, vue par zones et rebalance réservées à `wallets.manage` ; enregistrement d'anomalie et rafraîchissement du score de confiance réservés à `aml.review` ; la liste `GET /agents` est filtrée sur l'utilisateur courant sauf pour un opérateur. La création exige désormais un `userId` existant (le wallet lié ne peut plus pointer vers un identifiant d'agent, ce qui violait la clé étrangère).
- **FX** (`routes/fx.ts`) : lecture des taux publique (affichée avant connexion), `POST /convert` avec session, `PUT /rates` et `POST /rates/snapshot` avec `system.control`. `/fx/liquidity` : opérateur en lecture, `system.control` en écriture.
- **Routeurs internes montés avec `requireAdmin`** dans `routes/index.ts` : analytics, system, system/report, product/architecture, warroom, et avec `gateWrites` : regulatory et fraud/intel (`aml.review`), payment-routes, archive, settlements, connectors, clearing (`system.control`, en plus du gel `experimental()`).
- `GET /api/debug-build` et `GET /api/admin/auth/roles` réservés aux opérateurs ; `GET /webhooks/events` passé derrière le garde du routeur.
- **Suite de non-régression** `artifacts/api-server/test-gating.mjs` : énumère statiquement toutes les routes montées (335) et les appelle sans credential ; échoue dès qu'une route hors liste publique explicite (inscription, connexions, taux FX, catalogue public des tontines, docs développeur) répond autre chose que 401/403. Résultat : 335 routes, 0 ouverte.
- Bloc 12 de `test-integrity.mjs` (15 vérifications) : création d'agent refusée sans credential et à un simple utilisateur, `userId` obligatoire, cash et liquidité inaccessibles à un autre utilisateur, accessibles à l'utilisateur lié, liste cloisonnée, vue par zones et anomalies réservées aux opérateurs, 404 sur agent inconnu.
- Suites rejouées : 666 vérifications, 0 échec. L'application mobile (écran Agent) envoie déjà le jeton de session et reste fonctionnelle ; le back-office passe par le jeton opérateur.

## Audit v2, chantier B — module crédit (13 septembre 2026)

Constats E2 et E3 de `kowri_audit_v2_2026.md` : lecture croisée entre utilisateurs et remboursement qui n'encaissait rien (wallet « system » inexistant, `transactionId` nul, prêt soldé gratuitement).

- **Trésorerie plateforme** (`lib/treasury.ts`) : utilisateur système `kowri_treasury` (PIN aléatoire inconnu, jamais connectable) et un wallet par devise créé à la demande. Le décaissement d'un prêt est désormais un **transfert réel trésorerie → emprunteur** (plus de dépôt « interne » qui créait de l'argent) ; le remboursement est un **transfert emprunteur → trésorerie** enregistré seulement une fois l'argent parti (`transactionId` toujours renseigné, référence unique par remboursement). Le grand livre reste équilibré et le portefeuille de prêts se rapproche du solde de trésorerie.
- Trésorerie insuffisante dans la devise du prêt → `503 TREASURY_LIQUIDITY`, saga compensée (aucun prêt créé). Hors production, la trésorerie XOF et XAF est amorcée une fois avec 100 000 000 ; en production, l'exploitation l'approvisionne via `POST /wallets/:id/deposit` (`ledger.write`) et la consulte via `GET /admin/treasury` (identifiants de wallets et soldes).
- **Cloisonnement** (`routes/credit.ts`) : liste des scores et des prêts filtrées sur l'utilisateur courant sauf opérateur ; lecture d'un score, recalcul, lecture d'un prêt et de ses remboursements réservés au titulaire ou à un opérateur (403, 404 si le prêt n'existe pas) ; `GET /repayments` ignore tout `userId` étranger. Les erreurs métier passent par le gestionnaire central (fonds insuffisants → `400 INSUFFICIENT_FUNDS`, plus de 400 générique masquant les vraies erreurs).
- Bloc 13 de `test-integrity.mjs` (23 vérifications) : score, cloisonnement, décaissement qui débite la trésorerie et crédite l'emprunteur, remboursement refusé à un tiers, remboursement partiel et final avec transaction, statut `repaid`, trésorerie revenue à son solde initial. `test-phase7` aligné (remboursements d'un prêt inconnu → 404). Suites rejouées : 689 vérifications, 0 échec ; 336 routes sondées sans credential, 0 ouverte.

**Reste ouvert (décision produit)** — les prêts portent un `interestRate` (6 à 12 %) mais l'encours remboursable est le principal seul : aucun intérêt n'est jamais perçu, ni échéancier, ni pénalité de retard, ni passage en `defaulted` à l'échéance. À trancher avant toute mise en production du crédit.

## Audit v2, chantier C — argent et devises (13 septembre 2026)

Constats E4, E5, E6, E7 et M2 de `kowri_audit_v2_2026.md`.

- **Plafonds KYC et vélocité par devise** (`lib/walletService.ts`, `lib/rateLimiter.ts`, `lib/fxEngine.ts`) : les plafonds restent exprimés en XOF, mais chaque montant et chaque volume cumulé (mensuel, horaire, journalier) est converti au taux publié via `toReferenceCurrency` avant comparaison ; les volumes sont sommés par devise puis convertis. Une devise sans taux publié rend la limite non évaluable et l'opération est refusée. Le mois de référence est le mois calendaire UTC. Le dépassement de plafond est désormais une erreur typée `KycLimitError` renvoyée en `400 KYC_LIMIT` (elle sortait en 500). Les wallets acceptent maintenant toutes les devises servies par le moteur FX (XOF, XAF, EUR, USD, GBP, GHS, NGN, KES).
- **Paiement de tontine ajusté à l'encaissé** (`lib/tontineScheduler.ts`) : le bénéficiaire reçoit le minimum entre le pot théorique et ce que le wallet de la tontine détient réellement (solde grand livre moins réserve de rendement et réserve de solidarité) ; une cotisation manquée réduit le versement au lieu de bloquer le round, et le manque à gagner (`shortfall`) est journalisé, publié dans l'événement et renvoyé par la route. La date du round suivant est ancrée sur la date planifiée et non sur l'instant d'exécution (plus de dérive) ; le cycle hybride lit le solde du grand livre plutôt que la colonne dénormalisée.
- **Transfert de float atomique** (`lib/liquidityEngine.ts`) : enregistrement, débit conditionnel (pas de découvert ni de double dépense) et crédit dans une seule transaction ; le mouvement grand livre suit, idempotent sur l'identifiant du transfert ; en cas de refus du grand livre, la compensation des deux floats et le marquage `FAILED` sont eux aussi atomiques. Un enregistrement `PENDING` avec transaction grand livre existante est le signal de reprise.
- **Idempotence des agents** (`routes/agents.ts`) : `POST /agents/:id/liquidity-transfer` passe par le middleware d'idempotence partagé (réservation par utilisateur dans `idempotency_keys`) au lieu d'une recherche texte dans la colonne `note` ; refus du transfert vers soi-même et 404 sur agent cible inconnu.
- **Parts de pool** (`lib/communityFinance.ts`) : les parts sont émises à la valeur courante par part (capital détenu / parts en circulation) et non en proportion de l'objectif ; le rachat verse dans un wallet actif de la devise du pool, rend le principal seul tant que le pool est « open » (et réduit capital et parts du pool), principal plus rendement une fois « matured », et refuse quand le capital est déployé.
- Bloc 14 de `test-integrity.mjs` (17 vérifications) : plafond niveau 0 appliqué à un wallet EUR (200 EUR refusés, 100 EUR acceptés, 100 + 60 EUR refusés), tontine avec un membre sans fonds payée 20 000 sur 30 000 avec `shortfall` 10 000, rejeu d'une clé d'idempotence d'agent, transfert vers soi refusé, float insuffisant sans effet, parts proportionnelles (5 000 et non 50), rachat en pool ouvert. Test 4a durci (400 `KYC_LIMIT`). Suites rejouées : 706 vérifications, 0 échec ; 336 routes sondées, 0 ouverte.

**Reste ouvert** — reprise automatique des transferts de float restés `PENDING` après un arrêt brutal (signal en place, tâche de reprise à écrire).

## Audit v2, chantier D — durcissement serveur (13 septembre 2026)

Constats M3, M4, M6 et M10 de `kowri_audit_v2_2026.md`.

- **CORS en liste blanche** (`middleware/security.ts`) : origines autorisées lues dans `CORS_ORIGINS` ; vide en production = aucune origine croisée (l'API sert elle-même les front-ends, les appels sont de même origine ; les clients sans en-tête `Origin`, appli native et serveur à serveur, passent), vide hors production = tout autorisé pour le développement local. En-têtes exposés et méthodes explicités.
- **En-têtes de sécurité** : `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener/Resource-Policy`, `Cache-Control: no-store` sur `/api`, HSTS en production, `X-Powered-By` supprimé, `trust proxy` activé pour que l'IP réelle alimente le limiteur de connexion. Pas encore de Content-Security-Policy (les bundles front utilisent des styles et scripts en ligne).
- **Corps de requête borné** : `JSON_BODY_LIMIT` (2 Mo par défaut, les documents KYC transitent en base64) ; dépassement → `413 PAYLOAD_TOO_LARGE`, JSON mal formé → `400 MALFORMED_JSON`.
- **Arrêt gracieux** (`index.ts`) : sur `SIGTERM`/`SIGINT`, arrêt des timers, du worker outbox et de l'autopilot, fermeture du serveur (les requêtes en cours terminent), fermeture du pool PostgreSQL, sortie ; délai maximal `SHUTDOWN_TIMEOUT_S` (15 s) avant sortie forcée. Vérifié en local : drain puis « complete ». `uncaughtException` provoque un arrêt propre avec code 1 au lieu d'être avalée ; `unhandledRejection` est consignée comme incident. Auto-ping désactivé par défaut (`SELF_PING=true` pour les hébergeurs qui endorment les processus).
- **Verrou inter-instances** (`lib/instanceLock.ts`) : chaque tâche planifiée (scheduler de tontines, rapprochement quotidien des agents, succès mensuels, rapprochement des wallets) prend un verrou consultatif PostgreSQL le temps de son tick ; avec plusieurs instances, une seule exécute la tâche, les autres passent leur tour. Le verrou est lié à la transaction, donc libéré même si l'instance meurt.
- **TLS PostgreSQL** (`lib/db/src/index.ts`) : activé automatiquement en production pour tout hôte non local, forçable (`DATABASE_SSL=require`) ou désactivable (`disable`), vérification du certificat par défaut (`DATABASE_SSL_REJECT_UNAUTHORIZED=false` pour les chaînes auto-signées), taille du pool réglable (`DATABASE_POOL_MAX`). La revue des secrets au démarrage avertit si `CORS_ORIGINS` est vide ou si TLS est désactivé en production.
- **Gestionnaire d'erreurs** : seuls les messages courts du type « Loan not found » deviennent des 404 ; un message interne contenant ces mots n'est plus maquillé en 404.
- Bloc 15 de `test-integrity.mjs` (6 vérifications) : en-têtes de sécurité, empreinte serveur absente, origine autorisée servie et origine inconnue refusée quand `CORS_ORIGINS` est défini, 413 sur corps de 3 Mo, 400 sur JSON invalide. Test `P4-10d` rendu déterministe (le tirage aléatoire échouait dans 3 % des exécutions). Suites rejouées : 712 vérifications, 0 échec ; 336 routes sondées, 0 ouverte.

**Reste ouvert** — Content-Security-Policy sur les front-ends servis par l'API (nécessite de retirer les styles et scripts en ligne des bundles).

---

*Document généré à partir d'une lecture exhaustive du code source KOWRI V5.0 — 12 septembre 2026.*
*Nombre total de findings : ~130, répartis en 6 audits indépendants.*
