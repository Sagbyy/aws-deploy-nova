# Partie 2 - Deploy Private Presigned Images to S3 (ECS + Lambda)

Cette partie decrit les etapes pour deployer le backend ECS qui upload/read les images privées sur S3 avec les URLs présignées.
Flow image cible (upload -> resize -> read)

1. Le backend ecrit en prive sous `uploads/`, ex: `uploads/post-<uuid>.png`
2. S3 declenche la lambda resizer
3. La lambda ecrit en prive sous `resized/`, ex: `resized/post-<uuid>.jpg`
4. Au GET API:
   - lecture prioritaire `resized/...`
   - fallback `uploads/...` si resized indisponible
5. Le frontend lit toujours `image`/`avatar` avec URL presignee (TTL 15 min)

## 1) Prerequis

- Bucket S3: `cloud-nova-images`
- Repository ECR: `<ACCOUNT.ID>.dkr.ecr.eu-west-1.amazonaws.com/nova/core`
- Service ECS Fargate derriere ALB
- Role IAM ECS Task Role: `ecsTaskRole`
- RDS Postgres: `nova-db`
- Lambda resizer + role d'execution: `nova-image-resizer-role-...`
- AWS CLI + Docker Desktop

## 2) Variables d'environnement

### ECS (Task Definition)

- `DRIVE_DISK=s3`
- `AWS_REGION=eu-west-1`
- `S3_BUCKET=cloud-nova-images`
- `PORT=8080`
- `HOST=0.0.0.0`

Non definies en prod ECS:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_ENDPOINT`

### Lambda resizer

La lambda fournie (`S3Client({})`) utilise le role IAM et n'impose pas de variable obligatoire.

## 3) IAM - recapitulatif permissions

### ECS Task Role (`ecsTaskRole`)

- `s3:ListBucket` sur `cloud-nova-images`
- `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` sur `cloud-nova-images/uploads/*`
- `s3:GetObject` sur `cloud-nova-images/resized/*`

### Lambda execution role (`nova-image-resizer-role-...`)

- `s3:GetObject` sur `cloud-nova-images/uploads/*`
- `s3:PutObject` sur `cloud-nova-images/resized/*`
- CloudWatch Logs (policy AWSLambdaBasicExecutionRole)

### Lambda resource-based policy

- Principal `s3.amazonaws.com`
- Action `lambda:InvokeFunction`
- SourceArn `arn:aws:s3:::cloud-nova-images`
- SourceAccount `<ACCOUNT.ID>`

## 4) Bucket S3

- Bucket: `cloud-nova-images`
- Block Public Access: ON
- Aucune policy publique
- Création d'un dossier "uploads/" et "resized/" dans le bucket S3
- Notification d'evenement vers lambda:
  - Event: `s3:ObjectCreated:Put`
  - Prefix: `uploads/`
  - Target: `nova-image-resizer`

Policy de compartiment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadOriginals",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<ACCOUNT.ID>:role/service-role/nova-image-resizer-role-i6qn8cmd"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::cloud-nova-images/uploads/*"
    },
    {
      "Sid": "WriteResized",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<ACCOUNT.ID>:role/service-role/nova-image-resizer-role-i6qn8cmd"
      },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::cloud-nova-images/resized/*"
    },
    {
      "Sid": "EcsUploadsWriteReadDelete",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<ACCOUNT.ID>:role/ecsTaskRole"
      },
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::cloud-nova-images/uploads/*"
    },
    {
      "Sid": "EcsReadResized",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<ACCOUNT.ID>:role/ecsTaskRole"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::cloud-nova-images/resized/*"
    }
  ]
}
```

### Chiffrement S3

- Chiffrement active
- SSE-S3 (cles gerees par Amazon S3)

### Regle de cycle de vie (purge automatique `uploads/`)

- Une regle de cycle de vie S3 est en place pour supprimer automatiquement les fichiers du dossier `uploads/` apres 1 jour.
- Configuration appliquee:
  - Nom de la regle: `purge-uploads-1j`
  - Portee: prefixe `uploads/`
  - Action: expiration des objets apres 1 jour

Exemple JSON:

```json
{
  "Rules": [
    {
      "ID": "purge-uploads-1j",
      "Prefix": "uploads/",
      "Status": "Enabled",
      "Expiration": {
        "Days": 1
      }
    }
  ]
}
```

## 5) Build et push image ECR

```bash
aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin <ACCOUNT.ID>.dkr.ecr.eu-west-1.amazonaws.com
docker build --pull --no-cache -t nova-core:private-s3 .
docker tag nova-core:private-s3 <ACCOUNT.ID>.dkr.ecr.eu-west-1.amazonaws.com/nova/core:private-s3-v5
docker push <ACCOUNT.ID>.dkr.ecr.eu-west-1.amazonaws.com/nova/core:private-s3-v5
```

## 6) Re déploiement ECS

1. Creer une nouvelle revision de Task Definition
2. Mettre a jour:
   - image `.../nova/core:private-s3-v5`
   - port conteneur `8080/TCP`
   - variables d'environnement
   - `taskRoleArn=ecsTaskRole`
3. Mettre a jour le service ECS
4. Forcer un nouveau deploiement

## 7) Deploiement Lambda resizer

1. Deployer le code lambda
2. Verifier les triggers S3 (`uploads/`, `s3:ObjectCreated:Put`) avec les extensions filtrees:
   - `uploads/` + `.jpeg` -> `nova-image-resizer`
   - `uploads/` + `.jpg` -> `nova-image-resizer`
   - `uploads/` + `.png` -> `nova-image-resizer`
3. Verifier les permissions du role d'execution (lecture `uploads/*`, ecriture `resized/*`)
4. Verifier la permission resource-based `lambda:InvokeFunction` pour S3
5. Verifier que la lambda applique bien un resize en `400x400`

### Alarme CloudWatch sur erreurs Lambda

- Une alarme CloudWatch est configuree sur la metrique `Errors` de la fonction Lambda.
- En cas d'erreur (au moins 1 sur une periode de 5 minutes), une notification email est envoyee via SNS.
- Objectif: etre alerte immediatement en cas de dysfonctionnement de la lambda.

## 8) Verification post-deploiement

1. Upload via endpoint API
2. Verification objet source dans `uploads/`
3. Verification objet transforme dans `resized/`
4. Verification URL presignee (`X-Amz-Signature`, `X-Amz-Expires=900`)
5. Verification acces direct non signe -> `403 AccessDenied`
6. Verification expiration (~15 min) puis refetch API

## 9) Dépannage des erreurs recontrées

- `AccessDenied` upload:
  - verifier policy sur `ecsTaskRole`
  - verifier `S3_BUCKET`, `AWS_REGION`
  - verifier revision ECS active

- `AccessDenied` lambda:
  - verifier role `nova-image-resizer-role-...` (Get uploads / Put resized)
  - verifier policy bucket et trigger S3

- Pas de fichier dans `resized/`:
  - verifier trigger prefix `uploads/`
  - verifier logs CloudWatch `/aws/lambda/nova-image-resizer`

- Meme digest ECR sur plusieurs tags:
  - rebuild avec `--pull --no-cache`
