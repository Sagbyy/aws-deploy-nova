# Partie 3. Déploiement Frontend (Next.js) sur AWS Amplify

## 1. Flux global frontend

1. L'utilisateur ouvre `https://main.dk9lkc5yg76k.amplifyapp.com/`.
2. Le DNS résout le domaine frontend vers Amplify Hosting (distribution CloudFront).
3. Amplify sert le frontend Next.js (pages, assets, rendu SSR si nécessaire).
4. Le frontend appelle l'API backend via `https://co-64d04bd0e3a543c9a00182d31e71a818.ecs.eu-west-1.on.aws`.
5. Le domaine du back end pointe vers l'ALB, puis l'ALB distribue vers ECS/Fargate.

Résumé trafic:
- Frontend: Utilisateur -> CloudFront/Amplify
- API: Frontend (navigateur) -> ALB -> ECS/Fargate

## 2. Prérequis

- Dépôt Git (GitHub/GitLab/Bitbucket) contenant ce frontend.
- Projet AWS avec accès Amplify + gestion DNS.
- Backend déjà exposé publiquement via ALB (HTTPS).
- Certificats TLS valides (gérés par Amplify pour frontend, ACM/ALB pour API).

## 3. Variables d'environnement nécessaires (Amplify)

Configurer dans Amplify Console -> App settings -> Environment variables:

- `NEXT_PUBLIC_API_URL=https://co-64d04bd0e3a543c9a00182d31e71a818.ecs.eu-west-1.on.aws`
  - Base URL de l'API REST appelée par le frontend.
  - Utilisée dans le code: oui (massivement).

- `NEXT_PUBLIC_WS_URL=https://co-64d04bd0e3a543c9a00182d31e71a818.ecs.eu-west-1.on.aws`
  - Endpoint WebSocket pour le chat temps réel.
  - Utilisée dans le code: oui.

- `NEXTAUTH_URL=https://main.dk9lkc5yg76k.amplifyapp.com`
  - URL publique du frontend pour NextAuth (callbacks/cookies/contexte d'hôte).
  - Pas utilisée directement dans le code mais utilisée par NextAuth au runtime.

- `NEXTAUTH_SECRET=<secret_fort>`
  - Secret de signature/chiffrement des sessions JWT NextAuth.
  - Pas utilisée directement dans le code mais utilisée par NextAuth au runtime.

## 4. Étapes de déploiement (Git -> Amplify)

1. Pousser le code sur la branche cible:
   - `main`
2. Dans Amplify:
   - `New app` -> `Host web app`
   - Connecter le provider Git
   - Sélectionner repo + branche.
3. Vérifier l'utilisation du fichier `amplify.yml` du repo.
4. Ajouter les variables d'environnement listées ci-dessus.
5. Lancer le premier déploiement.
6Vérifier après déploiement:
   - login NextAuth
   - appels API vers le back end via load balancer.
6. Configurer CORS côté backend pour autoriser l'origine frontend `https://main.dk9lkc5yg76k.amplifyapp.com/`.

## 5. Pourquoi Amplify et pas S3 statique ?

Amplify est le bon choix ici car ce frontend n'est pas un simple site statique:

- Projet Next.js App Router avec logique serveur (ex: route NextAuth `/api/auth/[...nextauth]`).
- Authentification NextAuth nécessite un runtime serveur pour gérer sessions/cookies/callbacks.
- CI/CD Git intégré (build à chaque push), previews de branches, domaine/SSL simplifiés.
- Support natif du déploiement Next.js moderne sans refactor majeur.

S3 statique conviendrait seulement pour un site 100% exportable (`next export`) sans runtime serveur.
Dans l'état actuel du code, passer en S3 statique demanderait une refonte de l'auth et des routes serveur.
