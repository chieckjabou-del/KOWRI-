# Rail externe (cash-in / cash-out fournisseur) — architecture cible

Ce document décrit **comment** l'argent réel entrera et sortira de la plateforme quand un fournisseur (banque, mobile money, agrégateur) sera branché. Rien de ce qui suit n'est implémenté : aucun faux fournisseur n'a été construit, et c'est volontaire. Aujourd'hui, la seule création d'argent est le cash-in manuel sous maker-checker (`lib/cashIn.ts`) sur la foi d'une preuve externe ; il n'existe **aucune route de cash-out utilisateur** (`processWithdrawal` n'est appelé par aucune route). Ce document sert à ce que le branchement du rail réutilise les contrôles existants au lieu de les contourner.

## 1. Principe

Le fournisseur ne crée jamais d'argent lui-même. Il produit une **preuve** (référence de transaction fournisseur, montant confirmé, devise, horodatage, signature de webhook). Cette preuve devient l'autorité d'un dépôt, exactement comme la référence bancaire d'une demande de cash-in manuelle aujourd'hui : elle est unique, immuable, et la base refuse tout dépôt qui ne la référence pas (`transactions_deposit_authority`).

Concrètement, une nouvelle autorité `provider_settlement` sera ajoutée à `DepositAuthority` et au trigger, pointant vers une table `provider_operations` avec les mêmes garanties que `cash_in_requests` : faits financiers figés, machine à états imposée, ligne jamais supprimée, une seule transaction ledger par opération (clé d'idempotence `provider:<opérationId>`).

## 2. Machine à états d'une opération fournisseur

```
INITIATED ──► PENDING ──► PROVIDER_SUBMITTED ──► PROVIDER_CONFIRMED ──► SETTLED
    │            │               │                      │
    │            │               ├──► PROVIDER_REJECTED  │
    │            │               ├──► PROVIDER_TIMEOUT   ├──► SETTLEMENT_FAILED (écart montant/devise)
    │            └──► CANCELLED  └──► UNKNOWN (à réconcilier)
    └──► CANCELLED
```

| État | Qui y entre | Argent bougé ? | Sortie |
|---|---|---|---|
| `INITIATED` | l'utilisateur (cash-in) ou l'opérateur ; contrôles KYC, plafonds, kill switch, AML **avant** toute écriture | non | `PENDING` ou `CANCELLED` |
| `PENDING` | la plateforme réserve l'opération (ligne créée, clé d'idempotence réservée) | non (cash-in) ; **oui, bloqué** (cash-out : débit du wallet vers `platform_pending_out`, voir §4) | `PROVIDER_SUBMITTED` |
| `PROVIDER_SUBMITTED` | appel sortant au fournisseur, avec notre identifiant comme clé d'idempotence fournisseur | non | confirmé / rejeté / timeout |
| `PROVIDER_CONFIRMED` | webhook entrant **signé** ou polling, référence fournisseur enregistrée | non | `SETTLED` ou `SETTLEMENT_FAILED` |
| `SETTLED` | une transaction ledger unique, dans la même transaction SQL que le passage à `SETTLED` | **oui** | terminal |
| `PROVIDER_REJECTED` / `CANCELLED` | refus fournisseur ou annulation avant soumission | cash-out : le montant bloqué est rendu au wallet (écriture de libération) | terminal |
| `PROVIDER_TIMEOUT` / `UNKNOWN` | pas de réponse dans le délai ; **on ne devine jamais** | non | résolu par la réconciliation fournisseur (§5) |
| `SETTLEMENT_FAILED` | la confirmation ne correspond pas à la demande (montant, devise, bénéficiaire) | non | traitement manuel maker-checker |

Règle absolue : `SETTLED` et l'écriture ledger commitent ensemble ou pas du tout (même mécanisme `attach` que le cash-in manuel). Aucun état intermédiaire ne crédite ou débite « en attendant ».

## 3. Cas de défaillance à couvrir (tous testés avant mise en service)

1. **Webhook reçu deux fois** : la référence fournisseur est unique en base → seconde livraison = `409`, rien n'est réappliqué.
2. **Webhook reçu avant la réponse à l'appel sortant** : l'opération est déjà `PENDING` avec son identifiant ; le webhook la fait avancer, l'appel sortant qui revient ensuite trouve un état plus avancé et ne régresse pas (transitions interdites par trigger).
3. **Webhook pour une opération inconnue** : refusé `404`, journalisé comme incident (tentative de crédit sans demande = attaque ou bug fournisseur).
4. **Webhook non signé / signature invalide / horodatage hors fenêtre** : `401`, jamais traité, journalisé.
5. **Montant ou devise différents de la demande** : `SETTLEMENT_FAILED`, pas d'écriture, revue humaine (le fournisseur a peut-être appliqué des frais : la politique de frais est une décision produit, pas une déduction silencieuse).
6. **Timeout fournisseur** : `PROVIDER_TIMEOUT`, aucune supposition ; le job de réconciliation interroge le fournisseur par notre identifiant et tranche.
7. **Crash de la plateforme entre l'appel sortant et l'enregistrement de la réponse** : au redémarrage, toute opération `PROVIDER_SUBMITTED` depuis plus de X minutes est réinterrogée (même logique que `recoverStuckFloatTransfers`).
8. **Rejeu de notre propre appel sortant** : clé d'idempotence fournisseur = notre identifiant d'opération ; un second appel ne crée pas une seconde opération chez lui.
9. **Fournisseur indisponible** : kill switch `provider_<nom>` ; les demandes restent `INITIATED`/`PENDING` et expirent (délai à décider), l'argent bloqué d'un cash-out est rendu à l'expiration.
10. **Réconciliation quotidienne** : relevé fournisseur ↔ opérations `SETTLED` ; tout écart est une anomalie `I17` du rapport financier (à ajouter), jamais corrigé automatiquement.
11. **Cash-out : débit puis échec fournisseur** : le montant est libéré vers le wallet par une écriture de libération (pas de suppression), et l'opération devient `PROVIDER_REJECTED` ; la réserve `platform_pending_out` est donc toujours égale à la somme des cash-out en cours (invariant I18 à ajouter).
12. **Cash-out : succès fournisseur mais notre écriture échoue** : impossible par construction (même transaction SQL) ; si le fournisseur a payé et que nous n'avons pas la confirmation, c'est le cas 6/7.

## 4. Comptes ledger à ajouter

| Compte | Rôle |
|---|---|
| `platform_pending_out` | argent des utilisateurs déjà débité, en attente de règlement fournisseur (cash-out) ; doit valoir exactement Σ cash-out `PENDING`/`PROVIDER_SUBMITTED` |
| `provider_<nom>_settlement` | contrepartie des règlements confirmés : débité à chaque cash-in `SETTLED`, crédité à chaque cash-out `SETTLED` ; son solde doit correspondre au relevé fournisseur |

Le modèle de conservation (`I13`) reste vrai : ces comptes entrent dans « masse créée − masse détruite ».

## 5. Réconciliation fournisseur

Job quotidien (sous verrou d'instance) : récupérer le relevé fournisseur, l'aligner sur `provider_operations` par référence fournisseur ; trois listes : chez nous mais pas chez eux, chez eux mais pas chez nous, montants différents. Chaque écart devient un incident et une ligne du rapport financier. Aucune correction automatique : une correction est une demande maker-checker (`source = correction`) avec la pièce du fournisseur comme référence.

## 6. Contrôles opérateurs

- Le branchement d'un fournisseur (clés, URL de webhook, activation) exige `system.control` **et** une seconde signature (`ledger.approve`) : c'est la porte d'entrée de l'argent réel.
- Les seuils de cash-in automatique (montant au-delà duquel une confirmation fournisseur ne suffit pas et une revue humaine est requise) sont une décision produit ; en dessous, le webhook signé vaut approbation ; au-dessus, l'opération passe en demande de cash-in maker-checker avec la référence fournisseur comme preuve.
- Les webhooks entrants sont authentifiés par signature HMAC du fournisseur avec rotation de secret documentée dans `docs/SECURITY_SECRETS.md`.

## 7. Ce qu'il faut décider avant de coder

| Décision | Qui | Pourquoi ça bloque |
|---|---|---|
| Fournisseur(s) et devises | direction / finance | détermine le format de preuve et le rapprochement |
| Frais fournisseur : absorbés, refacturés, ou déduits | produit / finance | cas 5 ci-dessus |
| Seuil de revue humaine sur cash-in automatique | conformité | cas 5 et §6 |
| Délai d'expiration d'un cash-out non confirmé | produit | cas 9, argent bloqué |
| Politique de gel pendant une réconciliation en écart | conformité | cas 10 |
