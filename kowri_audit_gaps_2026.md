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

*Document généré à partir d'une lecture exhaustive du code source KOWRI V5.0 — 12 septembre 2026.*
*Nombre total de findings : ~130, répartis en 6 audits indépendants.*
