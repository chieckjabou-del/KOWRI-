# Secrets, accès back-office et rotation

Ce document décrit les secrets dont dépend la plateforme KOWRI, comment les générer, et la procédure de rotation de chacun. Il complète `artifacts/api-server/.env.example`.

## 1. Inventaire des secrets

| Secret | Où | Rôle | Si compromis |
|---|---|---|---|
| `DATABASE_URL` (et `DATABASE_REPLICA_URL`) | env du serveur API | accès PostgreSQL | lecture/écriture totale du ledger |
| `SIGNING_SECRET` | env du serveur API | HMAC des requêtes internes signées (`lib/security.ts`) | forge de requêtes internes |
| `ADMIN_API_KEY` (legacy) | env du serveur API + navigateur des opérateurs | super-admin partagé via `X-Admin-Key` | contrôle complet du back-office, sans traçabilité individuelle |
| Mots de passe des comptes admin | table `admin_users` (scrypt salé) | connexion nominative au back-office | actions au nom de l'opérateur |
| Jetons de session admin | table `admin_sessions` (SHA-256, drapeau `mfa_verified`) | sessions de 12 h | actions au nom de l'opérateur jusqu'à révocation ; sans second facteur la session est en lecture seule quand `ADMIN_MFA_REQUIRED` est actif |
| Secrets TOTP des opérateurs | `admin_users.mfa_secret` (chiffré AES-256-GCM avec `KYC_ENCRYPTION_KEY`) | second facteur des opérateurs | contournement du second facteur pour ce compte ; réinitialiser via `POST /api/admin/auth/users/:id/mfa/reset` |
| Clés API développeurs | table des clés (hashées) | accès API des intégrateurs | actions au nom de l'intégrateur |
| Secrets de webhooks | table des webhooks | signature des callbacks sortants | forge de callbacks vers l'intégrateur |
| Codes PIN des utilisateurs | `users.pin_hash` (scrypt salé, migration auto depuis sha256) | authentification wallet | prise de contrôle du wallet |

Le serveur passe ces secrets en revue au démarrage (`lib/secretsCheck.ts`). En production, un secret manquant ou trop court **bloque le démarrage** (désactivable temporairement avec `SECRETS_STRICT=false`).

## 2. Modèle d'accès back-office

Les opérateurs se connectent avec un compte nominatif (`POST /api/admin/auth/login`, email + mot de passe) et reçoivent un jeton `kadm_…` valable 12 h, transmis dans `X-Admin-Token` (ou `Authorization: Bearer`).

Rôles et permissions (`lib/adminAuth.ts`) :

| Rôle | Permissions |
|---|---|
| `super_admin` | toutes |
| `compliance` | `users.read`, `users.manage`, `kyc.review`, `aml.review`, `wallets.manage` |
| `operations` | `users.read`, `wallets.manage`, `ledger.write`, `merchants.manage`, `support.manage` |
| `support` | `users.read`, `support.manage` |
| `auditor` | `users.read` (lecture seule sur tout le back-office) |

Les lectures du back-office sont ouvertes à tous les rôles ; chaque famille d'écriture exige sa permission (`requirePermission` / `gateWrites`). Un refus renvoie `403` avec `code: PERMISSION_DENIED` et la permission manquante.

Règles intégrées : mot de passe ≥ 12 caractères avec lettres et chiffres ; changement de mot de passe obligatoire après création ou réinitialisation ; toute réinitialisation, désactivation ou changement de rôle révoque les sessions ; impossible de rétrograder ou désactiver le dernier `super_admin` actif ; verrouillage 15 min après 5 échecs de connexion ; toutes les actions sont journalisées (`admin.*` dans `audit_logs`).

## 3. Première mise en service (bootstrap)

Deux possibilités, une seule fois, tant que la table `admin_users` est vide :

1. **Par variables d'environnement** : définir `ADMIN_BOOTSTRAP_EMAIL` et `ADMIN_BOOTSTRAP_PASSWORD` avant le premier démarrage. Le compte `super_admin` est créé au boot avec changement de mot de passe obligatoire. Retirer ensuite les deux variables.
2. **Par l'ancienne clé** : `POST /api/admin/auth/bootstrap` avec `X-Admin-Key: <ADMIN_API_KEY>` et `{ email, name, password }`.

Puis, connecté en `super_admin` : créer les autres comptes (`POST /api/admin/auth/users`) avec le rôle le plus restreint possible.

## 4. Procédures de rotation

### 4.1 Retirer la clé partagée `ADMIN_API_KEY` (à faire une fois)

1. Vérifier que chaque opérateur a un compte (`GET /api/admin/auth/users`).
2. Vérifier que les outils internes (scripts, connecteurs, agents) utilisent un compte `operations` ou `super_admin` avec un jeton de session, ou un compte dédié.
3. Retirer la variable `ADMIN_API_KEY` de l'environnement et redémarrer. Le serveur cesse d'accepter `X-Admin-Key` ; le journal de démarrage ne doit plus afficher l'avertissement « shared legacy key is still active ».
4. Retirer `VITE_ADMIN_API_KEY` de l'environnement de build du dashboard s'il était utilisé.

Tant que la clé reste définie, la rotation se fait en changeant sa valeur (`openssl rand -hex 32`), en redémarrant, puis en la redistribuant : elle vaut alors un `super_admin` sans nom, ce qui est précisément la raison de la retirer.

### 4.2 `SIGNING_SECRET`

Générer : `openssl rand -hex 32`. Rotation : déployer la nouvelle valeur sur toutes les instances en même temps (les signatures ont une validité de 5 minutes ; une rotation décalée entre instances fait échouer les vérifications pendant le décalage). Ne jamais laisser la valeur vide en production : le serveur tirerait une clé aléatoire par processus.

### 4.3 Mot de passe ou jeton d'un opérateur compromis

- Réinitialiser : `POST /api/admin/auth/users/:id/reset-password` (permission `admins.manage`). Toutes les sessions du compte sont révoquées.
- Désactiver immédiatement : `PATCH /api/admin/auth/users/:id` avec `{ "status": "disabled" }`.
- L'opérateur peut lui-même révoquer une session suspecte (`GET/DELETE /api/admin/auth/sessions/:id`) ou changer son mot de passe (`POST /api/admin/auth/change-password`), ce qui ferme ses autres sessions.

### 4.4 `DATABASE_URL`

Créer un nouveau rôle PostgreSQL avec les mêmes droits, déployer la nouvelle URL, vérifier `GET /api/health`, puis supprimer l'ancien rôle. Ne jamais réutiliser le mot de passe de développement (`kowri`/`kowri`) hors poste local.

### 4.5 Clés API développeurs et secrets de webhooks

Se font depuis le portail développeur (révocation puis recréation). Les anciennes valeurs cessent d'être acceptées immédiatement.

## 5. Calendrier recommandé

| Secret | Fréquence | Déclencheur immédiat |
|---|---|---|
| `SIGNING_SECRET` | 6 mois | fuite d'un fichier d'env, départ d'un membre ayant l'accès |
| `DATABASE_URL` | 6 mois | idem |
| Mots de passe admin | 6 mois (forcé par `mustChangePassword`) | suspicion d'accès non autorisé |
| `ADMIN_API_KEY` | — à retirer | présence d'anciens collaborateurs l'ayant connue |
| Clés développeurs | à la demande | demande de l'intégrateur, abus détecté |

## 6. Ce qui n'est pas encore couvert

- Pas de MFA sur les comptes admin (à ajouter avant l'ouverture à des opérateurs externes).
- Le verrouillage anti-force-brute est en mémoire (une instance) ; passer sur un store partagé avant montée en charge horizontale.
- Le stockage des variables d'environnement (coffre, KMS) dépend de l'hébergeur et n'est pas prescrit ici.
