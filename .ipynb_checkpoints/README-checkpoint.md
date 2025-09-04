# Migration automatisée d’un dataset Kaggle vers MongoDB avec Docker

## 1. Contexte du projet

Un client nous a fourni un **dataset médical** sous format CSV provenant de Kaggle.
Leur problème principal : **la scalabilité** de leurs traitements quotidiens.
Nous avons proposé une solution basée sur **MongoDB** et **Docker**, permettant de :

* stocker efficacement les données,
* les importer automatiquement depuis la source Kaggle,
* les rendre accessibles via des utilisateurs avec des rôles spécifiques,
* préparer une future montée en charge (scalabilité horizontale).

Le projet a donc pour but de fournir :

* un conteneur MongoDB configuré avec un schéma et des index,
* un conteneur Python qui télécharge le dataset, l’extrait et l’importe dans MongoDB,
* un système d’authentification sécurisé avec plusieurs rôles.

Ce guide s’adresse à une personne **débutante avec Docker** et MongoDB.
Il détaille étape par étape l’installation, l’exécution et la vérification du bon fonctionnement du pipeline.

---

## 2. Utilisation — exécution locale pour débutant

### 2.1 Prérequis

1. **Installer Docker Desktop** (Windows/Mac) ou **Docker Engine** (Linux).

   * Windows : active **WSL2** et installe Docker Desktop.
   * Vérifie l’installation :

     ```bash
     docker --version
     docker compose version
     ```
2. **Installer Git** pour cloner le projet :

   ```bash
   sudo apt install git
   ```

---

### 2.2 Cloner le projet

```bash
git clone https://github.com/ton-compte/healthcare-mongo-migration.git
cd healthcare-mongo-migration
```

---

### 2.3 Configurer les paramètres

Duplique le fichier d’exemple :

```bash
cp .env.example .env
```

Ouvre `.env` avec un éditeur et remplace les mots de passe `change-me-...` par des valeurs robustes.
Exemple minimal :

```env
MONGO_INITDB_ROOT_USERNAME=admin
MONGO_INITDB_ROOT_PASSWORD=AdminPass123
MONGO_APP_INGESTOR_USER=ingestor
MONGO_APP_INGESTOR_PASSWORD=IngestPass456
MONGO_APP_ANALYST_USER=analyst
MONGO_APP_ANALYST_PASSWORD=AnalystPass789
MONGO_APP_DBADMIN_USER=dbadmin
MONGO_APP_DBADMIN_PASSWORD=DbAdminPass000
```

---

### 2.4 Lancer MongoDB

```bash
docker compose up -d mongo
```

Vérifie l’état du conteneur :

```bash
docker compose ps
```

Il doit être affiché en **healthy**.

---

### 2.5 Lancer la migration automatique

Cette commande :

* télécharge le ZIP Kaggle,
* l’extrait,
* détecte le CSV,
* et importe toutes les données dans MongoDB.

```bash
docker compose build migrate
docker compose run --rm migrate
```

---

### 2.6 Vérifier le résultat

Connexion au shell Mongo :

```bash
docker exec -it mongo mongosh -u admin -p AdminPass123 --authenticationDatabase admin
```

Puis dans le shell Mongo :

```javascript
use medical
db.admissions.countDocuments()
db.admissions.find().limit(5).pretty()
```

---

## 3. Schéma d’architecture

### Vue d’ensemble

```
+-----------------------+                +------------------------------+
|        Utilisateur    |                |         Fichiers projet      |
|  (lance les commandes)|                |  .env, docker-compose.yml,   |
|  docker compose up    |                |  mongo/init/*.js, migrate/*  |
+-----------+-----------+                +---------------+--------------+
            |                                                |
            v                                                v
+-----------------------+                         +----------------------+
|     Docker Compose    |------------------------>|  Réseau interne      |
|  (orchestration)      |                         |  de services         |
+-----+----------+------+                         +----------+-----------+
      |          |                                           |
      |          | depends_on: healthy                       |
      |          v                                           v
+-----+-------------------------+             +-----------------------------+
|       Service mongo           |             |        Service migrate       |
|  image: mongo:7.0             |             |  image: build ./migrate     |
|  volumes:                     |             |  ENTRYPOINT: runner.py      |
|    - ./mongo/init -> /docker- |             |  env: MONGODB_URI,          |
|      entrypoint-initdb.d      |             |       DATASET_URL, ...      |
|    - ./mongo/data -> /data/db |             |  volumes: ./data -> /data   |
|  env: MONGO_INITDB_*          |             +-----------------------------+
|                               |                          |
|  Au 1er démarrage:            |                          |
|   1) crée admin root          |                          |
|   2) exécute 01_create_schema |                          |
|      et 02_users_roles        |                          |
|   3) healthcheck OK           |                          |
+-------------------------------+                          |
                                                           |
                                                           v
                                              +------------------------------+
                                              | runner.py                    |
                                              | 1) Télécharge le ZIP         |
                                              | 2) Extrait vers DATA_DIR     |
                                              | 3) Détecte MIGRATION_FILE    |
                                              | 4) Appelle main.py           |
                                              +---------------+--------------+
                                                              |
                                                              v
                                              +------------------------------+
                                              | main.py (pymongo)            |
                                              | - lit CSV                    |
                                              | - mapping + conversions      |
                                              | - enrichissements            |
                                              | - compute admission_id       |
                                              | - bulk upsert                |
                                              +---------------+--------------+
                                                              |
                                                              v
                                              +------------------------------+
                                              | MongoDB (collection)         |
                                              |  - validations JSON Schema   |
                                              |  - index unique admission_id |
                                              |  - index secondaires         |
                                              +------------------------------+
```

---

## 4. Système d’authentification

Le projet met en place un **système de rôles MongoDB** appliquant le principe du **moindre privilège**.
Chaque utilisateur a des droits limités selon ses besoins.

| Utilisateur | Rôle MongoDB                | Permissions principales                         | Usage                                                        |
| ----------- | --------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `admin`     | Super Administrateur (root) | Tous les droits sur MongoDB                     | Réservé à l’initialisation et maintenance critique           |
| `dbadmin`   | `dbManager`                 | Gestion du schéma, création d’index, validation | Administrer la base sans pouvoir lire les données médicales  |
| `ingestor`  | `dataIngestor`              | Insertion, mise à jour, upsert des admissions   | Utilisé par le conteneur `migrate` pour importer les données |
| `analyst`   | `analystRead`               | Lecture seule, statistiques                     | Analyse et reporting sans altérer les données                |

---

## 5. Exemples de connexions

> ⚠️ Remplace `<mot_de_passe>` par les valeurs définies dans ton fichier `.env`.

### 5.1 Connexion avec **admin** (super utilisateur)

```bash
docker exec -it mongo mongosh \
  -u admin -p AdminPass123 --authenticationDatabase admin
```

**Utilisation typique** :

```javascript
use medical
db.getUsers()
```

---

### 5.2 Connexion avec **dbadmin** (gestion schéma)

```bash
docker exec -it mongo mongosh \
  -u dbadmin -p DbAdminPass000 --authenticationDatabase admin
```

**Utilisation typique** :

```javascript
use medical
db.admissions.getIndexes()
```

---

### 5.3 Connexion avec **ingestor** (importation)

```bash
docker exec -it mongo mongosh \
  -u ingestor -p IngestPass456 --authenticationDatabase admin
```

**Utilisation typique** :

```javascript
use medical
db.admissions.countDocuments()
```

---

### 5.4 Connexion avec **analyst** (lecture seule)

```bash
docker exec -it mongo mongosh \
  -u analyst -p AnalystPass789 --authenticationDatabase admin
```

**Utilisation typique** :

```javascript
use medical
db.admissions.aggregate([{ $sample: { size: 5 } }])
```

---

## 6. Résumé des commandes principales

| Étape                           | Commande                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| Construire l’image de migration | `docker compose build migrate`                                                          |
| Démarrer MongoDB                | `docker compose up -d mongo`                                                            |
| Vérifier l’état des services    | `docker compose ps`                                                                     |
| Lancer la migration complète    | `docker compose run --rm migrate`                                                       |
| Ouvrir un shell Mongo           | `docker exec -it mongo mongosh -u admin -p AdminPass123 --authenticationDatabase admin` |
| Arrêter tous les services       | `docker compose down`                                                                   |

---

Avec ce guide, même une personne débutante peut **installer, lancer et vérifier** le pipeline complet.
Le projet est prêt pour des évolutions futures telles que la réplication MongoDB ou le sharding pour des datasets massifs.
