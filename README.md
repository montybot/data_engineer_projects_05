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

Ce guide s’adresse à une personne qui souhaite utiliser cette base de données.
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
git clone https://github.com/montybot/data_engineer_projects_05.git
cd data_engineer_projects_05
```

---

### 2.3 Configurer les paramètres

Dupliquez le fichier d’exemple :

```bash
cp .env.example .env
```

Ouvrez `.env` avec un éditeur et remplacez les mots de passe `change-me-...` par des valeurs robustes.
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

Pratique mongosh pour éviter d’exposer les mots de passe :

Ne jamais mettre le mot de passe en ligne de commande

```js
mongosh --host mongo.example.com:27017 \
  --username analyst \
  --authenticationDatabase admin \
  --authenticationMechanism SCRAM-SHA-256 \
  --tls \
  --password   # mongosh demandera le mot de passe en saisie masquée
```

Alternatives sûres :

Utiliser l’URI sans mot de passe, et laisser mongosh le demander :

mongosh "mongodb://analyst@mongo.example.com:27017/medical?authSource=admin&authMechanism=SCRAM-SHA-256&tls=true"

Pour automatiser, passez les mots de passe via une variable d’environnement éphémère (attention aux journaux et à l’historique shell) :

```env
MONGO_PWD="$(cat /run/secrets/analyst_pwd)" \
mongosh --username analyst --authenticationDatabase admin --tls --password "$MONGO_PWD"
unset MONGO_PWD
```

Désactiver l’enregistrement de l’historique mongosh si tu manipules des secrets :

```env
// dans mongosh
disableTelemetry()
// et éviter d’exécuter des commandes qui contiennent des secrets en clair
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

> ⚠️ Remplacez `<mot_de_passe>` par les valeurs définies dans ton fichier `.env`.

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

## 7. Outils d'administration et d'analyse (`tools/`)

Le répertoire `tools/` contient des **scripts MongoDB** destinés à la **vérification** et à l'**analyse** de la base de données.
Ces scripts peuvent être exécutés directement dans le conteneur MongoDB pour effectuer des contrôles de qualité et obtenir des indicateurs clés.

### 7.1 Vérification des doublons : `check_duplicates.js`

Ce script vérifie qu'il n'existe pas de doublons dans la collection `admissions` selon deux critères :

1. **Doublons par identifiant fonctionnel** (`admission_id`)

   * Vérifie la présence d'un index unique sur `admission_id`.
   * Détecte les éventuelles clés dupliquées.

2. **Doublons logiques**

   * Basés sur la combinaison :
     `patient.name.full` (en minuscules) + `date_of_admission` (jour) + `hospital` + `room_number`.

#### Exécution

Depuis la racine du projet :

```bash
docker exec -i mongo mongosh \
  -u $MONGO_INITDB_ROOT_USERNAME \
  -p $MONGO_INITDB_ROOT_PASSWORD \
  --authenticationDatabase admin < tools/check_duplicates.js
```

#### Exemple de sortie

```
============================================================
Base: medical | Collection: admissions
============================================================

Documents (estimation rapide): 56000

============================================================
Vérification de l'index unique sur 'admission_id'
============================================================
OK: un index UNIQUE est présent sur { admission_id: 1 }.

============================================================
Recherche de doublons par 'admission_id'
============================================================
Aucun doublon trouvé par 'admission_id'.

============================================================
Recherche de doublons par clé composite
============================================================
Aucun doublon trouvé par clé composite logique.

============================================================
Résumé
============================================================
Documents (countDocuments exact): 56000
Aucun doublon détecté (identifiant et clé composite).

Fin du script.
```

---

### 7.2 Analyses et KPI : `dashboard_analytics.js`

Ce script génère toutes les **analyses statistiques** visibles sur le tableau de bord healthcare, directement depuis MongoDB :

* **KPI globaux** :
  Total du montant de facturation, nombre de patients, hôpitaux, médecins, compagnies d’assurance.
* **Évolution annuelle** du montant de facturation.
* **Répartition des patients** :

  * Par tranche d’âge (`13-17`, `18-35`, `36-55`, `56-65`, `66+`),
  * Par genre,
  * Par condition médicale,
  * Par type d’admission.
* **Montants par fournisseur d’assurance** avec pourcentages.

Le script prend également en charge des **filtres optionnels** (année, mois, pathologie, genre, etc.), configurables directement au début du fichier.

#### Configuration des filtres

Dans `dashboard_analytics.js`, section `FILTERS` :

```javascript
const FILTERS = {
  year: 2023,                 // Filtrer sur une année précise, ex: 2023
  month: null,                // Filtrer sur un mois précis (1-12)
  medical_condition: "Diabetes",
  insurance_provider: null,
  test_results: null,
  blood_type: null,
  gender: null
};
```

Mettre une valeur à `null` désactive le filtre.

#### Exécution

```bash
docker exec -i mongo mongosh \
  -u $MONGO_INITDB_ROOT_USERNAME \
  -p $MONGO_INITDB_ROOT_PASSWORD \
  --authenticationDatabase admin < tools/dashboard_analytics.js
```

#### Exemple de sortie (extrait)

```
============================================================
KPI globaux (avec filtres appliqués)
============================================================
{
  total_billing_amount: 1420000000,
  total_hospital: 40000,
  total_patient: 56000,
  total_doctors: 40000,
  total_insurance_company: 5
}

============================================================
Total Billing Amount by Year
============================================================
2019: 190000000
2020: 287000000
2021: 280000000
2022: 281000000
2023: 282000000
2024: 98000000

============================================================
Total patient by Age Group
============================================================
[
  { age_group: '13-17', total_patient: 2000 },
  { age_group: '18-35', total_patient: 13000 },
  { age_group: '36-55', total_patient: 16000 },
  { age_group: '56-65', total_patient: 8000 },
  { age_group: '66+', total_patient: 16000 }
]
```

---

### 7.3 Bonnes pratiques

| Action                                                     | Outil recommandé         | Quand l'utiliser                                 |
| ---------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| Vérifier l'absence de doublons avant une analyse ou export | `check_duplicates.js`    | Après une nouvelle migration ou un import massif |
| Générer des indicateurs pour un dashboard ou un reporting  | `dashboard_analytics.js` | À chaque mise à jour du dataset                  |

---

Ces scripts permettent de **contrôler la qualité des données** et de **générer des analyses directement depuis MongoDB**, sans avoir à recourir à un outil externe ou à réécrire les requêtes complexes.

